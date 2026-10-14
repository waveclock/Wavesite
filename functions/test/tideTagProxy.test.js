"use strict";

// Exercises tideTagProxyHandler directly (fake req/res, a fully
// in-memory fake bucket injected as bucketImpl) -- no live GCS call,
// same approach as test/orchestration.test.js's makeFakeBucket, extended
// to honor preconditionOpts.ifGenerationMatch the way saveTideTag relies
// on (see test/tideTag.test.js's own copy of this fake for why).

const assert = require("assert");
const { tideTagProxyHandler } = require("../index.js")._internal;

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
      async save(data, options) {
        const wantsCreateOnly = options && options.preconditionOpts && options.preconditionOpts.ifGenerationMatch === 0;
        if (wantsCreateOnly && store.has(path)) {
          const err = new Error("precondition failed");
          err.code = 412;
          throw err;
        }
        store.set(path, data);
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
  return { file: fileHandle, _store: store };
}

function fakeReq({ method = "GET", query = {}, body = {} } = {}) {
  return { method, query, body };
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
  console.log("tideTagProxy: GET");
  await test("an unregistered tag returns registered:false", async () => {
    const req = fakeReq({ method: "GET", query: { tagId: "A7K2" } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, makeFakeBucket({}));
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { registered: false });
  });
  await test("a registered tag returns its station, not internal fields like createdAt", async () => {
    const req = fakeReq({ method: "GET", query: { tagId: "A7K2" } });
    const res = fakeRes();
    const bucket = makeFakeBucket({ "tide-tags/A7K2.json": JSON.stringify({ stationId: "8536110", stationName: "Atlantic City, NJ", createdAt: "2026-01-01T00:00:00.000Z" }) });
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { registered: true, stationId: "8536110", stationName: "Atlantic City, NJ" });
  });
  await test("includes lat/lon when the stored record has them", async () => {
    const req = fakeReq({ method: "GET", query: { tagId: "A7K2" } });
    const res = fakeRes();
    const bucket = makeFakeBucket({ "tide-tags/A7K2.json": JSON.stringify({ stationId: "8536110", stationName: "Atlantic City, NJ", createdAt: "x", lat: 39.355, lon: -74.4183 }) });
    await tideTagProxyHandler(req, res, bucket);
    assert.deepStrictEqual(res.body, { registered: true, stationId: "8536110", stationName: "Atlantic City, NJ", lat: 39.355, lon: -74.4183 });
  });
  await test("rejects a missing tagId", async () => {
    const req = fakeReq({ method: "GET", query: {} });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, makeFakeBucket({}));
    assert.strictEqual(res.statusCode, 400);
  });
  await test("rejects a malformed tagId (not just a passthrough into the storage path)", async () => {
    const req = fakeReq({ method: "GET", query: { tagId: "../../secrets" } });
    const res = fakeRes();
    const bucket = makeFakeBucket({});
    bucket.file = () => { throw new Error("must never reach storage with an invalid tagId"); };
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 400);
  });
  await test("a genuine storage failure returns 502, not a crash", async () => {
    const req = fakeReq({ method: "GET", query: { tagId: "A7K2" } });
    const res = fakeRes();
    const bucket = { file: () => ({ async download() { const e = new Error("down"); e.code = 500; throw e; } }) };
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 502);
  });

  console.log("tideTagProxy: POST");
  await test("registers a brand-new tag and returns 201 with its station", async () => {
    const bucket = makeFakeBucket({});
    const req = fakeReq({ method: "POST", body: { tagId: "A7K2", stationId: "8536110", stationName: "Atlantic City, NJ" } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 201);
    assert.deepStrictEqual(res.body, { registered: true, stationId: "8536110", stationName: "Atlantic City, NJ" });
    assert.ok(bucket._store.has("tide-tags/A7K2.json"));
  });
  await test("accepts and returns lat/lon when given", async () => {
    const bucket = makeFakeBucket({});
    const req = fakeReq({ method: "POST", body: { tagId: "A7K2", stationId: "8536110", stationName: "Atlantic City, NJ", lat: 39.355, lon: -74.4183 } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.deepStrictEqual(res.body, { registered: true, stationId: "8536110", stationName: "Atlantic City, NJ", lat: 39.355, lon: -74.4183 });
  });
  await test("registering without lat/lon still succeeds -- they're a nice-to-have, not required", async () => {
    const bucket = makeFakeBucket({});
    const req = fakeReq({ method: "POST", body: { tagId: "A7K2", stationId: "8536110", stationName: "Atlantic City, NJ" } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 201);
  });
  await test("refuses to re-register an already-registered tag -- 409, original untouched", async () => {
    const bucket = makeFakeBucket({ "tide-tags/A7K2.json": JSON.stringify({ stationId: "ORIGINAL", stationName: "First Beach", createdAt: "x" }) });
    const req = fakeReq({ method: "POST", body: { tagId: "A7K2", stationId: "9999999", stationName: "Different Beach" } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(JSON.parse(bucket._store.get("tide-tags/A7K2.json")).stationId, "ORIGINAL");
  });
  await test("rejects a malformed tagId without ever writing to storage", async () => {
    const bucket = makeFakeBucket({});
    bucket.file = () => { throw new Error("must never reach storage with an invalid tagId"); };
    const req = fakeReq({ method: "POST", body: { tagId: "bad id", stationId: "8536110", stationName: "Somewhere" } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 400);
  });
  await test("rejects a non-NOAA-shaped stationId", async () => {
    const bucket = makeFakeBucket({});
    const req = fakeReq({ method: "POST", body: { tagId: "A7K2", stationId: "not-a-number", stationName: "Somewhere" } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(bucket._store.size, 0);
  });
  await test("rejects a missing/blank stationName", async () => {
    const bucket = makeFakeBucket({});
    const req = fakeReq({ method: "POST", body: { tagId: "A7K2", stationId: "8536110", stationName: "   " } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(bucket._store.size, 0);
  });
  await test("a genuine storage failure returns 502, not a crash", async () => {
    const bucket = { file: () => ({ async save() { const e = new Error("quota"); e.code = 500; throw e; } }) };
    const req = fakeReq({ method: "POST", body: { tagId: "A7K2", stationId: "8536110", stationName: "Somewhere" } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 502);
  });

  console.log("tideTagProxy: PUT (explicit 'Change beach' overwrite)");
  await test("overwrites an already-registered tag's station and returns 200", async () => {
    const bucket = makeFakeBucket({ "tide-tags/A7K2.json": JSON.stringify({ stationId: "ORIGINAL", stationName: "First Beach", createdAt: "x" }) });
    const req = fakeReq({ method: "PUT", body: { tagId: "A7K2", stationId: "8536110", stationName: "Different Beach" } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { registered: true, stationId: "8536110", stationName: "Different Beach" });
    assert.strictEqual(JSON.parse(bucket._store.get("tide-tags/A7K2.json")).stationId, "8536110");
  });
  await test("accepts and returns the new lat/lon when given", async () => {
    const bucket = makeFakeBucket({ "tide-tags/A7K2.json": JSON.stringify({ stationId: "ORIGINAL", stationName: "First Beach", createdAt: "x", lat: 10, lon: 20 }) });
    const req = fakeReq({ method: "PUT", body: { tagId: "A7K2", stationId: "8536110", stationName: "Different Beach", lat: 39.355, lon: -74.4183 } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.deepStrictEqual(res.body, { registered: true, stationId: "8536110", stationName: "Different Beach", lat: 39.355, lon: -74.4183 });
  });
  await test("also works to register a brand-new tag (never 409s, unlike POST)", async () => {
    const bucket = makeFakeBucket({});
    const req = fakeReq({ method: "PUT", body: { tagId: "A7K2", stationId: "8536110", stationName: "Somewhere" } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 200);
  });
  await test("rejects a malformed tagId without ever writing to storage", async () => {
    const bucket = makeFakeBucket({});
    bucket.file = () => { throw new Error("must never reach storage with an invalid tagId"); };
    const req = fakeReq({ method: "PUT", body: { tagId: "bad id", stationId: "8536110", stationName: "Somewhere" } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 400);
  });
  await test("rejects a non-NOAA-shaped stationId", async () => {
    const bucket = makeFakeBucket({});
    const req = fakeReq({ method: "PUT", body: { tagId: "A7K2", stationId: "nope", stationName: "Somewhere" } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(bucket._store.size, 0);
  });
  await test("a genuine storage failure returns 502, not a crash", async () => {
    const bucket = { file: () => ({ async save() { const e = new Error("quota"); e.code = 500; throw e; } }) };
    const req = fakeReq({ method: "PUT", body: { tagId: "A7K2", stationId: "8536110", stationName: "Somewhere" } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 502);
  });

  console.log("tideTagProxy: DELETE");
  await test("unlinks a registered tag", async () => {
    const bucket = makeFakeBucket({ "tide-tags/A7K2.json": JSON.stringify({ stationId: "8536110", stationName: "X", createdAt: "x" }) });
    const req = fakeReq({ method: "DELETE", query: { tagId: "A7K2" } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(bucket._store.has("tide-tags/A7K2.json"), false);
  });
  await test("unlinking an already-unregistered tag still returns 200 (a no-op, not an error)", async () => {
    const bucket = makeFakeBucket({});
    const req = fakeReq({ method: "DELETE", query: { tagId: "A7K2" } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 200);
  });
  await test("rejects a malformed tagId", async () => {
    const bucket = makeFakeBucket({});
    bucket.file = () => { throw new Error("must never reach storage with an invalid tagId"); };
    const req = fakeReq({ method: "DELETE", query: { tagId: "../x" } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 400);
  });

  console.log("tideTagProxy: method handling");
  await test("rejects any other HTTP method", async () => {
    const req = fakeReq({ method: "PATCH", query: { tagId: "A7K2" } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, makeFakeBucket({}));
    assert.strictEqual(res.statusCode, 405);
  });

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
