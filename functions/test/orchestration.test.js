"use strict";

// Exercises index.js's per-device orchestration (download dynamic.json +
// base.png, render, upload .bin/.png, expire/cleanup) against a fully
// in-memory fake Storage bucket -- no live Firebase project involved.

const assert = require("assert");
const { createCanvas } = require("canvas");
const { processDevice, deviceIdFromDynamicPath } = require("../index.js")._internal;

function whitePngBuffer() {
  const c = createCanvas(792, 272);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, 792, 272);
  return c.toBuffer("image/png");
}

function fakeFetchJson(payload, ok) {
  return async () => ({
    ok: ok !== false,
    status: ok === false ? 503 : 200,
    async json() { return payload; }
  });
}

function espnSchedule(myTeamId, games) {
  return {
    events: games.map((g, i) => ({
      id: "evt" + i,
      date: g.date,
      competitions: [{
        competitors: [
          { homeAway: g.homeAway, team: { id: myTeamId, abbreviation: "ME" } },
          { homeAway: g.homeAway === "home" ? "away" : "home", team: { id: "opp" + i, abbreviation: g.opponentAbbrev } }
        ]
      }]
    }))
  };
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
  await test("deviceIdFromDynamicPath parses/rejects correctly", () => {
    assert.strictEqual(deviceIdFromDynamicPath("designs/WC-A1B2C3-dynamic.json"), "WC-A1B2C3");
    assert.strictEqual(deviceIdFromDynamicPath("designs/WC-A1B2C3.png"), null);
    assert.strictEqual(deviceIdFromDynamicPath("designs/WC-A1B2C3-base.png"), null);
    assert.strictEqual(deviceIdFromDynamicPath("other/WC-A1B2C3-dynamic.json"), null);
  });

  await test("processDevice updates .bin/.png from base.png + a countdown dynamic.json", async () => {
    const now = new Date(Date.UTC(2026, 5, 1));
    const bucket = makeFakeBucket({
      "designs/WC-1-dynamic.json": Buffer.from(JSON.stringify({
        type: "countdown", targetDate: "2026-06-11", label: "Trip", x: 396, y: 136, size: 40, fontKey: "serif", outline: false, inverted: false
      })),
      "designs/WC-1-base.png": whitePngBuffer(),
      "designs/WC-1.bin": Buffer.from("stale-placeholder"),
      "designs/WC-1.png": Buffer.from("stale-placeholder")
    });
    const outcome = await processDevice(bucket, "WC-1", now);
    assert.strictEqual(outcome, "updated");
    assert.strictEqual(bucket._store.get("designs/WC-1.bin").length, 26928);
    assert.ok(bucket._store.get("designs/WC-1.png").length > 0);
    // dynamic.json and base.png should still be there for tomorrow's run.
    assert.ok(bucket._store.has("designs/WC-1-dynamic.json"));
    assert.ok(bucket._store.has("designs/WC-1-base.png"));
  });

  await test("processDevice cleans up and stops once a countdown has passed", async () => {
    const now = new Date(Date.UTC(2026, 5, 1));
    const bucket = makeFakeBucket({
      "designs/WC-2-dynamic.json": Buffer.from(JSON.stringify({
        type: "countdown", targetDate: "2026-05-01", label: "", x: 396, y: 136, size: 40, fontKey: "serif", outline: false, inverted: false
      })),
      "designs/WC-2-base.png": whitePngBuffer(),
      "designs/WC-2.bin": Buffer.from("yesterdays-real-bin"),
      "designs/WC-2.png": Buffer.from("yesterdays-real-png")
    });
    const outcome = await processDevice(bucket, "WC-2", now);
    assert.strictEqual(outcome, "expired");
    // The board's last real .bin/.png are untouched -- frozen, not blanked.
    assert.strictEqual(bucket._store.get("designs/WC-2.bin").toString(), "yesterdays-real-bin");
    // But the dynamic-layer bookkeeping files are gone, so this device
    // won't be picked up by future runs.
    assert.ok(!bucket._store.has("designs/WC-2-dynamic.json"));
    assert.ok(!bucket._store.has("designs/WC-2-base.png"));
  });

  await test("a missing base.png for one device doesn't throw past the caller (isolated per-device)", async () => {
    const now = new Date(Date.UTC(2026, 5, 1));
    const bucket = makeFakeBucket({
      "designs/WC-3-dynamic.json": Buffer.from(JSON.stringify({
        type: "countdown", targetDate: "2026-06-11", label: "", x: 396, y: 136, size: 40, fontKey: "serif", outline: false, inverted: false
      }))
      // designs/WC-3-base.png deliberately missing
    });
    await assert.rejects(() => processDevice(bucket, "WC-3", now));
  });

  await test("processDevice updates .bin/.png from base.png + a team dynamic.json (fetch stubbed)", async () => {
    const now = new Date(Date.UTC(2026, 8, 1));
    const schedule = espnSchedule("21", [{ date: "2026-09-08T17:00Z", homeAway: "home", opponentAbbrev: "COWBOYS" }]);
    const bucket = makeFakeBucket({
      "designs/WC-4-dynamic.json": Buffer.from(JSON.stringify({
        type: "team", sport: "football", league: "nfl", teamId: "21", x: 396, y: 136, size: 40, fontKey: "block", outline: true, inverted: false
      })),
      "designs/WC-4-base.png": whitePngBuffer(),
      "designs/WC-4.bin": Buffer.from("stale"),
      "designs/WC-4.png": Buffer.from("stale")
    });
    const outcome = await processDevice(bucket, "WC-4", now, fakeFetchJson(schedule));
    assert.strictEqual(outcome, "updated");
    assert.strictEqual(bucket._store.get("designs/WC-4.bin").length, 26928);
    // A team layer is perpetual -- both bookkeeping files should remain
    // for tomorrow's run, exactly like an active (non-expired) countdown.
    assert.ok(bucket._store.has("designs/WC-4-dynamic.json"));
    assert.ok(bucket._store.has("designs/WC-4-base.png"));
  });

  await test("an ESPN outage for a team layer leaves the board untouched and does NOT clean up", async () => {
    const now = new Date(Date.UTC(2026, 8, 1));
    const bucket = makeFakeBucket({
      "designs/WC-5-dynamic.json": Buffer.from(JSON.stringify({
        type: "team", sport: "football", league: "nfl", teamId: "21", x: 396, y: 136, size: 40, fontKey: "serif", outline: false, inverted: false
      })),
      "designs/WC-5-base.png": whitePngBuffer(),
      "designs/WC-5.bin": Buffer.from("yesterdays-real-bin"),
      "designs/WC-5.png": Buffer.from("yesterdays-real-png")
    });
    await assert.rejects(() => processDevice(bucket, "WC-5", now, fakeFetchJson({}, false)));
    // Nothing should have been touched -- caller (the scheduled function's
    // loop) is the one that catches this and logs it, per-device, without
    // deleting any of this device's files.
    assert.strictEqual(bucket._store.get("designs/WC-5.bin").toString(), "yesterdays-real-bin");
    assert.ok(bucket._store.has("designs/WC-5-dynamic.json"));
    assert.ok(bucket._store.has("designs/WC-5-base.png"));
  });

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
