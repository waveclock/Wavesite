"use strict";

// Exercises hurricaneTrackerProxyHandler directly (fake req/res, stubbed
// global fetch) -- same pattern as test/ocnjEventsProxy.test.js and
// test/beachFlagProxy.test.js.

const assert = require("assert");
const { hurricaneTrackerProxyHandler } = require("../index.js")._internal;

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

const NO_ACTIVE_STORMS = { activeStorms: [] };

(async () => {
  await test("requires lat/lon -- unlike ocnjEventsProxy/liveMusicProxy, there's no locationless fallback", async () => {
    const res = fakeRes();
    await hurricaneTrackerProxyHandler(fakeReq({}), res);
    assert.strictEqual(res.statusCode, 400);
  });

  await test("rejects an out-of-range lat/lon (not just a passthrough relay)", async () => {
    const res = fakeRes();
    await hurricaneTrackerProxyHandler(fakeReq({ lat: "999", lon: "-87" }), res);
    assert.strictEqual(res.statusCode, 400);
  });

  await test("valid lat/lon with no active storms returns 200 and noActiveStorm: true", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: true, status: 200, json: async () => NO_ACTIVE_STORMS });
    try {
      const res = fakeRes();
      await hurricaneTrackerProxyHandler(fakeReq({ lat: "30.246", lon: "-87.7008", townName: "Gulf Shores, AL" }), res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.noActiveStorm, true);
      assert.strictEqual(res.body.townName, "Gulf Shores, AL");
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test("NHC being unreachable returns 502, not a crash", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error("network down"); };
    try {
      const res = fakeRes();
      await hurricaneTrackerProxyHandler(fakeReq({ lat: "30.246", lon: "-87.7008" }), res);
      assert.strictEqual(res.statusCode, 502);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test("an upstream non-ok response also returns 502", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 500 });
    try {
      const res = fakeRes();
      await hurricaneTrackerProxyHandler(fakeReq({ lat: "30.246", lon: "-87.7008" }), res);
      assert.strictEqual(res.statusCode, 502);
    } finally {
      global.fetch = originalFetch;
    }
  });

  console.log(passed + " passed, " + failed + " failed");
  if (failed > 0) process.exit(1);
})();
