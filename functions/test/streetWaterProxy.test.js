"use strict";

// Exercises streetWaterProxyHandler directly (fake req/res, stubbed
// global fetch) -- same pattern as test/hurricaneTrackerProxy.test.js.
// Unlike that proxy, fetchStreetWaterData never throws on an
// unreachable/failing upstream (see lib/streetWater.js's own header
// comment -- it degrades to a seriesUnavailable/null result instead),
// so there's no "upstream down -> 502" case to test here the way
// hurricaneTrackerProxy has one; 502 is reserved for a genuine
// programming error, not an ordinary missing-feed day.

const assert = require("assert");
const { streetWaterProxyHandler } = require("../index.js")._internal;

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
  await test("requires lat/lon -- no locationless fallback, same as hurricaneTrackerProxy", async () => {
    const res = fakeRes();
    await streetWaterProxyHandler(fakeReq({}), res);
    assert.strictEqual(res.statusCode, 400);
  });

  await test("rejects an out-of-range lat/lon", async () => {
    const res = fakeRes();
    await streetWaterProxyHandler(fakeReq({ lat: "999", lon: "-87" }), res);
    assert.strictEqual(res.statusCode, 400);
  });

  await test("a location far from every configured town returns 200 with a null body (not available here), not an error", async () => {
    const res = fakeRes();
    await streetWaterProxyHandler(fakeReq({ lat: "40.2171", lon: "-74.7429" }), res); // Trenton, NJ
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body, null);
  });

  await test("Ocean City with every upstream unreachable returns 200 with seriesUnavailable: true, not an error", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 500 });
    try {
      const res = fakeRes();
      await streetWaterProxyHandler(fakeReq({ lat: "39.2776", lon: "-74.5746" }), res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.seriesUnavailable, true);
      assert.strictEqual(res.body.town, "ocean-city-nj");
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test("every upstream being totally unreachable still returns 200, not 502 -- degrade, don't fail the preview", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error("network down"); };
    try {
      const res = fakeRes();
      await streetWaterProxyHandler(fakeReq({ lat: "39.2776", lon: "-74.5746" }), res);
      assert.strictEqual(res.statusCode, 200);
    } finally {
      global.fetch = originalFetch;
    }
  });

  console.log(passed + " passed, " + failed + " failed");
  if (failed > 0) process.exit(1);
})();
