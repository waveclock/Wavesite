"use strict";

// Exercises tideTagProxyHandler and mintTideTagBatchHandler directly
// (fake req/res, a fully in-memory fake bucket injected as bucketImpl)
// -- no live GCS call, same approach as test/orchestration.test.js's
// makeFakeBucket, extended to honor preconditionOpts.ifGenerationMatch
// the way saveTideTag/mintTagIds rely on (see test/tideTag.test.js's
// own copy of this fake for why).

const assert = require("assert");
const { tideTagProxyHandler, pairTideTagHandler, requestPairCodeHandler, redeemPairCodeHandler, deviceLinkStatusHandler, unpairDeviceHandler, mintTideTagBatchHandler, backfillDeviceTagLinksHandler } = require("../index.js")._internal;

// A valid, in-charset tagId at the new 20-char default length -- used
// everywhere a test just needs SOME real tagId, same role "A7K2" played
// before IDs got long enough to need no human-readability at all.
const T1 = "AAAAAAAAAABBBBBBBBBB"; // 20 chars
const T2 = "CCCCCCCCCCDDDDDDDDDD"; // 20 chars, distinct from T1

function makeFakeBucket(initialFiles) {
  const store = new Map(Object.entries(initialFiles || {}));
  function fileHandle(path) {
    return {
      path,
      name: path, // mirrors the real @google-cloud/storage File's own .name, which backfillDeviceTagLinks reads off a getFiles() result
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
  return {
    file: fileHandle,
    async getFiles(opts) {
      const prefix = (opts && opts.prefix) || "";
      const names = Array.from(store.keys()).filter((k) => k.startsWith(prefix));
      return [names.map(fileHandle)];
    },
    _store: store
  };
}

// A bucket that already has tagId on the mint allowlist -- the
// precondition every successful POST/PUT test below now needs, since a
// tagId can't register at all (regardless of how well-formed it is)
// unless something minted it first. Real-world equivalent: a batch
// generateTagIds.js already registered via mintTideTagBatch.
function mintedBucket(tagId, initialFiles) {
  return makeFakeBucket(Object.assign({ ["tide-tag-allowlist/" + tagId + ".json"]: JSON.stringify({ mintedAt: "x" }) }, initialFiles));
}

function fakeReq({ method = "GET", query = {}, body = {}, headers = {} } = {}) {
  return { method, query, body, headers };
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
    const req = fakeReq({ method: "GET", query: { tagId: T1 } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, makeFakeBucket({}));
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { registered: false });
  });
  await test("a registered tag returns its station, not internal fields like createdAt", async () => {
    const req = fakeReq({ method: "GET", query: { tagId: T1 } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, makeFakeBucket({ ["tide-tags/" + T1 + ".json"]: JSON.stringify({ stationId: "8536110", stationName: "Atlantic City, NJ", createdAt: "2026-01-01T00:00:00.000Z" }) }));
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { registered: true, stationId: "8536110", stationName: "Atlantic City, NJ" });
  });
  await test("a tag that's linked to a WaveClock but never separately registered returns registered:false plus linkedDeviceId", async () => {
    const req = fakeReq({ method: "GET", query: { tagId: T1 } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, makeFakeBucket({ ["tide-tags/" + T1 + ".json"]: JSON.stringify({ linkedDeviceId: "WC-1", linkedAt: "x" }) }));
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { registered: false, linkedDeviceId: "WC-1" });
  });
  await test("a tag with its own standalone station that's ALSO linked returns both -- the client is expected to prefer the link", async () => {
    const req = fakeReq({ method: "GET", query: { tagId: T1 } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, makeFakeBucket({ ["tide-tags/" + T1 + ".json"]: JSON.stringify({ stationId: "8536110", stationName: "Wildwood Crest, NJ", createdAt: "x", linkedDeviceId: "WC-1", linkedAt: "x" }) }));
    assert.deepStrictEqual(res.body, { registered: true, stationId: "8536110", stationName: "Wildwood Crest, NJ", linkedDeviceId: "WC-1" });
  });
  await test("includes lat/lon when the stored record has them", async () => {
    const req = fakeReq({ method: "GET", query: { tagId: T1 } });
    const res = fakeRes();
    const bucket = makeFakeBucket({ ["tide-tags/" + T1 + ".json"]: JSON.stringify({ stationId: "8536110", stationName: "Atlantic City, NJ", createdAt: "x", lat: 39.355, lon: -74.4183 }) });
    await tideTagProxyHandler(req, res, bucket);
    assert.deepStrictEqual(res.body, { registered: true, stationId: "8536110", stationName: "Atlantic City, NJ", lat: 39.355, lon: -74.4183 });
  });
  await test("includes townName (the user's picked display name) when the stored record has it", async () => {
    const req = fakeReq({ method: "GET", query: { tagId: T1 } });
    const res = fakeRes();
    const bucket = makeFakeBucket({ ["tide-tags/" + T1 + ".json"]: JSON.stringify({ stationId: "8534720", stationName: "Ventnor, NJ", createdAt: "x", townName: "Ocean City, NJ" }) });
    await tideTagProxyHandler(req, res, bucket);
    assert.deepStrictEqual(res.body, { registered: true, stationId: "8534720", stationName: "Ventnor, NJ", townName: "Ocean City, NJ" });
  });
  await test("includes coastFacingDirection/srfZone/marineZone when the stored record has them", async () => {
    const req = fakeReq({ method: "GET", query: { tagId: T1 } });
    const res = fakeRes();
    const bucket = makeFakeBucket({ ["tide-tags/" + T1 + ".json"]: JSON.stringify({ stationId: "8534720", stationName: "Ventnor, NJ", createdAt: "x", coastFacingDirection: "E", srfZone: "NJZ024", marineZone: "ANZ453" }) });
    await tideTagProxyHandler(req, res, bucket);
    assert.deepStrictEqual(res.body, { registered: true, stationId: "8534720", stationName: "Ventnor, NJ", coastFacingDirection: "E", srfZone: "NJZ024", marineZone: "ANZ453" });
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
  await test("rejects a well-formed but too-short tagId -- the OLD 4-6 char scheme no longer works at all", async () => {
    const req = fakeReq({ method: "GET", query: { tagId: "ABCD" } });
    const res = fakeRes();
    const bucket = makeFakeBucket({});
    bucket.file = () => { throw new Error("must never reach storage with an invalid tagId"); };
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 400);
  });
  await test("a genuine storage failure returns 502, not a crash", async () => {
    const req = fakeReq({ method: "GET", query: { tagId: T1 } });
    const res = fakeRes();
    const bucket = { file: () => ({ async download() { const e = new Error("down"); e.code = 500; throw e; } }) };
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 502);
  });

  console.log("tideTagProxy: POST");
  await test("registers a brand-new, already-minted tag and returns 201 with its station", async () => {
    const bucket = mintedBucket(T1);
    const req = fakeReq({ method: "POST", body: { tagId: T1, stationId: "8536110", stationName: "Atlantic City, NJ" } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 201);
    assert.deepStrictEqual(res.body, { registered: true, stationId: "8536110", stationName: "Atlantic City, NJ" });
    assert.ok(bucket._store.has("tide-tags/" + T1 + ".json"));
  });
  await test("accepts and returns lat/lon when given", async () => {
    const bucket = mintedBucket(T1);
    const req = fakeReq({ method: "POST", body: { tagId: T1, stationId: "8536110", stationName: "Atlantic City, NJ", lat: 39.355, lon: -74.4183 } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.deepStrictEqual(res.body, { registered: true, stationId: "8536110", stationName: "Atlantic City, NJ", lat: 39.355, lon: -74.4183 });
  });
  await test("registering without lat/lon still succeeds -- they're a nice-to-have, not required", async () => {
    const bucket = mintedBucket(T1);
    const req = fakeReq({ method: "POST", body: { tagId: T1, stationId: "8536110", stationName: "Atlantic City, NJ" } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 201);
  });
  await test("accepts and returns townName (the picked town) alongside the NOAA station's own name", async () => {
    const bucket = mintedBucket(T1);
    const req = fakeReq({ method: "POST", body: { tagId: T1, stationId: "8534720", stationName: "Ventnor, NJ", lat: 39.355, lon: -74.4183, townName: "Ocean City, NJ" } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.deepStrictEqual(res.body, { registered: true, stationId: "8534720", stationName: "Ventnor, NJ", lat: 39.355, lon: -74.4183, townName: "Ocean City, NJ" });
  });
  await test("registering without townName still succeeds -- an older client just won't send one", async () => {
    const bucket = mintedBucket(T1);
    const req = fakeReq({ method: "POST", body: { tagId: T1, stationId: "8536110", stationName: "Atlantic City, NJ" } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual("townName" in res.body, false);
  });
  await test("accepts and returns coastFacingDirection/srfZone/marineZone when given", async () => {
    const bucket = mintedBucket(T1);
    const req = fakeReq({ method: "POST", body: { tagId: T1, stationId: "8534720", stationName: "Ventnor, NJ", lat: 39.355, lon: -74.4183, townName: "Ocean City, NJ", coastFacingDirection: "E", srfZone: "NJZ024", marineZone: "ANZ453" } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.deepStrictEqual(res.body, { registered: true, stationId: "8534720", stationName: "Ventnor, NJ", lat: 39.355, lon: -74.4183, townName: "Ocean City, NJ", coastFacingDirection: "E", srfZone: "NJZ024", marineZone: "ANZ453" });
  });
  await test("registering without coastFacingDirection/srfZone/marineZone still succeeds -- they're resolved best-effort, not required", async () => {
    const bucket = mintedBucket(T1);
    const req = fakeReq({ method: "POST", body: { tagId: T1, stationId: "8536110", stationName: "Atlantic City, NJ" } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual("coastFacingDirection" in res.body, false);
    assert.strictEqual("srfZone" in res.body, false);
    assert.strictEqual("marineZone" in res.body, false);
  });
  await test("refuses to re-register an already-registered tag -- 409, original untouched", async () => {
    const bucket = mintedBucket(T1, { ["tide-tags/" + T1 + ".json"]: JSON.stringify({ stationId: "ORIGINAL", stationName: "First Beach", createdAt: "x" }) });
    const req = fakeReq({ method: "POST", body: { tagId: T1, stationId: "9999999", stationName: "Different Beach" } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(JSON.parse(bucket._store.get("tide-tags/" + T1 + ".json")).stationId, "ORIGINAL");
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
    const bucket = mintedBucket(T1);
    const req = fakeReq({ method: "POST", body: { tagId: T1, stationId: "not-a-number", stationName: "Somewhere" } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(bucket._store.has("tide-tags/" + T1 + ".json"), false);
  });
  await test("rejects a missing/blank stationName", async () => {
    const bucket = mintedBucket(T1);
    const req = fakeReq({ method: "POST", body: { tagId: T1, stationId: "8536110", stationName: "   " } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(bucket._store.has("tide-tags/" + T1 + ".json"), false);
  });
  await test("a genuine storage failure returns 502, not a crash", async () => {
    const bucket = { file: () => ({ async download() { return [Buffer.from(JSON.stringify({ mintedAt: "x" }))]; }, async save() { const e = new Error("quota"); e.code = 500; throw e; } }) };
    const req = fakeReq({ method: "POST", body: { tagId: T1, stationId: "8536110", stationName: "Somewhere" } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 502);
  });

  console.log("tideTagProxy: POST -- the mint allowlist itself (the gap length alone can't close)");
  await test("refuses to register a well-formed, unguessable tagId that was simply never minted -- 403, nothing written", async () => {
    const bucket = makeFakeBucket({}); // T1 is NOT on the allowlist here
    const req = fakeReq({ method: "POST", body: { tagId: T1, stationId: "8536110", stationName: "Somewhere I Made Up" } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(bucket._store.size, 0, "an unminted tagId must never get a tide-tags/ record, however well-formed");
  });
  await test("minting ONE tag doesn't accidentally let a DIFFERENT invented tagId register too", async () => {
    const bucket = mintedBucket(T1); // only T1 is minted
    const req = fakeReq({ method: "POST", body: { tagId: T2, stationId: "8536110", stationName: "Somewhere I Made Up" } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 403);
  });
  await test("a storage failure during the mint check itself returns 502, not a crash or a false accept", async () => {
    const bucket = { file: () => ({ async download() { const e = new Error("down"); e.code = 500; throw e; } }) };
    const req = fakeReq({ method: "POST", body: { tagId: T1, stationId: "8536110", stationName: "Somewhere" } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 502);
  });

  console.log("tideTagProxy: PUT (explicit 'Change beach' overwrite)");
  await test("overwrites an already-registered tag's station and returns 200", async () => {
    const bucket = mintedBucket(T1, { ["tide-tags/" + T1 + ".json"]: JSON.stringify({ stationId: "ORIGINAL", stationName: "First Beach", createdAt: "x" }) });
    const req = fakeReq({ method: "PUT", body: { tagId: T1, stationId: "8536110", stationName: "Different Beach" } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { registered: true, stationId: "8536110", stationName: "Different Beach" });
    assert.strictEqual(JSON.parse(bucket._store.get("tide-tags/" + T1 + ".json")).stationId, "8536110");
  });
  await test("accepts and returns the new lat/lon when given", async () => {
    const bucket = mintedBucket(T1, { ["tide-tags/" + T1 + ".json"]: JSON.stringify({ stationId: "ORIGINAL", stationName: "First Beach", createdAt: "x", lat: 10, lon: 20 }) });
    const req = fakeReq({ method: "PUT", body: { tagId: T1, stationId: "8536110", stationName: "Different Beach", lat: 39.355, lon: -74.4183 } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.deepStrictEqual(res.body, { registered: true, stationId: "8536110", stationName: "Different Beach", lat: 39.355, lon: -74.4183 });
  });
  await test("accepts and returns the new townName on overwrite too", async () => {
    const bucket = mintedBucket(T1, { ["tide-tags/" + T1 + ".json"]: JSON.stringify({ stationId: "ORIGINAL", stationName: "First Beach", createdAt: "x", townName: "Old Town, NJ" }) });
    const req = fakeReq({ method: "PUT", body: { tagId: T1, stationId: "8534720", stationName: "Ventnor, NJ", lat: 39.355, lon: -74.4183, townName: "Ocean City, NJ" } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.deepStrictEqual(res.body, { registered: true, stationId: "8534720", stationName: "Ventnor, NJ", lat: 39.355, lon: -74.4183, townName: "Ocean City, NJ" });
  });
  await test("accepts and returns the new coastFacingDirection/srfZone/marineZone on overwrite too", async () => {
    const bucket = mintedBucket(T1, { ["tide-tags/" + T1 + ".json"]: JSON.stringify({ stationId: "ORIGINAL", stationName: "First Beach", createdAt: "x", coastFacingDirection: "W", srfZone: "OLDZ001", marineZone: "OLDZ002" }) });
    const req = fakeReq({ method: "PUT", body: { tagId: T1, stationId: "8534720", stationName: "Ventnor, NJ", lat: 39.355, lon: -74.4183, townName: "Ocean City, NJ", coastFacingDirection: "E", srfZone: "NJZ024", marineZone: "ANZ453" } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.deepStrictEqual(res.body, { registered: true, stationId: "8534720", stationName: "Ventnor, NJ", lat: 39.355, lon: -74.4183, townName: "Ocean City, NJ", coastFacingDirection: "E", srfZone: "NJZ024", marineZone: "ANZ453" });
  });
  await test("also works to register a brand-new, already-minted tag (never 409s, unlike POST)", async () => {
    const bucket = mintedBucket(T1);
    const req = fakeReq({ method: "PUT", body: { tagId: T1, stationId: "8536110", stationName: "Somewhere" } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 200);
  });
  await test("refuses to use PUT as a back door around POST's own mint check -- 403 for an unminted tagId, nothing written", async () => {
    const bucket = makeFakeBucket({}); // T1 is NOT on the allowlist
    const req = fakeReq({ method: "PUT", body: { tagId: T1, stationId: "8536110", stationName: "Somewhere I Made Up" } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(bucket._store.size, 0);
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
    const bucket = mintedBucket(T1);
    const req = fakeReq({ method: "PUT", body: { tagId: T1, stationId: "nope", stationName: "Somewhere" } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(bucket._store.has("tide-tags/" + T1 + ".json"), false);
  });
  await test("a genuine storage failure returns 502, not a crash", async () => {
    const bucket = { file: () => ({ async download() { return [Buffer.from(JSON.stringify({ mintedAt: "x" }))]; }, async save() { const e = new Error("quota"); e.code = 500; throw e; } }) };
    const req = fakeReq({ method: "PUT", body: { tagId: T1, stationId: "8536110", stationName: "Somewhere" } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 502);
  });

  console.log("tideTagProxy: DELETE");
  await test("unlinks a registered tag", async () => {
    const bucket = makeFakeBucket({ ["tide-tags/" + T1 + ".json"]: JSON.stringify({ stationId: "8536110", stationName: "X", createdAt: "x" }) });
    const req = fakeReq({ method: "DELETE", query: { tagId: T1 } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(bucket._store.has("tide-tags/" + T1 + ".json"), false);
  });
  await test("unlinking an already-unregistered tag still returns 200 (a no-op, not an error)", async () => {
    const bucket = makeFakeBucket({});
    const req = fakeReq({ method: "DELETE", query: { tagId: T1 } });
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
    const req = fakeReq({ method: "PATCH", query: { tagId: T1 } });
    const res = fakeRes();
    await tideTagProxyHandler(req, res, makeFakeBucket({}));
    assert.strictEqual(res.statusCode, 405);
  });

  console.log("pairTideTag (direct link -- the one-tap shortcut, same browser already knows both IDs)");
  await test("links an already-minted tag directly, no code involved", async () => {
    const bucket = mintedBucket(T1);
    const req = fakeReq({ method: "POST", body: { tagId: T1, deviceId: "WC-1" } });
    const res = fakeRes();
    await pairTideTagHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { linked: true, deviceId: "WC-1" });
    assert.strictEqual(JSON.parse(bucket._store.get("tide-tags/" + T1 + ".json")).linkedDeviceId, "WC-1");
  });
  await test("refuses an unminted tagId -- 403, nothing written", async () => {
    const bucket = makeFakeBucket({});
    const req = fakeReq({ method: "POST", body: { tagId: T1, deviceId: "WC-1" } });
    const res = fakeRes();
    await pairTideTagHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(bucket._store.size, 0);
  });
  await test("rejects a malformed tagId", async () => {
    const req = fakeReq({ method: "POST", body: { tagId: "bad id", deviceId: "WC-1" } });
    const res = fakeRes();
    await pairTideTagHandler(req, res, makeFakeBucket({}));
    assert.strictEqual(res.statusCode, 400);
  });
  await test("rejects a malformed deviceId without ever writing to storage", async () => {
    const bucket = mintedBucket(T1);
    const req = fakeReq({ method: "POST", body: { tagId: T1, deviceId: "../x" } });
    const res = fakeRes();
    await pairTideTagHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(bucket._store.has("tide-tags/" + T1 + ".json"), false);
  });
  await test("rejects any method other than POST", async () => {
    const req = fakeReq({ method: "GET", body: { tagId: T1, deviceId: "WC-1" } });
    const res = fakeRes();
    await pairTideTagHandler(req, res, makeFakeBucket({}));
    assert.strictEqual(res.statusCode, 405);
  });
  await test("a genuine storage failure returns 502, not a crash", async () => {
    const bucket = { file: () => ({ async download() { return [Buffer.from(JSON.stringify({ mintedAt: "x" }))]; }, async save() { const e = new Error("quota"); e.code = 500; throw e; } }) };
    const req = fakeReq({ method: "POST", body: { tagId: T1, deviceId: "WC-1" } });
    const res = fakeRes();
    await pairTideTagHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 502);
  });

  console.log("requestPairCode (the cross-device fallback -- issuing a disposable code)");
  await test("issues a code for an already-minted tag", async () => {
    const bucket = mintedBucket(T1);
    const req = fakeReq({ method: "POST", body: { tagId: T1 } });
    const res = fakeRes();
    await requestPairCodeHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.expiresInMinutes, 15);
    assert.match(res.body.code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
  });
  await test("refuses an unminted tagId -- 403, no code issued", async () => {
    const bucket = makeFakeBucket({});
    const req = fakeReq({ method: "POST", body: { tagId: T1 } });
    const res = fakeRes();
    await requestPairCodeHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(bucket._store.size, 0);
  });
  await test("rejects a malformed tagId", async () => {
    const req = fakeReq({ method: "POST", body: { tagId: "bad id" } });
    const res = fakeRes();
    await requestPairCodeHandler(req, res, makeFakeBucket({}));
    assert.strictEqual(res.statusCode, 400);
  });
  await test("rejects any method other than POST", async () => {
    const req = fakeReq({ method: "GET", body: { tagId: T1 } });
    const res = fakeRes();
    await requestPairCodeHandler(req, res, makeFakeBucket({}));
    assert.strictEqual(res.statusCode, 405);
  });

  console.log("redeemPairCode (the Manage-page side of the cross-device fallback)");
  await test("redeems a freshly-issued code and links the right tag", async () => {
    const bucket = mintedBucket(T1);
    const codeReq = fakeReq({ method: "POST", body: { tagId: T1 } });
    const codeRes = fakeRes();
    await requestPairCodeHandler(codeReq, codeRes, bucket);
    const req = fakeReq({ method: "POST", body: { code: codeRes.body.code, deviceId: "WC-1" } });
    const res = fakeRes();
    await redeemPairCodeHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { linked: true });
    assert.strictEqual(JSON.parse(bucket._store.get("tide-tags/" + T1 + ".json")).linkedDeviceId, "WC-1");
  });
  await test("a made-up or already-used code returns 404, not a crash", async () => {
    const req = fakeReq({ method: "POST", body: { code: "ZZ9999", deviceId: "WC-1" } });
    const res = fakeRes();
    await redeemPairCodeHandler(req, res, makeFakeBucket({}));
    assert.strictEqual(res.statusCode, 404);
  });
  await test("rejects a malformed code", async () => {
    const req = fakeReq({ method: "POST", body: { code: "bad", deviceId: "WC-1" } });
    const res = fakeRes();
    await redeemPairCodeHandler(req, res, makeFakeBucket({}));
    assert.strictEqual(res.statusCode, 400);
  });
  await test("rejects a malformed deviceId", async () => {
    const req = fakeReq({ method: "POST", body: { code: "AB2345", deviceId: "../x" } });
    const res = fakeRes();
    await redeemPairCodeHandler(req, res, makeFakeBucket({}));
    assert.strictEqual(res.statusCode, 400);
  });
  await test("rejects any method other than POST", async () => {
    const req = fakeReq({ method: "GET", body: { code: "AB2345", deviceId: "WC-1" } });
    const res = fakeRes();
    await redeemPairCodeHandler(req, res, makeFakeBucket({}));
    assert.strictEqual(res.statusCode, 405);
  });

  console.log("deviceLinkStatus (never reveals the real tagId -- see its own comment)");
  await test("reports paired:false for a device with nothing linked", async () => {
    const req = fakeReq({ method: "GET", query: { deviceId: "WC-1" } });
    const res = fakeRes();
    await deviceLinkStatusHandler(req, res, makeFakeBucket({}));
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { paired: false });
  });
  await test("reports paired:true once a tag is linked -- and nothing else, no tagId in the body", async () => {
    const bucket = mintedBucket(T1);
    const pairReq = fakeReq({ method: "POST", body: { tagId: T1, deviceId: "WC-1" } });
    await pairTideTagHandler(pairReq, fakeRes(), bucket);
    const req = fakeReq({ method: "GET", query: { deviceId: "WC-1" } });
    const res = fakeRes();
    await deviceLinkStatusHandler(req, res, bucket);
    assert.deepStrictEqual(res.body, { paired: true });
  });
  await test("rejects a malformed deviceId", async () => {
    const req = fakeReq({ method: "GET", query: { deviceId: "../x" } });
    const res = fakeRes();
    await deviceLinkStatusHandler(req, res, makeFakeBucket({}));
    assert.strictEqual(res.statusCode, 400);
  });
  await test("rejects any method other than GET", async () => {
    const req = fakeReq({ method: "POST", body: { deviceId: "WC-1" } });
    const res = fakeRes();
    await deviceLinkStatusHandler(req, res, makeFakeBucket({}));
    assert.strictEqual(res.statusCode, 405);
  });
  await test("a genuine storage failure returns 502, not a crash", async () => {
    const req = fakeReq({ method: "GET", query: { deviceId: "WC-1" } });
    const res = fakeRes();
    const bucket = { file: () => ({ async download() { const e = new Error("down"); e.code = 500; throw e; } }) };
    await deviceLinkStatusHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 502);
  });
  await test("self-heals a legacy pairing (made before device-tag-links/ existed) and reports paired:true, no admin secret needed", async () => {
    // Mirrors the real live report exactly: the tag's OWN record already
    // carries linkedDeviceId (an old pairTideTagHandler call, before this
    // reverse index existed), but nothing lives at device-tag-links/ yet.
    const bucket = makeFakeBucket({ ["tide-tags/" + T1 + ".json"]: JSON.stringify({ linkedDeviceId: "WC-1", linkedAt: "2026-01-01T00:00:00.000Z" }) });
    const req = fakeReq({ method: "GET", query: { deviceId: "WC-1" } });
    const res = fakeRes();
    await deviceLinkStatusHandler(req, res, bucket);
    assert.deepStrictEqual(res.body, { paired: true });
    assert.ok(bucket._store.has("device-tag-links/WC-1.json"), "the check itself should have repaired the missing reverse link");
  });

  console.log("unpairDevice");
  await test("unpairs a device that has a keychain linked", async () => {
    const bucket = mintedBucket(T1);
    const pairReq = fakeReq({ method: "POST", body: { tagId: T1, deviceId: "WC-1" } });
    await pairTideTagHandler(pairReq, fakeRes(), bucket);
    const req = fakeReq({ method: "POST", body: { deviceId: "WC-1" } });
    const res = fakeRes();
    await unpairDeviceHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { unpaired: true });
    assert.strictEqual("linkedDeviceId" in JSON.parse(bucket._store.get("tide-tags/" + T1 + ".json")), false);
    const statusReq = fakeReq({ method: "GET", query: { deviceId: "WC-1" } });
    const statusRes = fakeRes();
    await deviceLinkStatusHandler(statusReq, statusRes, bucket);
    assert.deepStrictEqual(statusRes.body, { paired: false }, "deviceLinkStatus must reflect the unpair immediately");
  });
  await test("unpairing a device with nothing linked reports unpaired:false, not an error", async () => {
    const req = fakeReq({ method: "POST", body: { deviceId: "WC-1" } });
    const res = fakeRes();
    await unpairDeviceHandler(req, res, makeFakeBucket({}));
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { unpaired: false });
  });
  await test("rejects a malformed deviceId", async () => {
    const req = fakeReq({ method: "POST", body: { deviceId: "../x" } });
    const res = fakeRes();
    await unpairDeviceHandler(req, res, makeFakeBucket({}));
    assert.strictEqual(res.statusCode, 400);
  });
  await test("rejects any method other than POST", async () => {
    const req = fakeReq({ method: "GET", query: { deviceId: "WC-1" } });
    const res = fakeRes();
    await unpairDeviceHandler(req, res, makeFakeBucket({}));
    assert.strictEqual(res.statusCode, 405);
  });
  await test("a genuine storage failure returns 502, not a crash", async () => {
    const req = fakeReq({ method: "POST", body: { deviceId: "WC-1" } });
    const res = fakeRes();
    const bucket = { file: () => ({ async download() { const e = new Error("down"); e.code = 500; throw e; } }) };
    await unpairDeviceHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 502);
  });

  console.log("mintTideTagBatch: auth");
  await test("rejects a request with no secret at all", async () => {
    const req = fakeReq({ method: "POST", body: { ids: [T1] } });
    const res = fakeRes();
    await mintTideTagBatchHandler(req, res, makeFakeBucket({}));
    assert.strictEqual(res.statusCode, 403);
  });
  await test("rejects a request with the wrong secret", async () => {
    const prev = process.env.WAVECLOCK_MINT_SECRET;
    process.env.WAVECLOCK_MINT_SECRET = "the-real-secret";
    try {
      const req = fakeReq({ method: "POST", headers: { "x-mint-secret": "guessed-wrong" }, body: { ids: [T1] } });
      const res = fakeRes();
      const bucket = makeFakeBucket({});
      await mintTideTagBatchHandler(req, res, bucket);
      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(bucket._store.size, 0, "a wrong secret must never mint anything");
    } finally {
      process.env.WAVECLOCK_MINT_SECRET = prev;
    }
  });
  await test("accepts a request with the correct secret", async () => {
    const prev = process.env.WAVECLOCK_MINT_SECRET;
    process.env.WAVECLOCK_MINT_SECRET = "the-real-secret";
    try {
      const req = fakeReq({ method: "POST", headers: { "x-mint-secret": "the-real-secret" }, body: { ids: [T1] } });
      const res = fakeRes();
      const bucket = makeFakeBucket({});
      await mintTideTagBatchHandler(req, res, bucket);
      assert.strictEqual(res.statusCode, 200);
    } finally {
      process.env.WAVECLOCK_MINT_SECRET = prev;
    }
  });
  await test("refuses every request (even an empty secret matching an empty header) when no secret is configured at all", async () => {
    const prev = process.env.WAVECLOCK_MINT_SECRET;
    delete process.env.WAVECLOCK_MINT_SECRET;
    try {
      const req = fakeReq({ method: "POST", headers: {}, body: { ids: [T1] } });
      const res = fakeRes();
      const bucket = makeFakeBucket({});
      await mintTideTagBatchHandler(req, res, bucket);
      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(bucket._store.size, 0);
    } finally {
      if (prev === undefined) delete process.env.WAVECLOCK_MINT_SECRET; else process.env.WAVECLOCK_MINT_SECRET = prev;
    }
  });

  console.log("mintTideTagBatch: minting (secret valid for the rest of these)");
  const withSecret = async (fn) => {
    const prev = process.env.WAVECLOCK_MINT_SECRET;
    process.env.WAVECLOCK_MINT_SECRET = "the-real-secret";
    try { await fn(); } finally { process.env.WAVECLOCK_MINT_SECRET = prev; }
  };
  await test("mints a batch of IDs, reporting how many were new", () => withSecret(async () => {
    const req = fakeReq({ method: "POST", headers: { "x-mint-secret": "the-real-secret" }, body: { ids: [T1, T2] } });
    const res = fakeRes();
    const bucket = makeFakeBucket({});
    await mintTideTagBatchHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { minted: 2, alreadyMinted: 0 });
    assert.ok(bucket._store.has("tide-tag-allowlist/" + T1 + ".json"));
    assert.ok(bucket._store.has("tide-tag-allowlist/" + T2 + ".json"));
  }));
  await test("re-minting the same batch is idempotent, not an error", () => withSecret(async () => {
    const bucket = mintedBucket(T1);
    const req = fakeReq({ method: "POST", headers: { "x-mint-secret": "the-real-secret" }, body: { ids: [T1, T2] } });
    const res = fakeRes();
    await mintTideTagBatchHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { minted: 1, alreadyMinted: 1 });
  }));
  await test("rejects a non-array ids field", () => withSecret(async () => {
    const req = fakeReq({ method: "POST", headers: { "x-mint-secret": "the-real-secret" }, body: { ids: T1 } });
    const res = fakeRes();
    await mintTideTagBatchHandler(req, res, makeFakeBucket({}));
    assert.strictEqual(res.statusCode, 400);
  }));
  await test("rejects an empty ids array", () => withSecret(async () => {
    const req = fakeReq({ method: "POST", headers: { "x-mint-secret": "the-real-secret" }, body: { ids: [] } });
    const res = fakeRes();
    await mintTideTagBatchHandler(req, res, makeFakeBucket({}));
    assert.strictEqual(res.statusCode, 400);
  }));
  await test("rejects a batch over the max size, without minting any of it", () => withSecret(async () => {
    const hugeBatch = Array.from({ length: 1001 }, (_, i) => T1.slice(0, 19) + (i % 10));
    const req = fakeReq({ method: "POST", headers: { "x-mint-secret": "the-real-secret" }, body: { ids: hugeBatch } });
    const res = fakeRes();
    const bucket = makeFakeBucket({});
    await mintTideTagBatchHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(bucket._store.size, 0);
  }));
  await test("rejects a batch containing one malformed ID, without minting any of it", () => withSecret(async () => {
    const req = fakeReq({ method: "POST", headers: { "x-mint-secret": "the-real-secret" }, body: { ids: [T1, "bad id"] } });
    const res = fakeRes();
    const bucket = makeFakeBucket({});
    await mintTideTagBatchHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(bucket._store.size, 0);
  }));
  await test("a genuine storage failure returns 502, not a crash", () => withSecret(async () => {
    const req = fakeReq({ method: "POST", headers: { "x-mint-secret": "the-real-secret" }, body: { ids: [T1] } });
    const res = fakeRes();
    const bucket = { file: () => ({ async save() { const e = new Error("quota"); e.code = 500; throw e; } }) };
    await mintTideTagBatchHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 502);
  }));
  await test("rejects any method other than POST", () => withSecret(async () => {
    const req = fakeReq({ method: "GET", headers: { "x-mint-secret": "the-real-secret" } });
    const res = fakeRes();
    await mintTideTagBatchHandler(req, res, makeFakeBucket({}));
    assert.strictEqual(res.statusCode, 405);
  }));

  console.log("backfillDeviceTagLinks: auth (same WAVECLOCK_MINT_SECRET gate as mintTideTagBatch -- not scoped to one tag/device either)");
  await test("rejects a request with no secret at all", async () => {
    const req = fakeReq({ method: "POST" });
    const res = fakeRes();
    await backfillDeviceTagLinksHandler(req, res, makeFakeBucket({}));
    assert.strictEqual(res.statusCode, 403);
  });
  await test("rejects a request with the wrong secret", () => withSecret(async () => {
    const req = fakeReq({ method: "POST", headers: { "x-mint-secret": "guessed-wrong" } });
    const res = fakeRes();
    const bucket = makeFakeBucket({ ["tide-tags/" + T1 + ".json"]: JSON.stringify({ linkedDeviceId: "WC-1" }) });
    await backfillDeviceTagLinksHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(bucket._store.has("device-tag-links/WC-1.json"), false, "a wrong secret must never backfill anything");
  }));
  await test("refuses every request when no secret is configured at all", async () => {
    const prev = process.env.WAVECLOCK_MINT_SECRET;
    delete process.env.WAVECLOCK_MINT_SECRET;
    try {
      const req = fakeReq({ method: "POST", headers: {} });
      const res = fakeRes();
      await backfillDeviceTagLinksHandler(req, res, makeFakeBucket({}));
      assert.strictEqual(res.statusCode, 403);
    } finally {
      if (prev === undefined) delete process.env.WAVECLOCK_MINT_SECRET; else process.env.WAVECLOCK_MINT_SECRET = prev;
    }
  });
  await test("rejects any method other than POST", () => withSecret(async () => {
    const req = fakeReq({ method: "GET", headers: { "x-mint-secret": "the-real-secret" } });
    const res = fakeRes();
    await backfillDeviceTagLinksHandler(req, res, makeFakeBucket({}));
    assert.strictEqual(res.statusCode, 405);
  }));

  console.log("backfillDeviceTagLinks: backfilling (secret valid for the rest of these)");
  await test("backfills a pre-existing link's missing reverse index and reports what it did", () => withSecret(async () => {
    const req = fakeReq({ method: "POST", headers: { "x-mint-secret": "the-real-secret" } });
    const res = fakeRes();
    const bucket = makeFakeBucket({ ["tide-tags/" + T1 + ".json"]: JSON.stringify({ linkedDeviceId: "WC-1", linkedAt: "2026-01-01T00:00:00.000Z" }) });
    await backfillDeviceTagLinksHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { scanned: 1, backfilled: ["WC-1"], skipped: 0 });
    assert.ok(bucket._store.has("device-tag-links/WC-1.json"));
  }));
  await test("a genuine storage failure returns 502, not a crash", () => withSecret(async () => {
    const req = fakeReq({ method: "POST", headers: { "x-mint-secret": "the-real-secret" } });
    const res = fakeRes();
    const bucket = { getFiles: async () => { const e = new Error("down"); e.code = 500; throw e; } };
    await backfillDeviceTagLinksHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 502);
  }));

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
