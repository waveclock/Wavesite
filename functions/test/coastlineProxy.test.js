"use strict";

// Exercises coastlineProxyHandler directly (fake req/res, an injected
// fetchImpl) -- same pattern as test/tideTagProxy.test.js's bucketImpl
// injection.

const assert = require("assert");
const { coastlineProxyHandler } = require("../index.js")._internal;

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

const REAL_COASTLINE_DATA = { elements: [{ type: "node", id: 1, lat: 39.26, lon: -74.58 }] };

(async () => {
  await test("requires lat/lon", async () => {
    const res = fakeRes();
    await coastlineProxyHandler(fakeReq({}), res);
    assert.strictEqual(res.statusCode, 400);
  });

  await test("rejects an out-of-range lat/lon", async () => {
    const res = fakeRes();
    await coastlineProxyHandler(fakeReq({ lat: "999", lon: "-87" }), res);
    assert.strictEqual(res.statusCode, 400);
  });

  await test("returns the Overpass response unchanged on success", async () => {
    const res = fakeRes();
    const fakeFetch = async () => ({ ok: true, json: async () => REAL_COASTLINE_DATA });
    await coastlineProxyHandler(fakeReq({ lat: "39.2776", lon: "-74.5746" }), res, fakeFetch);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, REAL_COASTLINE_DATA);
  });

  await test("every mirror failing returns 502, not a crash", async () => {
    const res = fakeRes();
    const fakeFetch = async () => ({ ok: false, status: 500 });
    await coastlineProxyHandler(fakeReq({ lat: "39.2776", lon: "-74.5746" }), res, fakeFetch);
    assert.strictEqual(res.statusCode, 502);
  });

  await test("a thrown network error also returns 502", async () => {
    const res = fakeRes();
    const fakeFetch = async () => { throw new Error("network down"); };
    await coastlineProxyHandler(fakeReq({ lat: "39.2776", lon: "-74.5746" }), res, fakeFetch);
    assert.strictEqual(res.statusCode, 502);
  });

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
