"use strict";

// Exercises coastlineProxyHandler directly (fake req/res, an injected
// fetchImpl, and a fully in-memory fake bucket injected as bucketImpl --
// same makeFakeBucket shape as test/tideTagProxy.test.js's own copy,
// used here to exercise lib/coastlineCache.js's read-through cache
// without ever touching real Cloud Storage).

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

function makeFakeBucket(initialFiles) {
  const store = new Map(Object.entries(initialFiles || {}));
  function fileHandle(path) {
    return {
      path,
      async download() {
        if (!store.has(path)) {
          const err = new Error("not found");
          err.code = 404;
          throw err;
        }
        return [Buffer.from(store.get(path), "utf8")];
      },
      async save(data) {
        store.set(path, data);
      }
    };
  }
  return { file: fileHandle, _store: store };
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
    await coastlineProxyHandler(fakeReq({ lat: "39.2776", lon: "-74.5746" }), res, fakeFetch, makeFakeBucket({}));
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, REAL_COASTLINE_DATA);
  });

  await test("every mirror failing returns 502, not a crash", async () => {
    const res = fakeRes();
    const fakeFetch = async () => ({ ok: false, status: 500 });
    await coastlineProxyHandler(fakeReq({ lat: "39.2776", lon: "-74.5746" }), res, fakeFetch, makeFakeBucket({}));
    assert.strictEqual(res.statusCode, 502);
  });

  await test("a thrown network error also returns 502", async () => {
    const res = fakeRes();
    const fakeFetch = async () => { throw new Error("network down"); };
    await coastlineProxyHandler(fakeReq({ lat: "39.2776", lon: "-74.5746" }), res, fakeFetch, makeFakeBucket({}));
    assert.strictEqual(res.statusCode, 502);
  });

  await test("a cache hit returns the stored data WITHOUT ever calling fetchImpl", async () => {
    const res = fakeRes();
    let fetchCalled = false;
    const fakeFetch = async () => { fetchCalled = true; return { ok: true, json: async () => REAL_COASTLINE_DATA }; };
    const bucket = makeFakeBucket({ "coastline-cache/39.28_-74.57.json": JSON.stringify(REAL_COASTLINE_DATA) });
    await coastlineProxyHandler(fakeReq({ lat: "39.2776", lon: "-74.5746" }), res, fakeFetch, bucket);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, REAL_COASTLINE_DATA);
    assert.strictEqual(fetchCalled, false);
  });

  await test("a successful live lookup gets written to the cache for next time", async () => {
    const res = fakeRes();
    const fakeFetch = async () => ({ ok: true, json: async () => REAL_COASTLINE_DATA });
    const bucket = makeFakeBucket({});
    await coastlineProxyHandler(fakeReq({ lat: "39.2776", lon: "-74.5746" }), res, fakeFetch, bucket);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(bucket._store.get("coastline-cache/39.28_-74.57.json")), REAL_COASTLINE_DATA);
  });

  await test("a failed live lookup is NOT cached -- a later request gets to try again", async () => {
    const res = fakeRes();
    const fakeFetch = async () => ({ ok: false, status: 500 });
    const bucket = makeFakeBucket({});
    await coastlineProxyHandler(fakeReq({ lat: "39.2776", lon: "-74.5746" }), res, fakeFetch, bucket);
    assert.strictEqual(res.statusCode, 502);
    assert.strictEqual(bucket._store.size, 0);
  });

  await test("a cache read failure falls through to a live lookup instead of erroring", async () => {
    const res = fakeRes();
    const fakeFetch = async () => ({ ok: true, json: async () => REAL_COASTLINE_DATA });
    const bucket = { file: () => ({ async download() { throw new Error("storage hiccup"); }, async save() {} }) };
    await coastlineProxyHandler(fakeReq({ lat: "39.2776", lon: "-74.5746" }), res, fakeFetch, bucket);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, REAL_COASTLINE_DATA);
  });

  await test("a cache write failure never surfaces -- the client still gets its real answer", async () => {
    const res = fakeRes();
    const fakeFetch = async () => ({ ok: true, json: async () => REAL_COASTLINE_DATA });
    const bucket = { file: () => ({ async download() { const e = new Error("not found"); e.code = 404; throw e; }, async save() { throw new Error("write failed"); } }) };
    await coastlineProxyHandler(fakeReq({ lat: "39.2776", lon: "-74.5746" }), res, fakeFetch, bucket);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, REAL_COASTLINE_DATA);
  });

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
