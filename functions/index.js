// Daily job: for every device with an active "dynamic layer" (a Countdown,
// Team schedule, News, Tide, or Tide Timeline layer, published from
// /design/), redraw today's content onto its saved base design and
// overwrite designs/{id}.bin + .png -- the same two files the device
// already reads unconditionally, so no firmware change is needed for
// this to show up. "beachBuddy" is the one exception: it refreshes on
// its own separate HOURLY schedule instead (regenerateBeachBuddyDesigns,
// further down) so its headline stays current through the day, while
// reusing one shared, cached illustration per pose+sunny scenario
// across every device -- see getOrGenerateBeachBuddyArt's own comment.
//
// Also exports espnProxy, an HTTP function design's Team tool calls
// from the browser to get a live schedule preview before publishing --
// see the comment above it for why that can't just call ESPN directly.
"use strict";

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const { renderDynamicDesign, espnTeamsUrl, espnScheduleUrl, espnTeamUrl, fetchHeadlines, isSafeFetchUrl, MAX_NEWS_HEADLINES, OUTBOUND_FETCH_HEADERS } = require("./lib/dynamic");
const { fetchTideCardData, fetchTideTimelineData } = require("./lib/astro");
const { isTeamsnapIcsUrl, fetchIcsSchedule } = require("./lib/teamsnap");
const { generateBeachBuddyArt, IMAGEN_SCENE_HINTS, PROMPT_VERSION, cacheKeyForMood } = require("./lib/imagen");
const { fetchBeachFlagCardData } = require("./lib/beachflag");
const { fetchMusicEventsCardData } = require("./lib/liveMusic");
const { runOcnjEventsPipeline } = require("./lib/ocnjPipeline");
const { fetchOcnjEventsCardData } = require("./lib/ocnjCard");

admin.initializeApp({ storageBucket: "waveclock.firebasestorage.app" });

// The OCNJ Events pipeline's only secret -- granted to
// generateOcnjEventsJson below via its `secrets:` option, never
// hardcoded. Set with:
//   firebase functions:secrets:set ANTHROPIC_API_KEY
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

const DESIGNS_PREFIX = "designs/";
const DYNAMIC_SUFFIX = "-dynamic.json";

function deviceIdFromDynamicPath(name) {
  if (!name.startsWith(DESIGNS_PREFIX) || !name.endsWith(DYNAMIC_SUFFIX)) return null;
  return name.slice(DESIGNS_PREFIX.length, -DYNAMIC_SUFFIX.length);
}

// Best-effort delete -- a file that's already gone (e.g. this ran twice,
// or the customer's next publish already cleaned up) isn't an error here.
async function deleteIfExists(file) {
  try {
    await file.delete();
  } catch (err) {
    if (err && err.code === 404) return;
    throw err;
  }
}

// fetchImpl is only ever passed by tests (to stub ESPN calls) -- real
// scheduled runs omit it, so renderDynamicDesign falls back to the
// platform's real global fetch.
//
// `options.typeFilter(meta.type)`, when given and false, skips this
// device entirely (before even downloading its base.png) -- used to
// split Beach Buddy off onto its own hourly schedule (see
// regenerateBeachBuddyDesigns below) while this same function keeps
// handling every other type. `options.beachBuddyArtImpl` is threaded
// straight through to renderDynamicDesign's own `beachBuddyArtImpl`
// param -- see getOrGenerateBeachBuddyArt below for what the real
// (non-test) caller passes.
async function processDevice(bucket, deviceId, now, fetchImpl, options) {
  const { typeFilter, beachBuddyArtImpl } = options || {};
  const dynamicFile = bucket.file(DESIGNS_PREFIX + deviceId + DYNAMIC_SUFFIX);
  const baseFile = bucket.file(DESIGNS_PREFIX + deviceId + "-base.png");

  const [metaBuffer] = await dynamicFile.download();
  const meta = JSON.parse(metaBuffer.toString("utf8"));

  if (typeFilter && !typeFilter(meta.type)) return "skipped";

  const [baseBuffer] = await baseFile.download();
  // Throws on a genuine failure (e.g. ESPN unreachable for a "team" layer)
  // -- that propagates up to the caller's try/catch below, which leaves
  // this device untouched and retries on the next scheduled run. Only a
  // concluded countdown returns null here; a team's schedule never does
  // (see renderDynamicDesign's contract in lib/dynamic.js).
  const result = await renderDynamicDesign(baseBuffer, meta, now, fetchImpl, beachBuddyArtImpl);

  if (!result) {
    logger.info("Countdown passed for " + deviceId + ", cleaning up and leaving the board as-is.");
    await deleteIfExists(dynamicFile);
    await deleteIfExists(baseFile);
    return "expired";
  }

  await bucket.file(DESIGNS_PREFIX + deviceId + ".bin").save(result.binBuffer, {
    contentType: "application/octet-stream"
  });
  await bucket.file(DESIGNS_PREFIX + deviceId + ".png").save(result.pngBuffer, {
    contentType: "image/png"
  });
  logger.info("Updated " + deviceId + " (" + meta.type + "): \"" + result.content + "\"");
  return "updated";
}

// "beachBuddy", "beachFlag", "liveMusic" and "liveMusicMore" are all
// explicitly excluded here -- each refreshes on its own separate
// schedule instead (see regenerateBeachBuddyDesigns,
// regenerateBeachFlagDesigns, and regenerateLiveMusicDesigns below),
// since all of them need to stay current through the day in a way a
// once-daily run can't give them, while beachBuddy's ART specifically
// doesn't need to change that often at all (see
// getOrGenerateBeachBuddyArt's own comment). liveMusicMore is just page
// 1 of the same Live Music card (see fetchMusicEventsCardData's own
// comment), so it rides the same regenerateLiveMusicDesigns schedule as
// liveMusic rather than getting a schedule of its own. "ocnjEvents" is
// deliberately NOT excluded here -- its underlying data
// (data/ocnj-events.json) only refreshes once a day itself
// (generateOcnjEventsJson, 08:00 UTC, an hour before this job runs), so
// there's no reason for the card to redraw any more often than this
// daily pass already does.
const DAILY_REGEN_TYPES = (type) => type !== "beachBuddy" && type !== "beachFlag" && type !== "liveMusic" && type !== "liveMusicMore";

exports.regenerateCountdownDesigns = onSchedule(
  { schedule: "0 9 * * *", timeZone: "Etc/UTC", retryCount: 1 },
  async () => {
    const bucket = admin.storage().bucket();
    const [files] = await bucket.getFiles({ prefix: DESIGNS_PREFIX });
    const deviceIds = files
      .map((f) => deviceIdFromDynamicPath(f.name))
      .filter(Boolean);

    logger.info("Found " + deviceIds.length + " device(s) with an active dynamic layer.");

    const now = new Date();
    let updated = 0, expired = 0, skipped = 0, failed = 0;
    for (const deviceId of deviceIds) {
      try {
        const outcome = await processDevice(bucket, deviceId, now, undefined, { typeFilter: DAILY_REGEN_TYPES });
        if (outcome === "updated") updated++;
        else if (outcome === "expired") expired++;
        else if (outcome === "skipped") skipped++;
      } catch (err) {
        failed++;
        // One device's bad/missing base.png (or a transient ESPN outage
        // for a team layer) shouldn't stop the rest of the fleet from
        // getting their update -- and shouldn't be treated as "give up on
        // this device," just "try again tomorrow."
        logger.error("Failed to regenerate dynamic layer for " + deviceId + ":", err);
      }
    }
    logger.info("Done. updated=" + updated + " expired=" + expired + " skipped(beachBuddy/beachFlag/liveMusic)=" + skipped + " failed=" + failed);
  }
);

// Looks up (or, the very first time a given pose+sunny scenario is ever
// needed, generates and saves) ONE shared illustration -- NOT one per
// device, one per day, or one per town. Every device/town/day that
// lands on the same mood (see cacheKeyForMood in lib/imagen.js) reuses
// the exact same cached PNG; only the headline text drawn on top of it
// (by drawBeachBuddyArtCard in dynamic.js) is ever specific to a given
// device's real tide/weather data. This is what lets
// regenerateBeachBuddyDesigns below refresh every device's headline
// hourly without calling Imagen on every single one of those runs --
// Imagen gets called, at most, once per pose+sunny combination, ever
// (until PROMPT_VERSION bumps and starts a fresh set of paths).
//
// Stored at "beachBuddyArt/v<PROMPT_VERSION>/<cacheKey>.png", separate
// from any device's own designs/ files -- this is shared, not
// per-device. A cache miss is detected the same way deleteIfExists
// above detects an already-gone file: `download()` on a File that
// doesn't exist rejects with `err.code === 404` (the real
// @google-cloud/storage behavior; the fake bucket used in
// orchestration.test.js mirrors it) -- any OTHER error propagates
// rather than being treated as "not cached yet."
async function getOrGenerateBeachBuddyArt(mood, { bucket, project, location, generateImpl } = {}) {
  const path = "beachBuddyArt/v" + PROMPT_VERSION + "/" + cacheKeyForMood(mood) + ".png";
  const file = bucket.file(path);
  try {
    const [cached] = await file.download();
    return cached;
  } catch (err) {
    if (!err || err.code !== 404) throw err;
  }
  const fresh = await generateBeachBuddyArt(mood, { project, location, generateImpl });
  await file.save(fresh, { contentType: "image/png" });
  logger.info("Cached a new Beach Buddy illustration at " + path);
  return fresh;
}

exports.regenerateBeachBuddyDesigns = onSchedule(
  { schedule: "0 * * * *", timeZone: "Etc/UTC", retryCount: 1 },
  async () => {
    const bucket = admin.storage().bucket();
    const [files] = await bucket.getFiles({ prefix: DESIGNS_PREFIX });
    const deviceIds = files
      .map((f) => deviceIdFromDynamicPath(f.name))
      .filter(Boolean);

    const now = new Date();
    const beachBuddyArtImpl = (mood) => getOrGenerateBeachBuddyArt(mood, {
      bucket,
      project: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT,
      location: "us-central1"
    });

    let updated = 0, skipped = 0, failed = 0;
    for (const deviceId of deviceIds) {
      try {
        const outcome = await processDevice(bucket, deviceId, now, undefined, {
          typeFilter: (type) => type === "beachBuddy",
          beachBuddyArtImpl
        });
        if (outcome === "updated") updated++;
        else if (outcome === "skipped") skipped++;
      } catch (err) {
        failed++;
        logger.error("Failed to refresh Beach Buddy layer for " + deviceId + ":", err);
      }
    }
    logger.info("Beach Buddy hourly refresh done. updated=" + updated + " skipped(not beachBuddy)=" + skipped + " failed=" + failed);
  }
);

// Every 3 hours rather than hourly like Beach Buddy: the flag color
// itself only actually changes a couple of times a day (morning/
// afternoon, per 30a.com's own "Last Refreshed"/"Last Changed"
// timestamps), so an hourly poll would mostly refetch the same value --
// still cheap either way (a lightweight text fetch, no Imagen-style
// per-generation cost), but there's no real freshness gained by polling
// faster than conditions actually change.
exports.regenerateBeachFlagDesigns = onSchedule(
  { schedule: "0 */3 * * *", timeZone: "Etc/UTC", retryCount: 1 },
  async () => {
    const bucket = admin.storage().bucket();
    const [files] = await bucket.getFiles({ prefix: DESIGNS_PREFIX });
    const deviceIds = files
      .map((f) => deviceIdFromDynamicPath(f.name))
      .filter(Boolean);

    const now = new Date();
    let updated = 0, skipped = 0, failed = 0;
    for (const deviceId of deviceIds) {
      try {
        const outcome = await processDevice(bucket, deviceId, now, undefined, {
          typeFilter: (type) => type === "beachFlag"
        });
        if (outcome === "updated") updated++;
        else if (outcome === "skipped") skipped++;
      } catch (err) {
        failed++;
        logger.error("Failed to refresh Beach Flag layer for " + deviceId + ":", err);
      }
    }
    logger.info("Beach Flag refresh done. updated=" + updated + " skipped(not beachFlag)=" + skipped + " failed=" + failed);
  }
);

// Hourly, like Beach Buddy -- unlike the flag color (which only changes a
// couple of times a day), shows start and end at specific clock times a
// customer actually cares about "right now," and /v1/device's own
// from_now filtering means a later run naturally drops shows that have
// already started. Cheap either way: one JSON fetch against the
// customer-provided Beach API, no Imagen-style per-generation cost.
exports.regenerateLiveMusicDesigns = onSchedule(
  { schedule: "0 * * * *", timeZone: "Etc/UTC", retryCount: 1 },
  async () => {
    const bucket = admin.storage().bucket();
    const [files] = await bucket.getFiles({ prefix: DESIGNS_PREFIX });
    const deviceIds = files
      .map((f) => deviceIdFromDynamicPath(f.name))
      .filter(Boolean);

    const now = new Date();
    let updated = 0, skipped = 0, failed = 0;
    for (const deviceId of deviceIds) {
      try {
        const outcome = await processDevice(bucket, deviceId, now, undefined, {
          typeFilter: (type) => type === "liveMusic" || type === "liveMusicMore"
        });
        if (outcome === "updated") updated++;
        else if (outcome === "skipped") skipped++;
      } catch (err) {
        failed++;
        logger.error("Failed to refresh Live Music layer for " + deviceId + ":", err);
      }
    }
    logger.info("Live Music refresh done. updated=" + updated + " skipped(not liveMusic)=" + skipped + " failed=" + failed);
  }
);

// ================= OCNJ Events pipeline =================
// Publishes data/ocnj-events.json to Storage once a day, early morning
// Eastern (before anyone's clock would want fresh event data -- same
// reasoning as the firmware's own daily 3 AM OTA window, just server-side
// instead of on-device). Not tied to any one device's dynamic layer --
// this is a single shared file, not a per-device render like the
// scheduled functions above.
//
// See lib/ocnjPipeline.js for the full fetch -> merge -> curate ->
// publish flow (ported from the customer's parse_calendar.py /
// source_oceancityvacation.py / merge_sources.py / curate_with_llm.py /
// run_pipeline.py handoff, 2 Sep 2026) and its own comment for why the
// output lands in Storage instead of on local disk.
exports.generateOcnjEventsJson = onSchedule(
  { schedule: "0 8 * * *", timeZone: "Etc/UTC", retryCount: 1, timeoutSeconds: 300, memory: "512MiB", secrets: [ANTHROPIC_API_KEY] },
  async () => {
    const bucket = admin.storage().bucket();
    const result = await runOcnjEventsPipeline({ bucket, apiKey: ANTHROPIC_API_KEY.value() });
    if (result.status === "error") {
      throw new Error("ocnj-events pipeline failed with no fallback available: " + result.reason);
    }
  }
);

// ================= ESPN proxy =================
// design's Team tool needs a live schedule fetch to show an accurate
// preview BEFORE the customer publishes, from the customer's own browser.
// Calling ESPN's site.api.espn.com directly from there fails: the browser
// blocks the response as a cross-origin request ESPN doesn't grant CORS
// permission for (confirmed live -- the same URL loads fine when opened
// directly in a browser tab, i.e. NOT as a fetch(), which isn't subject
// to CORS at all -- only script-initiated cross-origin requests are).
// This proxy exists purely to sidestep that: it makes the SAME request
// server-to-server (never subject to CORS), and returns the result with
// permissive CORS headers of its own so the browser will accept it.
//
// The daily regeneration job above does NOT go through this -- it already
// calls ESPN directly from lib/dynamic.js's fetchNextGame, and a
// server-to-server call was never subject to CORS in the first place.
//
// Only forwards to a small whitelist of known sport/league pairs (the
// same ones design's League dropdown offers) rather than proxying any
// URL a caller asks for, so this can't be used as an open relay to
// arbitrary sites.
const ALLOWED_LEAGUES = new Set([
  "football/nfl",
  "football/college-football",
  "basketball/nba",
  "basketball/womens-college-basketball",
  "baseball/mlb",
  "hockey/nhl"
]);

// ESPN's team logo CDN -- a fixed, known-ours-not-attacker-controlled
// hostname, unlike News's feedUrl below, so a simple domain allowlist is
// enough here (no need for the private-IP/SSRF guard that protects the
// News proxy, since this can never be pointed anywhere but ESPN's own
// CDN).
function isEspnCdnUrl(urlString) {
  let u;
  try {
    u = new URL(urlString);
  } catch (err) {
    return false;
  }
  if (u.protocol !== "https:") return false;
  return u.hostname.toLowerCase().endsWith(".espncdn.com");
}

// Plain (req, res) handler, kept separate from the onRequest() wrapper
// below so it can be unit-tested with fake req/res objects without
// spinning up the Functions Framework.
async function espnProxyHandler(req, res) {
  const kind = req.query.kind;

  // "logo" is unlike "teams"/"schedule" below -- it forwards a specific
  // image URL (already returned to the browser by a prior "teams" or
  // "schedule" call) rather than building one from sport/league, so it
  // skips that validation and does its own (the CDN-domain check above)
  // instead. design's Team tool uses this to draw the real Game Day
  // card -- including dithered logos -- directly in the live preview,
  // which needs CORS-clean pixel access to the logo image the same way
  // "teams"/"schedule" need CORS-clean JSON access.
  if (kind === "logo") {
    const url = req.query.url;
    if (typeof url !== "string" || !isEspnCdnUrl(url)) {
      res.status(400).json({ error: "url must be an https://*.espncdn.com image" });
      return;
    }
    try {
      const imgResp = await fetch(url, { headers: OUTBOUND_FETCH_HEADERS });
      if (!imgResp.ok) {
        res.status(imgResp.status).json({ error: "ESPN CDN returned " + imgResp.status });
        return;
      }
      const buf = Buffer.from(await imgResp.arrayBuffer());
      res.set("Content-Type", imgResp.headers.get("content-type") || "image/png");
      res.status(200).send(buf);
    } catch (err) {
      logger.error("ESPN logo proxy request failed for " + url + ":", err);
      res.status(502).json({ error: "Couldn't reach ESPN's logo CDN" });
    }
    return;
  }

  const sport = req.query.sport;
  const league = req.query.league;

  if (typeof sport !== "string" || typeof league !== "string" || !ALLOWED_LEAGUES.has(sport + "/" + league)) {
    res.status(400).json({ error: "Unsupported or missing sport/league" });
    return;
  }

  let url;
  if (kind === "teams") {
    url = espnTeamsUrl(sport, league);
  } else if (kind === "schedule") {
    const teamId = req.query.teamId;
    if (typeof teamId !== "string" || !teamId) {
      res.status(400).json({ error: "Missing teamId" });
      return;
    }
    url = espnScheduleUrl(sport, league, teamId);
  } else if (kind === "record") {
    const teamId = req.query.teamId;
    if (typeof teamId !== "string" || !teamId) {
      res.status(400).json({ error: "Missing teamId" });
      return;
    }
    url = espnTeamUrl(sport, league, teamId);
  } else {
    res.status(400).json({ error: "kind must be \"teams\", \"schedule\", \"record\", or \"logo\"" });
    return;
  }

  try {
    // Deliberately NOT sending OUTBOUND_FETCH_HEADERS here -- this
    // endpoint is currently working live without it (see the README
    // timeline), so leaving it alone rather than risking a
    // currently-working path while fixing the still-broken RSS fetch.
    const espnResp = await fetch(url);
    const data = await espnResp.json();
    res.status(espnResp.status).json(data);
  } catch (err) {
    logger.error("ESPN proxy request failed for " + url + ":", err);
    res.status(502).json({ error: "Couldn't reach ESPN" });
  }
}

exports.espnProxy = onRequest({ cors: true, region: "us-central1" }, espnProxyHandler);

// ================= News proxy =================
// design's News tool needs a live headline fetch to show an accurate
// preview before publishing, same reasoning as espnProxy above -- an
// arbitrary RSS feed almost never sends CORS headers a browser fetch()
// needs. Unlike espnProxy there's no fixed API to whitelist by hostname
// (the customer can point this at literally any feed), so the safety
// boundary here is isSafeFetchUrl (see lib/dynamic.js): blocks anything
// that isn't plain http/https, and blocks private/link-local IP literals
// -- most importantly 169.254.169.254, which on Google Cloud is the
// instance metadata endpoint and could otherwise leak this function's own
// service-account credentials to whoever controls the feedUrl. This does
// NOT protect against DNS rebinding (a hostname that resolves to a
// private IP only at fetch time, after this check already passed) --
// that would need resolving DNS ourselves and pinning the checked IP for
// the actual request, which this doesn't do yet.
//
// Returns already-parsed headlines (not raw feed XML) so the browser
// never needs its own RSS parser -- this reuses the exact same
// fetchHeadlines/parseRssHeadlines the daily regeneration job calls
// directly, so the preview and the real card can never disagree about
// what a feed's headlines are.
async function newsProxyHandler(req, res) {
  const location = typeof req.query.location === "string" ? req.query.location : "";
  const feedUrl = typeof req.query.feedUrl === "string" ? req.query.feedUrl : "";

  if (!location.trim() && !feedUrl.trim()) {
    res.status(400).json({ error: "Provide a location or a feedUrl" });
    return;
  }
  if (feedUrl.trim() && !isSafeFetchUrl(feedUrl.trim())) {
    res.status(400).json({ error: "That feed URL isn't allowed" });
    return;
  }

  try {
    const headlines = await fetchHeadlines({ location, feedUrl }, MAX_NEWS_HEADLINES);
    res.status(200).json({ headlines });
  } catch (err) {
    logger.error("News proxy request failed for location=" + location + " feedUrl=" + feedUrl + ":", err);
    res.status(502).json({ error: "Couldn't reach that feed" });
  }
}

exports.newsProxy = onRequest({ cors: true, region: "us-central1" }, newsProxyHandler);

// Unlike espnProxy/newsProxy above (thin passthroughs of raw upstream
// JSON -- the "what does this data mean" logic is duplicated client-side
// in design for those), this one does the FULL computation
// server-side and returns a ready-to-draw payload. Twilight bounds, moon
// phase naming, and NOAA's timezone handling are exactly the kind of
// thing that quietly drifts out of sync if reimplemented a second time in
// browser JS -- see the header comment in lib/astro.js.
async function astroProxyHandler(req, res) {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const stationId = typeof req.query.stationId === "string" ? req.query.stationId : "";

  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    res.status(400).json({ error: "lat/lon must be valid coordinates" });
    return;
  }
  if (!/^[0-9]{5,9}$/.test(stationId)) {
    res.status(400).json({ error: "stationId must be a NOAA station number" });
    return;
  }

  try {
    const data = await fetchTideCardData({ lat, lon, stationId });
    res.status(200).json(data);
  } catch (err) {
    logger.error("astro proxy request failed for lat=" + lat + " lon=" + lon + " stationId=" + stationId + ":", err);
    // err.noaaDataError (see fetchNoaaPredictions) means NOAA was reached
    // fine and gave a clear "no data" answer for this specific station --
    // not a connectivity problem, so it gets its own status/message rather
    // than the generic "couldn't reach NOAA" one, which would wrongly
    // suggest retrying later will help (some stations only have time-offset
    // predictions, never a height curve, so it won't).
    if (err.noaaDataError) {
      res.status(422).json({ error: "This tide station doesn't have full predictions available (NOAA: " + err.message + "). Try picking a different station in Fishing Spot settings." });
      return;
    }
    res.status(502).json({ error: "Couldn't reach NOAA/sun-moon data right now" });
  }
}

exports.astroProxy = onRequest({ cors: true, region: "us-central1" }, astroProxyHandler);

// Same shape and reasoning as astroProxyHandler above, for the Sun/Moon/
// Tide Timeline card's live preview instead -- a distinct endpoint
// rather than a third `type` query param on astroProxy, since the two
// cards need genuinely different payloads (fetchTideTimelineData skips
// the continuous curve, weather, and fishing score entirely, and adds
// moonEvents/dayStart/dayEnd that fetchTideCardData doesn't have).
async function astroTimelineProxyHandler(req, res) {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const stationId = typeof req.query.stationId === "string" ? req.query.stationId : "";

  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    res.status(400).json({ error: "lat/lon must be valid coordinates" });
    return;
  }
  if (!/^[0-9]{5,9}$/.test(stationId)) {
    res.status(400).json({ error: "stationId must be a NOAA station number" });
    return;
  }

  try {
    const data = await fetchTideTimelineData({ lat, lon, stationId });
    res.status(200).json(data);
  } catch (err) {
    logger.error("astro timeline proxy request failed for lat=" + lat + " lon=" + lon + " stationId=" + stationId + ":", err);
    if (err.noaaDataError) {
      res.status(422).json({ error: "This tide station doesn't have full predictions available (NOAA: " + err.message + "). Try picking a different station." });
      return;
    }
    res.status(502).json({ error: "Couldn't reach NOAA/sun-moon data right now" });
  }
}

exports.astroTimelineProxy = onRequest({ cors: true, region: "us-central1" }, astroTimelineProxyHandler);

// ================= Beach flag proxy =================
// design's Beach Flags tool live preview. Unlike astroProxy/
// astroTimelineProxy above, lat/lon/stationId are OPTIONAL here, not
// required -- they only feed the bonus surf-height/water-temp stat line
// (via the same free fetchTideCardData every Tide card already uses);
// the flag color itself comes from a single fixed page (30a.com/beachflag/)
// that covers the whole 30A corridor, not a per-device lookup. Present-
// but-invalid coordinates still get rejected, same reasoning as
// astroProxyHandler: better to fail loudly than silently ignore a typo'd
// value.
async function beachFlagProxyHandler(req, res) {
  const hasLat = typeof req.query.lat === "string" && req.query.lat.trim() !== "";
  const hasLon = typeof req.query.lon === "string" && req.query.lon.trim() !== "";
  const hasStation = typeof req.query.stationId === "string" && req.query.stationId.trim() !== "";
  let lat = null, lon = null, stationId = null;

  if (hasLat || hasLon || hasStation) {
    lat = parseFloat(req.query.lat);
    lon = parseFloat(req.query.lon);
    stationId = hasStation ? req.query.stationId : "";
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
      res.status(400).json({ error: "lat/lon must be valid coordinates" });
      return;
    }
    if (!/^[0-9]{5,9}$/.test(stationId)) {
      res.status(400).json({ error: "stationId must be a NOAA station number" });
      return;
    }
  }

  // Free-text, not validated like lat/lon/stationId above -- it's only
  // ever drawn as a label on the card (never interpreted), same as
  // newsProxyHandler's own `location` query param.
  const townName = typeof req.query.townName === "string" ? req.query.townName.trim() : "";

  try {
    const data = await fetchBeachFlagCardData({ lat, lon, stationId, townName: townName || null }, new Date());
    res.status(200).json(data);
  } catch (err) {
    logger.error("Beach flag proxy request failed:", err);
    res.status(502).json({ error: "Couldn't reach 30a.com's beach flag status right now" });
  }
}

exports.beachFlagProxy = onRequest({ cors: true, region: "us-central1" }, beachFlagProxyHandler);

// ================= Live music proxy =================
// design's Live Music tool live preview. `page` is the only query param
// -- unlike Beach Flags, nothing else on this card is per-device (see
// fetchMusicEventsCardData's own comment). Anything other than the
// literal string "1" is treated as page 0, same lenient-clamp handling
// design's own screen-number parsing uses elsewhere, since this is a
// value our own client code sets from a fixed subType, never something a
// customer types in.
async function liveMusicProxyHandler(req, res) {
  const page = req.query.page === "1" ? 1 : 0;
  try {
    const data = await fetchMusicEventsCardData(undefined, page);
    res.status(200).json(data);
  } catch (err) {
    logger.error("Live music proxy request failed:", err);
    res.status(502).json({ error: "Couldn't reach the live music schedule right now" });
  }
}

exports.liveMusicProxy = onRequest({ cors: true, region: "us-central1" }, liveMusicProxyHandler);

// ================= OCNJ Events proxy =================
// design's OCNJ Events tool live preview. No query params at all -- same
// reasoning as liveMusicProxy, and this reads the daily pipeline's own
// published data/ocnj-events.json (see lib/ocnjCard.js's own header
// comment) rather than re-running the pipeline itself.
async function ocnjEventsProxyHandler(req, res) {
  try {
    const data = await fetchOcnjEventsCardData(undefined);
    res.status(200).json(data);
  } catch (err) {
    logger.error("OCNJ events proxy request failed:", err);
    res.status(502).json({ error: "Couldn't reach today's OCNJ events right now" });
  }
}

exports.ocnjEventsProxy = onRequest({ cors: true, region: "us-central1" }, ocnjEventsProxyHandler);

// ================= Imagen proxy (Beach Buddy) =================
// design's Beach Buddy tool needs to show the REAL Imagen illustration
// while previewing, not just the procedural fallback -- same CORS
// reasoning as every other proxy here (a script-initiated fetch() from
// the browser straight to Vertex AI's API would need CORS headers it
// doesn't send; server-to-server was never subject to that).
//
// Unlike every other proxy in this file, this one is NOT a thin
// passthrough of a free public API -- Imagen bills per generated image,
// so the request shape here is deliberately closed rather than open:
// the browser can only pick one of a small fixed set of KNOWN poses
// (IMAGEN_SCENE_HINTS, the same list moodForBeachData ever picks from),
// never send its own free-text prompt. That's what keeps this from
// being usable as "generate whatever image you want, billed to
// waveclock's project" by anyone who finds the URL -- the prompt is
// always built server-side from imagen.js's fixed STYLE_PREFIX + one of
// its fixed scene hints, exactly like the daily job itself does.
//
// Goes through the SAME shared cache regenerateBeachBuddyDesigns' hourly
// job uses (getOrGenerateBeachBuddyArt) rather than calling Imagen
// fresh on every preview -- once a pose+sunny scenario has been cached
// (by either this proxy or the hourly job, whichever needs it first),
// re-previewing it here never bills another Imagen call again. `sunny`
// is a plain "1"/"true" query flag (design's live preview passes it
// when the mood it just computed included the "sun" prop) -- see
// cacheKeyForMood in lib/imagen.js for why (pose, sunny) together
// identify one cached illustration.
//
// The daily regeneration job (regenerateCountdownDesigns) never touches
// Beach Buddy devices at all -- see NOT_BEACH_BUDDY above.
//
// `getArtImpl`, when given, replaces the real cache-or-generate call --
// same convention as every injectable dependency elsewhere in this
// file, used only by tests so they never need real Storage/Vertex AI
// credentials.
async function imagenProxyHandler(req, res, getArtImpl) {
  const pose = req.query.pose;
  if (typeof pose !== "string" || !Object.prototype.hasOwnProperty.call(IMAGEN_SCENE_HINTS, pose)) {
    res.status(400).json({ error: "pose must be one of: " + Object.keys(IMAGEN_SCENE_HINTS).join(", ") });
    return;
  }
  const sunny = req.query.sunny === "1" || req.query.sunny === "true";
  const mood = { pose, props: sunny ? ["sun"] : [] };

  try {
    const getArt = getArtImpl || ((m) => getOrGenerateBeachBuddyArt(m, {
      bucket: admin.storage().bucket(),
      project: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT,
      location: "us-central1"
    }));
    const buf = await getArt(mood);
    res.set("Content-Type", "image/png");
    res.status(200).send(buf);
  } catch (err) {
    logger.error("Imagen proxy request failed for pose=" + pose + " sunny=" + sunny + ":", err);
    res.status(502).json({ error: "Couldn't generate Beach Buddy art right now" });
  }
}

exports.imagenProxy = onRequest({ cors: true, region: "us-central1" }, imagenProxyHandler);

// ================= TeamSnap proxy =================
// team-schedule.html needs to fetch a team's exported .ics feed from the
// visitor's browser. Same problem as espnProxy/newsProxy above:
// TeamSnap's ical-cdn doesn't send CORS headers for a script-initiated
// fetch(), so this fetches it server-to-server (never subject to CORS)
// and hands back already-parsed events as JSON, with permissive CORS
// headers of its own.
//
// Restricted to https://*.teamsnap.com URLs ending in .ics (see
// isTeamsnapIcsUrl in lib/teamsnap.js) so this can't be used as an open
// relay to arbitrary sites -- the same boundary espnProxy uses for its
// own fixed-hostname CDN.
async function teamsnapProxyHandler(req, res) {
  const url = req.query.url;
  if (typeof url !== "string" || !isTeamsnapIcsUrl(url)) {
    res.status(400).json({ error: "url must be an https://*.teamsnap.com feed ending in .ics" });
    return;
  }

  try {
    const { calendarName, events } = await fetchIcsSchedule(url);
    res.status(200).json({ calendarName, events });
  } catch (err) {
    logger.error("TeamSnap proxy request failed for " + url + ":", err);
    res.status(502).json({ error: "Couldn't reach that TeamSnap feed" });
  }
}

exports.teamsnapProxy = onRequest({ cors: true, region: "us-central1" }, teamsnapProxyHandler);

// Exposed for the mocked-bucket/mocked-req-res tests in test/orchestration.test.js
// -- harmless extra export, Firebase only picks up trigger-shaped exports
// when deploying.
exports._internal = { processDevice, deviceIdFromDynamicPath, deleteIfExists, getOrGenerateBeachBuddyArt, espnProxyHandler, newsProxyHandler, astroProxyHandler, astroTimelineProxyHandler, beachFlagProxyHandler, liveMusicProxyHandler, ocnjEventsProxyHandler, imagenProxyHandler, teamsnapProxyHandler, ALLOWED_LEAGUES, isEspnCdnUrl };
