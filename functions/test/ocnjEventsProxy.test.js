"use strict";

// Exercises ocnjEventsProxyHandler directly (fake req/res, stubbed global
// fetch) -- same pattern as test/liveMusicProxy.test.js.

const assert = require("assert");
const { ocnjEventsProxyHandler } = require("../index.js")._internal;

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

const SAMPLE_PAYLOAD = {
  generated_at: new Date().toISOString(),
  days: [{ date: new Date().toISOString().slice(0, 10), events: [{ title: "Farmers Market", time: "8:00 AM", location: "Ocean City Tabernacle" }] }]
};

(async () => {
  await test("no query params needed at all -- unlike beachFlagProxy, nothing here is per-device", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: true, status: 200, json: async () => SAMPLE_PAYLOAD });
    try {
      const res = fakeRes();
      await ocnjEventsProxyHandler(fakeReq({}), res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(Array.isArray(res.body.events), true);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test("the published data being unreachable returns 502, not a crash", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error("network down"); };
    try {
      const res = fakeRes();
      await ocnjEventsProxyHandler(fakeReq({}), res);
      assert.strictEqual(res.statusCode, 502);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test("an upstream non-ok response also returns 502", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 404 });
    try {
      const res = fakeRes();
      await ocnjEventsProxyHandler(fakeReq({}), res);
      assert.strictEqual(res.statusCode, 502);
    } finally {
      global.fetch = originalFetch;
    }
  });

  console.log(passed + " passed, " + failed + " failed");
  if (failed > 0) process.exit(1);
})();
