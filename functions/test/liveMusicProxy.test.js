"use strict";

// Exercises liveMusicProxyHandler directly (fake req/res, stubbed global
// fetch) -- same pattern as test/beachFlagProxy.test.js.

const assert = require("assert");
const { liveMusicProxyHandler } = require("../index.js")._internal;

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

const SAMPLE_DEVICE_PAYLOAD = {
  gen: "2026-09-02T21:32:10-05:00",
  music: [{ s: "5:30P", e: "9:00P", r: "5:30-9:00P", v: "Red Bar", a: "The Red Bar Jazz Band" }],
  music_total: 11,
  stale: { flag: false, music: false }
};

(async () => {
  await test("no query params needed at all -- unlike beachFlagProxy, nothing here is per-device", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: true, status: 200, json: async () => SAMPLE_DEVICE_PAYLOAD });
    try {
      const res = fakeRes();
      await liveMusicProxyHandler(fakeReq({}), res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.events[0].venue, "Red Bar");
      assert.strictEqual(res.body.totalToday, 11);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test("a Beach API outage returns 502, not a crash", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error("network down"); };
    try {
      const res = fakeRes();
      await liveMusicProxyHandler(fakeReq({}), res);
      assert.strictEqual(res.statusCode, 502);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test("an upstream non-ok response also returns 502", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 503 });
    try {
      const res = fakeRes();
      await liveMusicProxyHandler(fakeReq({}), res);
      assert.strictEqual(res.statusCode, 502);
    } finally {
      global.fetch = originalFetch;
    }
  });

  console.log(passed + " passed, " + failed + " failed");
  if (failed > 0) process.exit(1);
})();
