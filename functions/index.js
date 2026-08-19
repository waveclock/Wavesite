// Daily job: for every device with an active "dynamic layer" (a Countdown
// or a Team schedule, published from /design-v2/), redraw today's content
// onto its saved base design and overwrite designs/{id}.bin + .png -- the
// same two files the device already reads unconditionally, so no firmware
// change is needed for this to show up.
//
// Also exports espnProxy, an HTTP function design-v2's Team tool calls
// from the browser to get a live schedule preview before publishing --
// see the comment above it for why that can't just call ESPN directly.
"use strict";

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const { renderDynamicDesign, espnTeamsUrl, espnScheduleUrl } = require("./lib/dynamic");

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
// design-v2's Team tool needs a live schedule fetch to show an accurate
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
// same ones design-v2's League dropdown offers) rather than proxying any
// URL a caller asks for, so this can't be used as an open relay to
// arbitrary sites.
const ALLOWED_LEAGUES = new Set([
  "football/nfl",
  "football/college-football",
  "basketball/nba",
  "baseball/mlb",
  "hockey/nhl"
]);

// Plain (req, res) handler, kept separate from the onRequest() wrapper
// below so it can be unit-tested with fake req/res objects without
// spinning up the Functions Framework.
async function espnProxyHandler(req, res) {
  const sport = req.query.sport;
  const league = req.query.league;
  const kind = req.query.kind;

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
    res.status(400).json({ error: "kind must be \"teams\" or \"schedule\"" });
    return;
  }

  try {
    const espnResp = await fetch(url);
    const data = await espnResp.json();
    res.status(espnResp.status).json(data);
  } catch (err) {
    logger.error("ESPN proxy request failed for " + url + ":", err);
    res.status(502).json({ error: "Couldn't reach ESPN" });
  }
}

exports.espnProxy = onRequest({ cors: true, region: "us-central1" }, espnProxyHandler);

// Exposed for the mocked-bucket/mocked-req-res tests in test/orchestration.test.js
// -- harmless extra export, Firebase only picks up trigger-shaped exports
// when deploying.
exports._internal = { processDevice, deviceIdFromDynamicPath, deleteIfExists, espnProxyHandler, ALLOWED_LEAGUES };
