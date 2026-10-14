"use strict";

// Exercises lib/tideTag.js against a fully in-memory fake Cloud Storage
// bucket -- no live GCS call. The fake's .save() honors
// preconditionOpts.ifGenerationMatch the same way the real
// @google-cloud/storage client does (throws a 412 ApiError when the
// object already exists and ifGenerationMatch: 0 was requested), since
// that's the exact atomicity saveTideTag depends on.

const assert = require("assert");
const { TAG_ID_PATTERN, isValidTagId, fetchTideTag, saveTideTag, updateTideTag, deleteTideTag } = require("../lib/tideTag");

function makeFakeBucket(initialFiles) {
  const store = new Map(Object.entries(initialFiles || {})); // path -> string
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
  console.log("isValidTagId");
  await test("accepts IDs in the generator's charset at 4-6 chars", () => {
    assert.ok(isValidTagId("A7K2"));
    assert.ok(isValidTagId("A7K2Z9"));
    assert.ok(isValidTagId("ABCD"));
  });
  await test("rejects IDs with the excluded lookalike characters 0/O/1/I", () => {
    assert.strictEqual(isValidTagId("A7K0"), false);
    assert.strictEqual(isValidTagId("A7KO"), false);
    assert.strictEqual(isValidTagId("A7K1"), false);
    assert.strictEqual(isValidTagId("A7KI"), false);
  });
  await test("rejects lengths outside 4-6", () => {
    assert.strictEqual(isValidTagId("ABC"), false);
    assert.strictEqual(isValidTagId("ABCDEFG"), false);
  });
  await test("rejects lowercase, non-alnum, and non-string input (path-traversal shapes included)", () => {
    assert.strictEqual(isValidTagId("a7k2"), false);
    assert.strictEqual(isValidTagId("../../etc"), false);
    assert.strictEqual(isValidTagId("A7K2/"), false);
    assert.strictEqual(isValidTagId(""), false);
    assert.strictEqual(isValidTagId(null), false);
    assert.strictEqual(isValidTagId(undefined), false);
    assert.strictEqual(isValidTagId(1234), false);
  });
  await test("TAG_ID_PATTERN is the single source of truth isValidTagId actually uses", () => {
    assert.ok(TAG_ID_PATTERN.test("A7K2"));
    assert.strictEqual(TAG_ID_PATTERN.test("a7k2"), false);
  });

  console.log("fetchTideTag");
  await test("returns null for a tag that's never been registered", async () => {
    const bucket = makeFakeBucket({});
    const record = await fetchTideTag(bucket, "A7K2");
    assert.strictEqual(record, null);
  });
  await test("returns the saved record for a registered tag", async () => {
    const bucket = makeFakeBucket({
      "tide-tags/A7K2.json": JSON.stringify({ stationId: "8536110", stationName: "Atlantic City, NJ", createdAt: "2026-10-14T00:00:00.000Z" })
    });
    const record = await fetchTideTag(bucket, "A7K2");
    assert.deepStrictEqual(record, { stationId: "8536110", stationName: "Atlantic City, NJ", createdAt: "2026-10-14T00:00:00.000Z" });
  });
  await test("returns null (not a throw) for a malformed tagId -- never even touches storage", async () => {
    const bucket = makeFakeBucket({});
    bucket.file = () => { throw new Error("should never be called for an invalid tagId"); };
    const record = await fetchTideTag(bucket, "not valid!");
    assert.strictEqual(record, null);
  });
  await test("a genuine storage failure still throws, not swallowed as null", async () => {
    const bucket = { file: () => ({ async download() { const e = new Error("network down"); e.code = 500; throw e; } }) };
    await assert.rejects(() => fetchTideTag(bucket, "A7K2"), /network down/);
  });

  console.log("saveTideTag");
  await test("creates a new tag registration and returns the saved record", async () => {
    const bucket = makeFakeBucket({});
    const result = await saveTideTag(bucket, "A7K2", "8536110", "Atlantic City, NJ");
    assert.strictEqual(result.status, "created");
    assert.strictEqual(result.record.stationId, "8536110");
    assert.strictEqual(result.record.stationName, "Atlantic City, NJ");
    assert.ok(result.record.createdAt);
    const saved = JSON.parse(bucket._store.get("tide-tags/A7K2.json"));
    assert.strictEqual(saved.stationId, "8536110");
  });
  await test("refuses to overwrite an already-registered tag -- status 'already-registered', original record untouched", async () => {
    const bucket = makeFakeBucket({
      "tide-tags/A7K2.json": JSON.stringify({ stationId: "ORIGINAL", stationName: "First Beach", createdAt: "2026-01-01T00:00:00.000Z" })
    });
    const result = await saveTideTag(bucket, "A7K2", "8536110", "Different Beach");
    assert.strictEqual(result.status, "already-registered");
    const saved = JSON.parse(bucket._store.get("tide-tags/A7K2.json"));
    assert.strictEqual(saved.stationId, "ORIGINAL", "the original registration must not be clobbered by a second attempt");
  });
  await test("throws on an invalid tagId rather than ever writing to storage", async () => {
    const bucket = makeFakeBucket({});
    bucket.file = () => { throw new Error("should never be called for an invalid tagId"); };
    await assert.rejects(() => saveTideTag(bucket, "bad id", "8536110", "Somewhere"), /invalid tagId/);
  });
  await test("a genuine storage failure (not a 412) still throws", async () => {
    const bucket = { file: () => ({ async save() { const e = new Error("quota exceeded"); e.code = 500; throw e; } }) };
    await assert.rejects(() => saveTideTag(bucket, "A7K2", "8536110", "Somewhere"), /quota exceeded/);
  });

  console.log("updateTideTag (explicit user-initiated 'change beach', unlike saveTideTag's create-only guard)");
  await test("overwrites an already-registered tag's station", async () => {
    const bucket = makeFakeBucket({ "tide-tags/A7K2.json": JSON.stringify({ stationId: "ORIGINAL", stationName: "First Beach", createdAt: "2026-01-01T00:00:00.000Z" }) });
    const record = await updateTideTag(bucket, "A7K2", "8536110", "Different Beach");
    assert.strictEqual(record.stationId, "8536110");
    assert.strictEqual(record.stationName, "Different Beach");
    const saved = JSON.parse(bucket._store.get("tide-tags/A7K2.json"));
    assert.strictEqual(saved.stationId, "8536110", "the overwrite must actually land, unlike saveTideTag's create-only guard");
  });
  await test("also works as a plain create for a tag that was never registered", async () => {
    const bucket = makeFakeBucket({});
    const record = await updateTideTag(bucket, "A7K2", "8536110", "Atlantic City, NJ");
    assert.strictEqual(record.stationId, "8536110");
    assert.ok(bucket._store.has("tide-tags/A7K2.json"));
  });
  await test("throws on an invalid tagId rather than ever writing to storage", async () => {
    const bucket = makeFakeBucket({});
    bucket.file = () => { throw new Error("should never be called for an invalid tagId"); };
    await assert.rejects(() => updateTideTag(bucket, "bad id", "8536110", "Somewhere"), /invalid tagId/);
  });
  await test("a genuine storage failure still throws", async () => {
    const bucket = { file: () => ({ async save() { const e = new Error("quota exceeded"); e.code = 500; throw e; } }) };
    await assert.rejects(() => updateTideTag(bucket, "A7K2", "8536110", "Somewhere"), /quota exceeded/);
  });

  console.log("deleteTideTag");
  await test("unlinks a registered tag", async () => {
    const bucket = makeFakeBucket({ "tide-tags/A7K2.json": JSON.stringify({ stationId: "8536110", stationName: "X", createdAt: "x" }) });
    await deleteTideTag(bucket, "A7K2");
    assert.strictEqual(bucket._store.has("tide-tags/A7K2.json"), false);
  });
  await test("unlinking an already-unregistered tag is a no-op, not an error", async () => {
    const bucket = makeFakeBucket({});
    await assert.doesNotReject(() => deleteTideTag(bucket, "A7K2"));
  });
  await test("throws on an invalid tagId rather than touching storage", async () => {
    const bucket = makeFakeBucket({});
    bucket.file = () => { throw new Error("should never be called for an invalid tagId"); };
    await assert.rejects(() => deleteTideTag(bucket, "bad id"), /invalid tagId/);
  });
  await test("a genuine storage failure (not a 404) still throws", async () => {
    const bucket = { file: () => ({ async delete() { const e = new Error("network down"); e.code = 500; throw e; } }) };
    await assert.rejects(() => deleteTideTag(bucket, "A7K2"), /network down/);
  });

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
