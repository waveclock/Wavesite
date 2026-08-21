"use strict";

// Exercises astroProxyHandler directly (fake req/res, stubbed global
// fetch) -- see test/espnProxy.test.js for the same pattern.

const assert = require("assert");
const { astroProxyHandler } = require("../index.js")._internal;

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
    await astroProxyHandler(fakeReq({ lat: "999", lon: "-74.5", stationId: "8534720" }), res);
    assert.strictEqual(res.statusCode, 400);

    const res2 = fakeRes();
    await astroProxyHandler(fakeReq({ lon: "-74.5", stationId: "8534720" }), res2);
    assert.strictEqual(res2.statusCode, 400);
  });

  await test("rejects a non-numeric stationId (not a passthrough for arbitrary strings)", async () => {
    const res = fakeRes();
    await astroProxyHandler(fakeReq({ lat: "39.27", lon: "-74.57", stationId: "not-a-station" }), res);
    assert.strictEqual(res.statusCode, 400);
  });

  await test("a real NOAA outage returns 502, not a crash", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error("network down"); };
    try {
      const res = fakeRes();
      await astroProxyHandler(fakeReq({ lat: "39.27", lon: "-74.57", stationId: "8534720" }), res);
      assert.strictEqual(res.statusCode, 502);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test("valid inputs return 200 with the assembled payload", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({ json: async () => ({ predictions: [{ t: "2026-07-15 12:00", v: "2.10" }] }) });
    try {
      const res = fakeRes();
      await astroProxyHandler(fakeReq({ lat: "39.27", lon: "-74.57", stationId: "8534720" }), res);
      assert.strictEqual(res.statusCode, 200);
      assert.ok(res.body.moon && typeof res.body.moon.phaseName === "string");
      assert.ok(Array.isArray(res.body.tideCurve));
    } finally {
      global.fetch = originalFetch;
    }
  });

  console.log(passed + " passed, " + failed + " failed");
  if (failed > 0) process.exit(1);
})();
