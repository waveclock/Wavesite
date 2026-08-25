"use strict";

// Exercises astroTimelineProxyHandler directly (fake req/res, stubbed
// global fetch) -- mirrors test/astroProxy.test.js exactly, since the two
// handlers share the same validation/error-shape logic (see the comment
// above astroTimelineProxyHandler in index.js for why they're still two
// separate endpoints).

const assert = require("assert");
const { astroTimelineProxyHandler } = require("../index.js")._internal;

function fakeReq(query) {
  return { query };
}
function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
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
  await test("rejects an out-of-range/missing lat or lon", async () => {
    const res = fakeRes();
    await astroTimelineProxyHandler(fakeReq({ lat: "999", lon: "-74.5", stationId: "8534720" }), res);
    assert.strictEqual(res.statusCode, 400);

    const res2 = fakeRes();
    await astroTimelineProxyHandler(fakeReq({ lon: "-74.5", stationId: "8534720" }), res2);
    assert.strictEqual(res2.statusCode, 400);
  });

  await test("rejects a non-numeric stationId (not a passthrough for arbitrary strings)", async () => {
    const res = fakeRes();
    await astroTimelineProxyHandler(fakeReq({ lat: "39.27", lon: "-74.57", stationId: "not-a-station" }), res);
    assert.strictEqual(res.statusCode, 400);
  });

  await test("a real NOAA outage returns 502, not a crash", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error("network down"); };
    try {
      const res = fakeRes();
      await astroTimelineProxyHandler(fakeReq({ lat: "39.27", lon: "-74.57", stationId: "8534720" }), res);
      assert.strictEqual(res.statusCode, 502);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test("a NOAA station with no predictions data (e.g. a time-only subordinate station) returns 422 with an actionable message, not the generic 502", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({ json: async () => ({ error: { message: "No Predictions data was found. Please make sure the Datum input is valid." } }) });
    try {
      const res = fakeRes();
      await astroTimelineProxyHandler(fakeReq({ lat: "39.2788685", lon: "-74.5762507", stationId: "8534975" }), res);
      assert.strictEqual(res.statusCode, 422);
      assert.match(res.body.error, /doesn't have full predictions/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test("valid inputs return 200 with the assembled payload (hi/lo tides + moon events, no continuous curve)", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      json: async () => ({
        predictions: [
          { t: "2026-07-15 02:10", v: "0.40", type: "L" },
          { t: "2026-07-15 08:25", v: "4.10", type: "H" }
        ]
      })
    });
    try {
      const res = fakeRes();
      await astroTimelineProxyHandler(fakeReq({ lat: "39.27", lon: "-74.57", stationId: "8534720" }), res);
      assert.strictEqual(res.statusCode, 200);
      assert.ok(res.body.moonPhase && typeof res.body.moonPhase.phaseName === "string");
      assert.ok(Array.isArray(res.body.moonEvents));
      assert.ok(Array.isArray(res.body.tideExtrema));
      assert.strictEqual(res.body.tideCurve, undefined);
      assert.ok(typeof res.body.dayStart === "string" && typeof res.body.dayEnd === "string");
    } finally {
      global.fetch = originalFetch;
    }
  });

  console.log(passed + " passed, " + failed + " failed");
  if (failed > 0) process.exit(1);
})();
