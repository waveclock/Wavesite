// Daily job: for every device with an active "dynamic layer" (a Countdown
// or a Team schedule, published from /design-v2/), redraw today's content
// onto its saved base design and overwrite designs/{id}.bin + .png -- the
// same two files the device already reads unconditionally, so no firmware
// change is needed for this to show up.
"use strict";

const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const { renderDynamicDesign } = require("./lib/dynamic");

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

// Exposed for the mocked-bucket integration test in test/orchestration.test.js
// -- harmless extra export, Firebase only picks up trigger-shaped exports
// when deploying.
exports._internal = { processDevice, deviceIdFromDynamicPath, deleteIfExists };

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
