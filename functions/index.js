// Daily job: for every device with an active "dynamic layer" (a Countdown
// or a Team schedule, published from /design/), redraw today's content
// onto its saved base design and overwrite designs/{id}.bin + .png -- the
// same two files the device already reads unconditionally, so no firmware
// change is needed for this to show up.
//
// Also exports espnProxy, an HTTP function design's Team tool calls
// from the browser to get a live schedule preview before publishing --
// see the comment above it for why that can't just call ESPN directly.
"use strict";

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const { renderDynamicDesign, espnTeamsUrl, espnScheduleUrl, fetchHeadlines, isSafeFetchUrl, MAX_NEWS_HEADLINES, OUTBOUND_FETCH_HEADERS } = require("./lib/dynamic");
const { fetchTideCardData } = require("./lib/astro");
const { isTeamsnapIcsUrl, fetchIcsSchedule } = require("./lib/teamsnap");

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
async function processDevice(bucket, deviceId, now, fetchImpl) {
  const dynamicFile = bucket.file(DESIGNS_PREFIX + deviceId + DYNAMIC_SUFFIX);
  const baseFile = bucket.file(DESIGNS_PREFIX + deviceId + "-base.png");

  const [metaBuffer] = await dynamicFile.download();
  const meta = JSON.parse(metaBuffer.toString("utf8"));

  const [baseBuffer] = await baseFile.download();
  // Throws on a genuine failure (e.g. ESPN unreachable for a "team" layer)
  // -- that propagates up to the caller's try/catch below, which leaves
  // this device untouched and retries on the next scheduled run. Only a
  // concluded countdown returns null here; a team's schedule never does
  // (see renderDynamicDesign's contract in lib/dynamic.js).
  const result = await renderDynamicDesign(baseBuffer, meta, now, fetchImpl);

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
    let updated = 0, expired = 0, failed = 0;
    for (const deviceId of deviceIds) {
      try {
        const outcome = await processDevice(bucket, deviceId, now);
        if (outcome === "updated") updated++;
        else if (outcome === "expired") expired++;
      } catch (err) {
        failed++;
        // One device's bad/missing base.png (or a transient ESPN outage
        // for a team layer) shouldn't stop the rest of the fleet from
        // getting their update -- and shouldn't be treated as "give up on
        // this device," just "try again tomorrow."
        logger.error("Failed to regenerate dynamic layer for " + deviceId + ":", err);
      }
    }
    logger.info("Done. updated=" + updated + " expired=" + expired + " failed=" + failed);
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
  } else {
    res.status(400).json({ error: "kind must be \"teams\", \"schedule\", or \"logo\"" });
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
exports._internal = { processDevice, deviceIdFromDynamicPath, deleteIfExists, espnProxyHandler, newsProxyHandler, astroProxyHandler, teamsnapProxyHandler, ALLOWED_LEAGUES, isEspnCdnUrl };
