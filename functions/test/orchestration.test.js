"use strict";

// Exercises index.js's per-device orchestration (download countdown.json +
// base.png, render, upload .bin/.png, expire/cleanup) against a fully
// in-memory fake Storage bucket -- no live Firebase project involved.

const assert = require("assert");
const { createCanvas } = require("canvas");
const { processDevice, deviceIdFromCountdownPath } = require("../index.js")._internal;

function whitePngBuffer() {
  const c = createCanvas(792, 272);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, 792, 272);
  return c.toBuffer("image/png");
}

// Minimal fake of the subset of the GCS Node client this code touches.
function makeFakeBucket(initialFiles) {
  const store = new Map(Object.entries(initialFiles)); // path -> Buffer
  function fileHandle(path) {
    return {
      path,
      async download() {
        if (!store.has(path)) {
          const err = new Error("not found");
          err.code = 404;
          throw err;
        }
        return [store.get(path)];
      },
      async save(buffer) {
        store.set(path, buffer);
      },
      async delete() {
        if (!store.has(path)) {
          const err = new Error("not found");
          err.code = 404;
          throw err;
        }
        store.delete(path);
      }
    };
  }
  return {
    file: fileHandle,
    _store: store
  };
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ok - " + name);
  } catch (err) {
    failed++;
    console.log("  FAIL - " + name);
    console.log("    " + err.message);
  }
}

(async () => {
  await test("deviceIdFromCountdownPath parses/rejects correctly", () => {
    assert.strictEqual(deviceIdFromCountdownPath("designs/WC-A1B2C3-countdown.json"), "WC-A1B2C3");
    assert.strictEqual(deviceIdFromCountdownPath("designs/WC-A1B2C3.png"), null);
    assert.strictEqual(deviceIdFromCountdownPath("designs/WC-A1B2C3-base.png"), null);
    assert.strictEqual(deviceIdFromCountdownPath("other/WC-A1B2C3-countdown.json"), null);
  });

  await test("processDevice updates .bin/.png from base.png + countdown.json", async () => {
    const now = new Date(Date.UTC(2026, 5, 1));
    const bucket = makeFakeBucket({
      "designs/WC-1-countdown.json": Buffer.from(JSON.stringify({
        targetDate: "2026-06-11", label: "Trip", x: 396, y: 136, size: 40, fontKey: "serif", outline: false, inverted: false
      })),
      "designs/WC-1-base.png": whitePngBuffer(),
      "designs/WC-1.bin": Buffer.from("stale-placeholder"),
      "designs/WC-1.png": Buffer.from("stale-placeholder")
    });
    const outcome = await processDevice(bucket, "WC-1", now);
    assert.strictEqual(outcome, "updated");
    assert.strictEqual(bucket._store.get("designs/WC-1.bin").length, 26928);
    assert.ok(bucket._store.get("designs/WC-1.png").length > 0);
    // countdown.json and base.png should still be there for tomorrow's run.
    assert.ok(bucket._store.has("designs/WC-1-countdown.json"));
    assert.ok(bucket._store.has("designs/WC-1-base.png"));
  });

  await test("processDevice cleans up and stops once the countdown has passed", async () => {
    const now = new Date(Date.UTC(2026, 5, 1));
    const bucket = makeFakeBucket({
      "designs/WC-2-countdown.json": Buffer.from(JSON.stringify({
        targetDate: "2026-05-01", label: "", x: 396, y: 136, size: 40, fontKey: "serif", outline: false, inverted: false
      })),
      "designs/WC-2-base.png": whitePngBuffer(),
      "designs/WC-2.bin": Buffer.from("yesterdays-real-bin"),
      "designs/WC-2.png": Buffer.from("yesterdays-real-png")
    });
    const outcome = await processDevice(bucket, "WC-2", now);
    assert.strictEqual(outcome, "expired");
    // The board's last real .bin/.png are untouched -- frozen, not blanked.
    assert.strictEqual(bucket._store.get("designs/WC-2.bin").toString(), "yesterdays-real-bin");
    // But the countdown bookkeeping files are gone, so this device won't
    // be picked up by future runs.
    assert.ok(!bucket._store.has("designs/WC-2-countdown.json"));
    assert.ok(!bucket._store.has("designs/WC-2-base.png"));
  });

  await test("a missing base.png for one device doesn't throw past the caller (isolated per-device)", async () => {
    const now = new Date(Date.UTC(2026, 5, 1));
    const bucket = makeFakeBucket({
      "designs/WC-3-countdown.json": Buffer.from(JSON.stringify({
        targetDate: "2026-06-11", label: "", x: 396, y: 136, size: 40, fontKey: "serif", outline: false, inverted: false
      }))
      // designs/WC-3-base.png deliberately missing
    });
    await assert.rejects(() => processDevice(bucket, "WC-3", now));
  });

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
