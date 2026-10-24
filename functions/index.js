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
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const { renderDynamicDesign, espnTeamsUrl, espnScheduleUrl, espnTeamUrl, espnSummaryUrl, fetchHeadlines, isSafeFetchUrl, MAX_NEWS_HEADLINES, OUTBOUND_FETCH_HEADERS } = require("./lib/dynamic");
const { fetchTideCardData, fetchTideTimelineData } = require("./lib/astro");
const { isTeamsnapIcsUrl, fetchIcsSchedule } = require("./lib/teamsnap");
const { generateBeachBuddyArt, IMAGEN_SCENE_HINTS, PROMPT_VERSION, cacheKeyForMood, generateInkBlotArt } = require("./lib/imagen");
const { fetchBeachFlagCardData } = require("./lib/beachflag");
const { fetchMusicEventsCardData } = require("./lib/liveMusic");
const { runOcnjEventsPipeline } = require("./lib/ocnjPipeline");
const { fetchOcnjEventsCardData } = require("./lib/ocnjCard");
const { fetchHurricaneTrackerCardData } = require("./lib/hurricaneTracker");
const { isValidTagId, isValidDeviceId, isValidPairCode, fetchTideTag, saveTideTag, updateTideTag, deleteTideTag, isTagIdMinted, mintTagIds, linkTideTagToDevice, createPairCode, redeemPairCode, fetchDeviceTagLinkSelfHealing, unpairDevice, backfillDeviceTagLinks } = require("./lib/tideTag");
const { regenerateBeachDayCache } = require("./lib/beachDayCache");
const { fetchCoastlineNear } = require("./lib/coastline");
const { fetchCachedCoastline, saveCachedCoastline } = require("./lib/coastlineCache");

admin.initializeApp({ storageBucket: "waveclock.firebasestorage.app" });

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
// daily pass already does. "hurricaneTracker" is excluded for the same
// reason as beachFlag/liveMusic -- an active storm's position, forecast,
// and distance to a given town can all meaningfully change within a
// single day, so it rides its own hourly schedule
// (regenerateHurricaneTrackerDesigns below) instead.
const DAILY_REGEN_TYPES = (type) => type !== "beachBuddy" && type !== "beachFlag" && type !== "liveMusic" && type !== "liveMusicMore" && type !== "hurricaneTracker";

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

// Beach Day's shared, location-keyed cache (see lib/beachDayCache.js's
// own header comment for the full rationale) -- a SEPARATE daily job
// from regenerateCountdownDesigns above, not a replacement for it: a
// device that's actually enrolled Beach Day as one of its own custom
// screens still gets its own designs/{deviceId}.bin/.png from that
// job's normal per-device "beachDay" dynamic-layer handling (already
// covered by DAILY_REGEN_TYPES not excluding "beachDay"). This job
// instead builds the shared beach-day-cache/{key}.bin/.png entries the
// keychain web view reads directly, one per unique town rather than one
// per device, regardless of whether anyone's enrolled it on a clock at
// all. Same 9am UTC slot as the other once-daily types, since this is
// exactly that kind of "built once in the morning" screen too.
exports.regenerateBeachDayCache = onSchedule(
  { schedule: "0 9 * * *", timeZone: "Etc/UTC", retryCount: 1 },
  async () => {
    const bucket = admin.storage().bucket();
    const result = await regenerateBeachDayCache(bucket, new Date());
    logger.info("Beach Day cache: " + result.updated + " updated, " + result.failed + " failed, out of " + result.locationCount + " active location(s).");
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

// Hourly, like Live Music and Beach Buddy -- an active storm's position
// and forecast genuinely change within a day, and DAILY_REGEN_TYPES
// above deliberately excludes "hurricaneTracker" so this is the only
// thing keeping that card current. Same blind full-redraw approach as
// the other hourly jobs: one NHC fetch (plus, when a storm's in range,
// a second small text fetch for the forecast track) per device, cheap
// either way.
exports.regenerateHurricaneTrackerDesigns = onSchedule(
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
          typeFilter: (type) => type === "hurricaneTracker"
        });
        if (outcome === "updated") updated++;
        else if (outcome === "skipped") skipped++;
      } catch (err) {
        failed++;
        logger.error("Failed to refresh Hurricane Tracker layer for " + deviceId + ":", err);
      }
    }
    logger.info("Hurricane Tracker refresh done. updated=" + updated + " skipped(not hurricaneTracker)=" + skipped + " failed=" + failed);
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
// See lib/ocnjPipeline.js for the full fetch -> merge -> publish flow
// (ported from the customer's parse_calendar.py / source_oceancityvacation.py
// / merge_sources.py / curate_with_llm.py / run_pipeline.py handoff, 2 Sep
// 2026) and its own comment for why the output lands in Storage instead of
// on local disk.
//
// useAI defaults to false in runOcnjEventsPipeline -- no ANTHROPIC_API_KEY
// secret is bound here, so this runs on the free rule-based curation
// (curateWithoutAI in lib/ocnjPipeline.js) rather than billing a Claude call
// every day. See that function's own comment for what it trades off. To
// switch this device back to AI curation later: run
// `firebase functions:secrets:set ANTHROPIC_API_KEY` with a real key, add
// `secrets: [ANTHROPIC_API_KEY]` back to this function's options (import via
// `defineSecret` from "firebase-functions/params" the same way as before),
// and pass `useAI: true, apiKey: ANTHROPIC_API_KEY.value()` below.
exports.generateOcnjEventsJson = onSchedule(
  { schedule: "0 8 * * *", timeZone: "Etc/UTC", retryCount: 1, timeoutSeconds: 300, memory: "512MiB" },
  async () => {
    const bucket = admin.storage().bucket();
    const result = await runOcnjEventsPipeline({ bucket });
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
    // seasonType lets the live preview mirror fetchNextGame's own
    // regular-season-then-postseason-then-next-season fallback (see
    // espnScheduleUrl's comment) -- anything other than the literal "1"
    // or "3" stays on the regular-season default rather than trusting an
    // arbitrary value. season (year) is only meaningful alongside a
    // future-season lookup (see fetchNextSeasonGame), so it's bounded to
    // this year or next rather than passed through unchecked -- this is
    // still a public proxy endpoint.
    const seasonTypeParam = req.query.seasonType;
    const seasonType = seasonTypeParam === "1" ? 1 : seasonTypeParam === "3" ? 3 : 2;
    let seasonYear;
    if (typeof req.query.season === "string" && /^\d{4}$/.test(req.query.season)) {
      const y = Number(req.query.season);
      const nowYear = new Date().getUTCFullYear();
      if (y >= nowYear && y <= nowYear + 1) seasonYear = y;
    }
    url = espnScheduleUrl(sport, league, teamId, seasonType, seasonYear);
  } else if (kind === "record") {
    const teamId = req.query.teamId;
    if (typeof teamId !== "string" || !teamId) {
      res.status(400).json({ error: "Missing teamId" });
      return;
    }
    url = espnTeamUrl(sport, league, teamId);
  } else if (kind === "predictor") {
    const eventId = req.query.eventId;
    if (typeof eventId !== "string" || !eventId) {
      res.status(400).json({ error: "Missing eventId" });
      return;
    }
    url = espnSummaryUrl(sport, league, eventId);
  } else {
    res.status(400).json({ error: "kind must be \"teams\", \"schedule\", \"record\", \"predictor\", or \"logo\"" });
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

// ================= Hurricane Tracker proxy =================
// design's Hurricane Tracker tool live preview -- needs a lat/lon
// (same required-coordinates validation beachFlagProxy uses) since
// "nearest storm" and "closest approach" are both relative to a specific
// town. Unlike beachFlagProxy's location params, there's no optional
// no-location path here: without coordinates there's nothing to measure
// against, so this always requires lat/lon rather than falling back to
// a locationless card.
async function hurricaneTrackerProxyHandler(req, res) {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    res.status(400).json({ error: "lat/lon must be valid coordinates" });
    return;
  }
  const townName = typeof req.query.townName === "string" ? req.query.townName.trim() : "";

  try {
    const data = await fetchHurricaneTrackerCardData({ lat, lon, townName: townName || null }, new Date());
    res.status(200).json(data);
  } catch (err) {
    logger.error("Hurricane tracker proxy request failed:", err);
    res.status(502).json({ error: "Couldn't reach the National Hurricane Center right now" });
  }
}

exports.hurricaneTrackerProxy = onRequest({ cors: true, region: "us-central1" }, hurricaneTrackerProxyHandler);

// ================= Coastline proxy =================
// Backs the tide tag page's (404.html) Clean/Fair/Choppy wind-vs-coast
// badge -- see lib/coastline.js's own header comment for why this has to
// be a server-side proxy rather than 404.html calling Overpass's public
// mirrors directly. Same required-coordinates validation as
// hurricaneTrackerProxy above; returns the raw Overpass response
// (elements array) unchanged so the client's own existing
// coastlineBearingFromOsm keeps doing the actual bearing math.
//
// Checks lib/coastlineCache.js's own cross-user cache before ever
// touching Overpass -- a coastline's shape doesn't change, so the FIRST
// pick anywhere near a given spot pays Overpass's own (hardened but
// still sometimes slow) retry chain, and every later pick near that same
// spot, by anyone, is an instant cache hit instead. `bucketImpl`, when
// given, replaces admin.storage().bucket() -- same injectable-dependency
// convention tideTagProxyHandler's own bucketImpl already uses, for
// tests.
async function coastlineProxyHandler(req, res, fetchImpl, bucketImpl) {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    res.status(400).json({ error: "lat/lon must be valid coordinates" });
    return;
  }
  const bucket = bucketImpl || admin.storage().bucket();
  const cached = await fetchCachedCoastline(bucket, lat, lon);
  if (cached) {
    res.status(200).json(cached);
    return;
  }
  try {
    const data = await fetchCoastlineNear(lat, lon, fetchImpl);
    res.status(200).json(data);
    // Only reached once the real response is already on its way to the
    // client -- see saveCachedCoastline's own "never throws" contract,
    // which is what makes awaiting it here safe: a cache-write failure
    // can never turn into a second, conflicting response below.
    await saveCachedCoastline(bucket, lat, lon, data);
  } catch (err) {
    logger.error("Coastline proxy request failed for " + lat + "," + lon + ":", err);
    res.status(502).json({ error: "Couldn't reach the coastline service right now" });
  }
}

exports.coastlineProxy = onRequest({ cors: true, region: "us-central1" }, coastlineProxyHandler);

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

// ================= Ink Blot photo filter proxy =================
// design's Photo tool's "AI Ink Blot" style needs to run a user's own
// uploaded photo through Gemini's image-EDITING path before the app
// dithers it for the display -- same CORS/billing-surface reasoning as
// imagenProxy above (a script-initiated fetch() from the browser
// straight to Vertex AI needs CORS headers it doesn't send, and billing
// per call means this can't be an open passthrough).
//
// Unlike imagenProxy's fixed pose-name list, the INPUT here is a user's
// own photo, so it can't be restricted to a small fixed set the way a
// text prompt can -- but the PROMPT itself is exactly as closed as
// imagenProxy's: always lib/imagen.js's own fixed INKBLOT_PROMPT, never
// anything the request body supplies, so this can't be used to generate
// an arbitrary image from arbitrary text. INKBLOT_IMAGE_BYTES_LIMIT caps
// the upload itself -- design/index.html already downscales to
// MAX_WORKING_DIMENSION (500px) before sending, so a real request from
// the app is always far under this; a direct API call submitting
// something huge is rejected outright instead of quietly billed for.
const INKBLOT_ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];
const INKBLOT_IMAGE_BYTES_LIMIT = 4 * 1024 * 1024; // 4MB decoded -- generous for a <=500px photo

// `getArtImpl`, when given, replaces the real generateInkBlotArt call --
// same injectable-dependency convention as imagenProxyHandler's
// `getArtImpl` above, used only by tests.
async function inkBlotProxyHandler(req, res, getArtImpl) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  const { image, mimeType } = req.body || {};
  if (typeof image !== "string" || !image) {
    res.status(400).json({ error: "image (base64) is required" });
    return;
  }
  if (typeof mimeType !== "string" || !INKBLOT_ALLOWED_MIME_TYPES.includes(mimeType)) {
    res.status(400).json({ error: "mimeType must be one of: " + INKBLOT_ALLOWED_MIME_TYPES.join(", ") });
    return;
  }
  const imageBuffer = Buffer.from(image, "base64");
  if (imageBuffer.length === 0 || imageBuffer.length > INKBLOT_IMAGE_BYTES_LIMIT) {
    res.status(400).json({ error: "image must be a non-empty photo under " + Math.round(INKBLOT_IMAGE_BYTES_LIMIT / 1024 / 1024) + "MB" });
    return;
  }

  try {
    const getArt = getArtImpl || ((buf, mt) => generateInkBlotArt(buf, mt, {
      project: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT,
      location: "us-central1"
    }));
    const buf = await getArt(imageBuffer, mimeType);
    res.set("Content-Type", "image/png");
    res.status(200).send(buf);
  } catch (err) {
    logger.error("Ink Blot proxy request failed:", err);
    res.status(502).json({ error: "Couldn't generate ink blot art right now" });
  }
}

exports.inkBlotProxy = onRequest({ cors: true, region: "us-central1" }, inkBlotProxyHandler);

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

// ================= Tide tag proxy =================
// Backs the NFC keychain flow (see /404.html and /t/index.html): each
// keychain's NFC tag opens https://waveclock.net/t/{tagId}, which calls
// this to look up (GET), register (POST), or unlink (DELETE) which NOAA
// tide station that specific tag points at. See lib/tideTag.js for the
// storage scheme (Cloud Storage, not Firestore -- nothing else is
// provisioned in this Firebase project) and the atomic-create-only
// precondition that makes POST safe against a tag getting tapped twice
// in a race.
//
// `bucketImpl`, when given, replaces admin.storage().bucket() -- same
// injectable-dependency convention as imagenProxyHandler's getArtImpl,
// used only by tests (a fully in-memory fake bucket, no live GCS call).
const TAG_ID_HINT = "tagId must be 16-32 characters (A-Z, 2-9, excluding the easily-misread 0/O/1/I)";

// Gates mintTideTagBatch below -- a plain runtime env var, NOT a Secret
// Manager-backed defineSecret(). It started as one, but the deploy
// (firebase deploy --only functions) needs to resolve any declared
// secret BEFORE it will deploy anything in the codebase, which in turn
// needs the deploying identity (the FIREBASE_SERVICE_ACCOUNT service
// account) to hold secretmanager.secrets.get on it -- granting that
// role (confirmed correct via Cloud IAM's own Policy Troubleshooter,
// including its own "Remediate" flow) still didn't resolve the denial
// after multiple propagation windows, blocking every deploy of this
// whole codebase, not just this one endpoint. Reading it as a plain env
// var instead sidesteps Secret Manager entirely: deploy-functions.yml
// writes functions/.env.waveclock (gitignored, never committed) from a
// GitHub Actions repository secret of the same name right before
// deploying -- same "never in the repo" guarantee, just a different,
// unblocked delivery path. Revisit Secret Manager later if that IAM
// issue ever gets root-caused; nothing else about mintTideTagBatch
// depends on which mechanism supplies this value.
function mintSecretValue() {
  return process.env.WAVECLOCK_MINT_SECRET;
}

// Shared response shape for GET/POST/PUT -- lat/lon are only included
// when the record actually has them (an older registration, or one
// whose picker request didn't send coordinates, won't), never as
// explicit `undefined` keys, which would otherwise round-trip through
// res.json() and change the response's own key set for every existing
// client parsing it.
//
// `registered` reflects whether THIS record has its own station picked
// -- no longer a given just because a record file exists, now that
// linkTideTagToDevice can create one with nothing but a linkedDeviceId
// (a keychain paired to a WaveClock before ever being tapped). A linked
// tag's own stationId/stationName are omitted entirely rather than sent
// as undefined -- the tide page is expected to ignore them in favor of
// the linked device's own data whenever linkedDeviceId is present, but
// there's no reason to hand over stale fields it shouldn't be reading.
function tagResponseBody(record) {
  const body = { registered: record.stationId != null };
  if (body.registered) {
    body.stationId = record.stationId;
    body.stationName = record.stationName;
  }
  if (record.linkedDeviceId != null) {
    body.linkedDeviceId = record.linkedDeviceId;
  }
  if (record.lat != null && record.lon != null) {
    body.lat = record.lat;
    body.lon = record.lon;
  }
  if (record.townName != null) {
    body.townName = record.townName;
  }
  if (record.coastFacingDirection != null) {
    body.coastFacingDirection = record.coastFacingDirection;
  }
  if (record.srfZone != null) {
    body.srfZone = record.srfZone;
  }
  if (record.marineZone != null) {
    body.marineZone = record.marineZone;
  }
  return body;
}

async function tideTagProxyHandler(req, res, bucketImpl) {
  const bucket = bucketImpl || admin.storage().bucket();

  if (req.method === "GET") {
    const tagId = req.query.tagId;
    if (typeof tagId !== "string" || !isValidTagId(tagId)) {
      res.status(400).json({ error: TAG_ID_HINT });
      return;
    }
    try {
      const record = await fetchTideTag(bucket, tagId);
      if (!record) {
        res.status(200).json({ registered: false });
        return;
      }
      res.status(200).json(tagResponseBody(record));
    } catch (err) {
      logger.error("Tide tag proxy GET failed for " + tagId + ":", err);
      res.status(502).json({ error: "Couldn't reach tag storage right now" });
    }
    return;
  }

  if (req.method === "POST") {
    const { tagId, stationId, stationName, lat, lon, townName, coastFacingDirection, srfZone, marineZone } = req.body || {};
    if (typeof tagId !== "string" || !isValidTagId(tagId)) {
      res.status(400).json({ error: TAG_ID_HINT });
      return;
    }
    // Same NOAA-station-number shape beachFlagProxyHandler already
    // validates stationId against.
    if (typeof stationId !== "string" || !/^[0-9]{5,9}$/.test(stationId)) {
      res.status(400).json({ error: "stationId must be a NOAA station number" });
      return;
    }
    // Free-text, not format-validated -- it's only ever drawn as a label
    // on the tide page, never interpreted, same as beachFlagProxyHandler's
    // own townName.
    if (typeof stationName !== "string" || !stationName.trim()) {
      res.status(400).json({ error: "stationName is required" });
      return;
    }
    // lat/lon, coastFacingDirection, srfZone, and marineZone are all
    // optional (see lib/tideTag.js's own sanitizers) -- these are
    // resolved client-side from OSM/NWS lookups that can legitimately
    // fail or be skipped, so a missing/malformed value here just means
    // those enrichments aren't available for this tag yet, not a
    // rejected registration.
    //
    // Checked AFTER shape/stationId/stationName validation (so a
    // malformed request still gets the more specific 400 above) but
    // BEFORE ever touching the tide-tags/ record itself -- see
    // isTagIdMinted's own comment for why a well-formed, even
    // unguessable tagId still isn't enough on its own.
    try {
      if (!(await isTagIdMinted(bucket, tagId))) {
        res.status(403).json({ error: "This tag hasn't been issued yet" });
        return;
      }
    } catch (err) {
      logger.error("Tide tag proxy POST mint check failed for " + tagId + ":", err);
      res.status(502).json({ error: "Couldn't verify that tag right now" });
      return;
    }
    try {
      const result = await saveTideTag(bucket, tagId, stationId, stationName.trim(), lat, lon, townName, coastFacingDirection, srfZone, marineZone);
      if (result.status === "already-registered") {
        res.status(409).json({ error: "This tag is already registered to a beach" });
        return;
      }
      res.status(201).json(tagResponseBody(result.record));
    } catch (err) {
      logger.error("Tide tag proxy POST failed for " + tagId + ":", err);
      res.status(502).json({ error: "Couldn't save that right now" });
    }
    return;
  }

  if (req.method === "PUT") {
    // Deliberately-overwriting counterpart to POST above -- the "Change
    // beach" link on an already-registered tag's tide page. Same
    // validation, but always succeeds (short of a real storage failure)
    // since there's no "already registered" case to guard against here.
    const { tagId, stationId, stationName, lat, lon, townName, coastFacingDirection, srfZone, marineZone } = req.body || {};
    if (typeof tagId !== "string" || !isValidTagId(tagId)) {
      res.status(400).json({ error: TAG_ID_HINT });
      return;
    }
    if (typeof stationId !== "string" || !/^[0-9]{5,9}$/.test(stationId)) {
      res.status(400).json({ error: "stationId must be a NOAA station number" });
      return;
    }
    if (typeof stationName !== "string" || !stationName.trim()) {
      res.status(400).json({ error: "stationName is required" });
      return;
    }
    // Same mint check POST makes -- PUT can ALSO create a brand-new
    // registration (see this handler's own comment above), so without
    // this it would be a second, un-gated path to the exact thing the
    // POST check exists to prevent.
    try {
      if (!(await isTagIdMinted(bucket, tagId))) {
        res.status(403).json({ error: "This tag hasn't been issued yet" });
        return;
      }
    } catch (err) {
      logger.error("Tide tag proxy PUT mint check failed for " + tagId + ":", err);
      res.status(502).json({ error: "Couldn't verify that tag right now" });
      return;
    }
    try {
      const record = await updateTideTag(bucket, tagId, stationId, stationName.trim(), lat, lon, townName, coastFacingDirection, srfZone, marineZone);
      res.status(200).json(tagResponseBody(record));
    } catch (err) {
      logger.error("Tide tag proxy PUT failed for " + tagId + ":", err);
      res.status(502).json({ error: "Couldn't save that right now" });
    }
    return;
  }

  if (req.method === "DELETE") {
    const tagId = req.query.tagId;
    if (typeof tagId !== "string" || !isValidTagId(tagId)) {
      res.status(400).json({ error: TAG_ID_HINT });
      return;
    }
    try {
      await deleteTideTag(bucket, tagId);
      res.status(200).json({ unlinked: true });
    } catch (err) {
      logger.error("Tide tag proxy DELETE failed for " + tagId + ":", err);
      res.status(502).json({ error: "Couldn't unlink that tag right now" });
    }
    return;
  }

  res.status(405).json({ error: "GET, POST, PUT, or DELETE only" });
}

exports.tideTagProxy = onRequest({ cors: true, region: "us-central1" }, tideTagProxyHandler);

const DEVICE_ID_HINT = "deviceId doesn't look right";

// Direct link -- used by the one-tap shortcut on the keychain's own
// page, when that browser already knows a WaveClock's deviceId (it
// previously visited that device's Manage/Location/Settings page on
// this same browser). Both IDs are already in hand on the one
// requesting this, which is the same trust level every other
// tagId-scoped write on this endpoint already relies on (an
// unguessable tagId, or here a remembered deviceId, is itself the
// access control) -- no separate proof is collected beyond that.
async function pairTideTagHandler(req, res, bucketImpl) {
  const bucket = bucketImpl || admin.storage().bucket();
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  const { tagId, deviceId } = req.body || {};
  if (typeof tagId !== "string" || !isValidTagId(tagId)) {
    res.status(400).json({ error: TAG_ID_HINT });
    return;
  }
  if (typeof deviceId !== "string" || !isValidDeviceId(deviceId)) {
    res.status(400).json({ error: DEVICE_ID_HINT });
    return;
  }
  try {
    if (!(await isTagIdMinted(bucket, tagId))) {
      res.status(403).json({ error: "This tag hasn't been issued yet" });
      return;
    }
  } catch (err) {
    logger.error("Pair tide tag mint check failed for " + tagId + ":", err);
    res.status(502).json({ error: "Couldn't verify that tag right now" });
    return;
  }
  try {
    await linkTideTagToDevice(bucket, tagId, deviceId);
    res.status(200).json({ linked: true, deviceId });
  } catch (err) {
    logger.error("Pair tide tag failed for " + tagId + ":", err);
    res.status(502).json({ error: "Couldn't pair that right now" });
  }
}

exports.pairTideTag = onRequest({ cors: true, region: "us-central1" }, pairTideTagHandler);

// Issues a short-lived pairing code for a tag -- the keychain's own
// page calls this when the browser DOESN'T already know a WaveClock's
// deviceId (see pairTideTagHandler's own comment for that case), so the
// person instead carries a short code over to their WaveClock's Manage
// page. Gated by the same mint check as every other tag-id-creating
// path here -- a code is only ever worth issuing for a tag that's
// actually real.
async function requestPairCodeHandler(req, res, bucketImpl) {
  const bucket = bucketImpl || admin.storage().bucket();
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  const { tagId } = req.body || {};
  if (typeof tagId !== "string" || !isValidTagId(tagId)) {
    res.status(400).json({ error: TAG_ID_HINT });
    return;
  }
  try {
    if (!(await isTagIdMinted(bucket, tagId))) {
      res.status(403).json({ error: "This tag hasn't been issued yet" });
      return;
    }
  } catch (err) {
    logger.error("Request pair code mint check failed for " + tagId + ":", err);
    res.status(502).json({ error: "Couldn't verify that tag right now" });
    return;
  }
  try {
    const code = await createPairCode(bucket, tagId);
    res.status(200).json({ code, expiresInMinutes: 15 });
  } catch (err) {
    logger.error("Request pair code failed for " + tagId + ":", err);
    res.status(502).json({ error: "Couldn't create a pairing code right now" });
  }
}

exports.requestPairCode = onRequest({ cors: true, region: "us-central1" }, requestPairCodeHandler);

// The Manage-page counterpart to requestPairCodeHandler above -- trades
// a short code back for the tagId it was issued for, and links that tag
// to deviceId (the WaveClock whose Manage page this is, same as every
// other action there). An invalid, already-used, or expired code is
// reported the same way (there's no reason to distinguish them for
// whoever's typing a code in) -- see redeemPairCode's own comment for
// why those three collapse into one case.
async function redeemPairCodeHandler(req, res, bucketImpl) {
  const bucket = bucketImpl || admin.storage().bucket();
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  const { code, deviceId } = req.body || {};
  if (typeof code !== "string" || !isValidPairCode(code)) {
    res.status(400).json({ error: "That code doesn't look right -- double-check it" });
    return;
  }
  if (typeof deviceId !== "string" || !isValidDeviceId(deviceId)) {
    res.status(400).json({ error: DEVICE_ID_HINT });
    return;
  }
  try {
    const result = await redeemPairCode(bucket, code, deviceId);
    if (result.status === "invalid-or-expired") {
      res.status(404).json({ error: "That code is invalid or has expired -- get a new one from the keychain" });
      return;
    }
    res.status(200).json({ linked: true });
  } catch (err) {
    logger.error("Redeem pair code failed:", err);
    res.status(502).json({ error: "Couldn't pair that right now" });
  }
}

exports.redeemPairCode = onRequest({ cors: true, region: "us-central1" }, redeemPairCodeHandler);

// Lets a device's own pages (Manage/Pair) know whether a keychain is
// currently paired, WITHOUT ever handing back the real tagId -- that's
// a bearer credential for a different trust scope (see
// DEVICE_TAG_LINKS_PREFIX's own comment in lib/tideTag.js), and this
// endpoint's whole job is to answer "is one paired?" without crossing
// that boundary. deviceId alone is the same trust token every other
// device-scoped action (Location/Settings/Design) already relies on --
// no separate secret needed here either.
async function deviceLinkStatusHandler(req, res, bucketImpl) {
  const bucket = bucketImpl || admin.storage().bucket();
  if (req.method !== "GET") {
    res.status(405).json({ error: "GET only" });
    return;
  }
  const deviceId = req.query.deviceId;
  if (typeof deviceId !== "string" || !isValidDeviceId(deviceId)) {
    res.status(400).json({ error: DEVICE_ID_HINT });
    return;
  }
  try {
    // Self-healing (see its own comment in lib/tideTag.js) -- repairs a
    // pairing made before device-tag-links/ existed the moment its
    // owner next loads this check, with no admin secret and no action
    // of their own beyond that.
    const link = await fetchDeviceTagLinkSelfHealing(bucket, deviceId);
    res.status(200).json({ paired: !!link });
  } catch (err) {
    logger.error("Device link status failed for " + deviceId + ":", err);
    res.status(502).json({ error: "Couldn't check that right now" });
  }
}

exports.deviceLinkStatus = onRequest({ cors: true, region: "us-central1" }, deviceLinkStatusHandler);

// The Manage page's own "Unpair" action -- resolves deviceId to
// whichever tag is currently linked (if any) via the reverse index,
// then clears that tag's own link. A device with nothing paired
// reports unpaired:false rather than erroring -- already in the state
// they wanted.
async function unpairDeviceHandler(req, res, bucketImpl) {
  const bucket = bucketImpl || admin.storage().bucket();
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  const { deviceId } = req.body || {};
  if (typeof deviceId !== "string" || !isValidDeviceId(deviceId)) {
    res.status(400).json({ error: DEVICE_ID_HINT });
    return;
  }
  try {
    const unpaired = await unpairDevice(bucket, deviceId);
    res.status(200).json({ unpaired });
  } catch (err) {
    logger.error("Unpair device failed for " + deviceId + ":", err);
    res.status(502).json({ error: "Couldn't unpair that right now" });
  }
}

exports.unpairDevice = onRequest({ cors: true, region: "us-central1" }, unpairDeviceHandler);

// Admin-only: marks a freshly-minted batch of tag IDs as real (see
// isTagIdMinted/mintTagIds in lib/tideTag.js for why this exists at
// all) -- called once per batch by scripts/generateTagIds.js right
// after it draws the batch, never by the tide app itself. Gated by
// WAVECLOCK_MINT_SECRET rather than left open the way the read/write-your-own-tag
// endpoints above are -- those are fine to leave key-less because an
// unguessable tagId is itself the access control (see TAG_ID_PATTERN's
// own comment), but minting isn't scoped to one tag at all: it's the
// one operation that can make ANY new tagId registerable, so it needs
// its own, separate secret rather than relying on that.
const MINT_BATCH_MAX = 1000;
async function mintTideTagBatchHandler(req, res, bucketImpl) {
  const bucket = bucketImpl || admin.storage().bucket();

  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  const providedSecret = req.headers && req.headers["x-mint-secret"];
  const realSecret = mintSecretValue();
  // realSecret itself empty (never configured) must still refuse every
  // request, not silently accept an empty providedSecret as a match.
  if (!realSecret || providedSecret !== realSecret) {
    res.status(403).json({ error: "Invalid or missing mint secret" });
    return;
  }

  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) {
    res.status(400).json({ error: "ids must be a non-empty array" });
    return;
  }
  if (ids.length > MINT_BATCH_MAX) {
    res.status(400).json({ error: "Batch too large (max " + MINT_BATCH_MAX + " at a time)" });
    return;
  }
  for (const id of ids) {
    if (!isValidTagId(id)) {
      res.status(400).json({ error: "Invalid tag ID in batch: " + id });
      return;
    }
  }

  try {
    const result = await mintTagIds(bucket, ids);
    res.status(200).json(result);
  } catch (err) {
    logger.error("Mint tag batch failed:", err);
    res.status(502).json({ error: "Couldn't mint that batch right now" });
  }
}

exports.mintTideTagBatch = onRequest({ cors: false, region: "us-central1" }, mintTideTagBatchHandler);

// Admin-only, one-time repair: a pairing made before device-tag-links/
// existed (added alongside linkTideTagToDevice's own write of it) is
// still correctly linked on the tag's own side, but has no reverse-index
// file for deviceLinkStatusHandler to find -- so Manage's "Pair a
// Keychain" card never learned it was already paired. This scans every
// tide-tags/ record and backfills whichever ones are missing their
// reverse link; see backfillDeviceTagLinks's own comment for exactly
// what it does and doesn't touch. Gated by the same WAVECLOCK_MINT_SECRET
// as mintTideTagBatch above -- not scoped to one tag/device either, so
// it gets the same admin-only treatment rather than the key-less
// single-tag trust model the rest of this file uses.
async function backfillDeviceTagLinksHandler(req, res, bucketImpl) {
  const bucket = bucketImpl || admin.storage().bucket();

  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  const providedSecret = req.headers && req.headers["x-mint-secret"];
  const realSecret = mintSecretValue();
  if (!realSecret || providedSecret !== realSecret) {
    res.status(403).json({ error: "Invalid or missing mint secret" });
    return;
  }

  try {
    const result = await backfillDeviceTagLinks(bucket);
    res.status(200).json(result);
  } catch (err) {
    logger.error("Backfill device-tag-links failed:", err);
    res.status(502).json({ error: "Couldn't backfill right now" });
  }
}

exports.backfillDeviceTagLinks = onRequest({ cors: false, region: "us-central1" }, backfillDeviceTagLinksHandler);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Admin-only, read-only: every device that already has a cwfZone +
// coastFacingDirection on file, grouped by cwfZone, so a canonical
// per-zone direction can be picked once (going into
// KNOWN_ZONE_COAST_DIRECTIONS in location/index.html) and reused for
// every future device in that zone instead of re-deriving it each
// time. Grouped by cwfZone specifically, NOT srfZone -- despite the
// similar-looking names, these are two different NWS zone systems for
// the same stretch of coast (srfZone is the inland-reaching public
// land zone, e.g. "NJZ025"; cwfZone is the coastal-waters/marine zone,
// e.g. "ANZ452"), and KNOWN_ZONE_COAST_DIRECTIONS is looked up by
// selectedMarineZoneId, which holds the latter. srfZone is still shown
// per device as context, just not used for grouping. Reads
// device-status/{id}.json first and only falls back to
// locations/{id}.json for a device missing there, same precedence
// fetchDeviceStatusLocation/fetchDeviceLocation already use in
// 404.html, so this reflects what's actually applied rather than
// whatever the website last submitted. A GET with a query-string
// secret, not a POST with a header like mintTideTagBatch/
// backfillDeviceTagLinks above, since this is meant to be opened
// straight in a browser as a page -- same WAVECLOCK_MINT_SECRET as
// those, just read from req.query instead.
async function coastOrientationReportHandler(req, res, bucketImpl) {
  const bucket = bucketImpl || admin.storage().bucket();

  const providedSecret = req.query && req.query.secret;
  const realSecret = mintSecretValue();
  if (!realSecret || providedSecret !== realSecret) {
    res.status(403).send("Invalid or missing secret");
    return;
  }

  const STATUS_PREFIX = "device-status/";
  const LOCATIONS_PREFIX = "locations/";
  const idFrom = (prefix, name) => (name.startsWith(prefix) && name.endsWith(".json")) ? name.slice(prefix.length, -5) : null;

  const [statusFiles] = await bucket.getFiles({ prefix: STATUS_PREFIX });
  const [locationFiles] = await bucket.getFiles({ prefix: LOCATIONS_PREFIX });
  const statusIds = new Set(statusFiles.map((f) => idFrom(STATUS_PREFIX, f.name)).filter(Boolean));
  const locationIds = new Set(locationFiles.map((f) => idFrom(LOCATIONS_PREFIX, f.name)).filter(Boolean));
  const allIds = Array.from(new Set([...statusIds, ...locationIds])).filter(isValidDeviceId).sort();

  async function readJson(path) {
    try {
      const [buf] = await bucket.file(path).download();
      return JSON.parse(buf.toString("utf8"));
    } catch (err) {
      return null; // missing or malformed -- treat the same as "nothing on file"
    }
  }

  const rows = await Promise.all(allIds.map(async (deviceId) => {
    let cwfZone = null, srfZone = null, coastFacingDirection = null, source = null;
    if (statusIds.has(deviceId)) {
      const j = await readJson(STATUS_PREFIX + deviceId + ".json");
      const loc = j && j.location;
      if (loc && loc.cwfZone) {
        cwfZone = loc.cwfZone;
        srfZone = loc.srfZone || null;
        coastFacingDirection = loc.coastFacingDirection || null;
        source = "device-status";
      }
    }
    if (!cwfZone && locationIds.has(deviceId)) {
      const j = await readJson(LOCATIONS_PREFIX + deviceId + ".json");
      if (j && j.cwfZone) {
        cwfZone = j.cwfZone;
        srfZone = j.srfZone || null;
        coastFacingDirection = j.coastFacingDirection || null;
        source = "locations";
      }
    }
    return { deviceId, cwfZone, srfZone, coastFacingDirection, source };
  }));

  const byZone = new Map();
  for (const row of rows) {
    const zone = row.cwfZone || "(none on file)";
    if (!byZone.has(zone)) byZone.set(zone, []);
    byZone.get(zone).push(row);
  }
  const zones = Array.from(byZone.keys()).sort();

  function directionTally(devices) {
    const counts = new Map();
    for (const d of devices) {
      const key = d.coastFacingDirection || "(none)";
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }

  let html = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Coast orientation by marine zone</title><style>" +
    "body{font-family:-apple-system,Helvetica,Arial,sans-serif;margin:24px;color:#222;}" +
    "h1{font-size:20px;}" +
    "table{border-collapse:collapse;width:100%;margin:8px 0 28px;}" +
    "th,td{border:1px solid #ccc;padding:6px 10px;font-size:13px;text-align:left;}" +
    "th{background:#f3f3f3;}" +
    ".zone-header{font-size:16px;font-weight:700;margin:22px 0 4px;}" +
    ".mixed{color:#a65900;font-weight:600;}" +
    ".muted{color:#666;font-size:12px;}" +
    ".summary td,.summary th{font-size:13px;}" +
    "</style></head><body>" +
    "<h1>Coast orientation by marine zone (cwfZone)</h1>" +
    "<p class=\"muted\">This is the zone KNOWN_ZONE_COAST_DIRECTIONS is actually keyed by -- not the land/public zone (srfZone), shown alongside each device only for context.</p>" +
    "<p class=\"muted\">" + rows.length + " device(s) with a location on file, across " + zones.length + " zone(s). Generated " + escapeHtml(new Date().toISOString()) + ".</p>";

  html += "<table class=\"summary\"><tr><th>Marine zone (cwfZone)</th><th>Devices</th><th>Directions seen (device count)</th></tr>";
  for (const zone of zones) {
    const devices = byZone.get(zone);
    const tally = directionTally(devices);
    const mixed = tally.length > 1;
    const tallyText = tally.map(([dir, n]) => dir + " (" + n + ")").join(", ");
    html += "<tr><td>" + escapeHtml(zone) + "</td><td>" + devices.length + "</td><td class=\"" + (mixed ? "mixed" : "") + "\">" + escapeHtml(tallyText) + "</td></tr>";
  }
  html += "</table>";

  for (const zone of zones) {
    const devices = byZone.get(zone);
    const mixed = directionTally(devices).length > 1;
    html += "<div class=\"zone-header\">" + escapeHtml(zone) + (mixed ? " &mdash; <span class=\"mixed\">mixed directions, pick one</span>" : "") + "</div>";
    html += "<table><tr><th>Device</th><th>Coast faces</th><th>Land zone (srfZone)</th><th>Source</th></tr>";
    for (const d of devices) {
      html += "<tr><td>" + escapeHtml(d.deviceId) + "</td><td>" + escapeHtml(d.coastFacingDirection || "(none)") + "</td><td>" + escapeHtml(d.srfZone || "(none)") + "</td><td>" + escapeHtml(d.source || "(none)") + "</td></tr>";
    }
    html += "</table>";
  }

  html += "</body></html>";
  res.status(200).set("Content-Type", "text/html; charset=utf-8").send(html);
}

exports.coastOrientationReport = onRequest({ cors: false, region: "us-central1" }, coastOrientationReportHandler);

// Exposed for the mocked-bucket/mocked-req-res tests in test/orchestration.test.js
// -- harmless extra export, Firebase only picks up trigger-shaped exports
// when deploying.
exports._internal = { processDevice, deviceIdFromDynamicPath, deleteIfExists, getOrGenerateBeachBuddyArt, espnProxyHandler, newsProxyHandler, astroProxyHandler, astroTimelineProxyHandler, beachFlagProxyHandler, liveMusicProxyHandler, ocnjEventsProxyHandler, hurricaneTrackerProxyHandler, imagenProxyHandler, inkBlotProxyHandler, teamsnapProxyHandler, tideTagProxyHandler, pairTideTagHandler, requestPairCodeHandler, redeemPairCodeHandler, deviceLinkStatusHandler, unpairDeviceHandler, mintTideTagBatchHandler, backfillDeviceTagLinksHandler, coastOrientationReportHandler, coastlineProxyHandler, ALLOWED_LEAGUES, isEspnCdnUrl };
