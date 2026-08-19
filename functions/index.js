// Daily job: for every device with an active Countdown layer published
// from /design-v2/, redraw today's day-count onto its saved base design
// and overwrite designs/{id}.bin + designs/{id}.png -- the same two files
// the device already reads unconditionally, so no firmware change is
// needed for this to show up.
"use strict";

const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const { renderCountdownDesign } = require("./lib/countdown");

admin.initializeApp({ storageBucket: "waveclock.firebasestorage.app" });

const DESIGNS_PREFIX = "designs/";
const COUNTDOWN_SUFFIX = "-countdown.json";

function deviceIdFromCountdownPath(name) {
  if (!name.startsWith(DESIGNS_PREFIX) || !name.endsWith(COUNTDOWN_SUFFIX)) return null;
  return name.slice(DESIGNS_PREFIX.length, -COUNTDOWN_SUFFIX.length);
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

async function processDevice(bucket, deviceId, now) {
  const countdownFile = bucket.file(DESIGNS_PREFIX + deviceId + COUNTDOWN_SUFFIX);
  const baseFile = bucket.file(DESIGNS_PREFIX + deviceId + "-base.png");

  const [metaBuffer] = await countdownFile.download();
  const meta = JSON.parse(metaBuffer.toString("utf8"));

  const [baseBuffer] = await baseFile.download();
  const result = await renderCountdownDesign(baseBuffer, meta, now);

  if (!result) {
    // Countdown has passed -- leave the last-rendered .bin/.png as-is
    // (frozen on whatever it last showed, e.g. "TODAY!") and stop the
    // daily job from touching this device again.
    logger.info("Countdown passed for " + deviceId + ", cleaning up and leaving the board as-is.");
    await deleteIfExists(countdownFile);
    await deleteIfExists(baseFile);
    return "expired";
  }

  await bucket.file(DESIGNS_PREFIX + deviceId + ".bin").save(result.binBuffer, {
    contentType: "application/octet-stream"
  });
  await bucket.file(DESIGNS_PREFIX + deviceId + ".png").save(result.pngBuffer, {
    contentType: "image/png"
  });
  logger.info("Updated " + deviceId + ": \"" + result.content + "\" (" + result.daysLeft + " days left)");
  return "updated";
}

// Exposed for the mocked-bucket integration test in test/orchestration.test.js
// -- harmless extra export, Firebase only picks up trigger-shaped exports
// when deploying.
exports._internal = { processDevice, deviceIdFromCountdownPath, deleteIfExists };

exports.regenerateCountdownDesigns = onSchedule(
  { schedule: "0 9 * * *", timeZone: "Etc/UTC", retryCount: 1 },
  async () => {
    const bucket = admin.storage().bucket();
    const [files] = await bucket.getFiles({ prefix: DESIGNS_PREFIX });
    const deviceIds = files
      .map((f) => deviceIdFromCountdownPath(f.name))
      .filter(Boolean);

    logger.info("Found " + deviceIds.length + " device(s) with an active countdown.");

    const now = new Date();
    let updated = 0, expired = 0, failed = 0;
    for (const deviceId of deviceIds) {
      try {
        const outcome = await processDevice(bucket, deviceId, now);
        if (outcome === "updated") updated++;
        else if (outcome === "expired") expired++;
      } catch (err) {
        failed++;
        // One device's bad/missing base.png shouldn't stop the rest of the
        // fleet from getting their update.
        logger.error("Failed to regenerate countdown for " + deviceId + ":", err);
      }
    }
    logger.info("Done. updated=" + updated + " expired=" + expired + " failed=" + failed);
  }
);
