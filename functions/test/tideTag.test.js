"use strict";

// Exercises lib/tideTag.js against a fully in-memory fake Cloud Storage
// bucket -- no live GCS call. The fake's .save() honors
// preconditionOpts.ifGenerationMatch the same way the real
// @google-cloud/storage client does (throws a 412 ApiError when the
// object already exists and ifGenerationMatch: 0 was requested), since
// that's the exact atomicity saveTideTag depends on.

const assert = require("assert");
const { TAG_ID_PATTERN, isValidTagId, sanitizeCoords, sanitizeTownName, sanitizeCoastFacingDirection, sanitizeZoneId, fetchTideTag, saveTideTag, updateTideTag, deleteTideTag } = require("../lib/tideTag");

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

  console.log("sanitizeCoords (lat/lon for the sunrise/sunset day-night background)");
  await test("accepts valid in-range coordinates", () => {
    assert.deepStrictEqual(sanitizeCoords(39.355, -74.4183), { lat: 39.355, lon: -74.4183 });
  });
  await test("accepts numeric strings (as a POST body's JSON would send them)", () => {
    assert.deepStrictEqual(sanitizeCoords("39.355", "-74.4183"), { lat: 39.355, lon: -74.4183 });
  });
  await test("returns null for out-of-range lat/lon", () => {
    assert.strictEqual(sanitizeCoords(91, 0), null);
    assert.strictEqual(sanitizeCoords(-91, 0), null);
    assert.strictEqual(sanitizeCoords(0, 181), null);
    assert.strictEqual(sanitizeCoords(0, -181), null);
  });
  await test("returns null for missing/non-numeric input, rather than throwing", () => {
    assert.strictEqual(sanitizeCoords(undefined, undefined), null);
    assert.strictEqual(sanitizeCoords("not a number", 0), null);
    assert.strictEqual(sanitizeCoords(null, null), null);
  });

  console.log("sanitizeTownName (the user's display name, distinct from the NOAA station's own name)");
  await test("trims whitespace", () => {
    assert.strictEqual(sanitizeTownName("  Ocean City, NJ  "), "Ocean City, NJ");
  });
  await test("returns null for missing/blank/non-string input", () => {
    assert.strictEqual(sanitizeTownName(undefined), null);
    assert.strictEqual(sanitizeTownName(null), null);
    assert.strictEqual(sanitizeTownName(""), null);
    assert.strictEqual(sanitizeTownName("   "), null);
    assert.strictEqual(sanitizeTownName(42), null);
  });
  await test("caps an unreasonably long value rather than storing it unbounded", () => {
    const huge = "X".repeat(500);
    assert.strictEqual(sanitizeTownName(huge).length, 100);
  });

  console.log("sanitizeCoastFacingDirection (the compass point the coast opens toward)");
  await test("accepts any of the 8 real compass points", () => {
    for (const dir of ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]) {
      assert.strictEqual(sanitizeCoastFacingDirection(dir), dir);
    }
  });
  await test("returns null for anything not one of the 8 known compass points", () => {
    assert.strictEqual(sanitizeCoastFacingDirection("NNE"), null);
    assert.strictEqual(sanitizeCoastFacingDirection("north"), null);
    assert.strictEqual(sanitizeCoastFacingDirection(""), null);
    assert.strictEqual(sanitizeCoastFacingDirection(null), null);
    assert.strictEqual(sanitizeCoastFacingDirection(undefined), null);
    assert.strictEqual(sanitizeCoastFacingDirection(90), null);
  });

  console.log("sanitizeZoneId (shared shape for srfZone and marineZone)");
  await test("accepts real NWS zone IDs", () => {
    assert.strictEqual(sanitizeZoneId("NJZ024"), "NJZ024");
    assert.strictEqual(sanitizeZoneId("ANZ453"), "ANZ453");
  });
  await test("returns null for anything not matching the 2-3 letter + Z + 3 digit shape", () => {
    assert.strictEqual(sanitizeZoneId("njz024"), null);
    assert.strictEqual(sanitizeZoneId("NJZ24"), null);
    assert.strictEqual(sanitizeZoneId("NJZ02499"), null);
    assert.strictEqual(sanitizeZoneId(""), null);
    assert.strictEqual(sanitizeZoneId(null), null);
    assert.strictEqual(sanitizeZoneId(undefined), null);
    assert.strictEqual(sanitizeZoneId(24), null);
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
  await test("stores lat/lon when given valid coordinates", async () => {
    const bucket = makeFakeBucket({});
    const result = await saveTideTag(bucket, "A7K2", "8536110", "Atlantic City, NJ", 39.355, -74.4183);
    assert.deepStrictEqual({ lat: result.record.lat, lon: result.record.lon }, { lat: 39.355, lon: -74.4183 });
  });
  await test("omits lat/lon entirely when not given or invalid, rather than storing nulls", async () => {
    const bucket = makeFakeBucket({});
    const result = await saveTideTag(bucket, "A7K2", "8536110", "Atlantic City, NJ");
    assert.strictEqual("lat" in result.record, false);
    assert.strictEqual("lon" in result.record, false);
  });
  await test("stores townName (the user's picked display name) alongside the NOAA station's own name", async () => {
    const bucket = makeFakeBucket({});
    const result = await saveTideTag(bucket, "A7K2", "8534720", "Ventnor, NJ", 39.355, -74.4183, "Ocean City, NJ");
    assert.strictEqual(result.record.stationName, "Ventnor, NJ");
    assert.strictEqual(result.record.townName, "Ocean City, NJ");
  });
  await test("omits townName entirely when not given, rather than storing an empty string", async () => {
    const bucket = makeFakeBucket({});
    const result = await saveTideTag(bucket, "A7K2", "8536110", "Atlantic City, NJ", 39.355, -74.4183);
    assert.strictEqual("townName" in result.record, false);
  });
  await test("stores coastFacingDirection, srfZone, and marineZone when given", async () => {
    const bucket = makeFakeBucket({});
    const result = await saveTideTag(bucket, "A7K2", "8534720", "Ventnor, NJ", 39.355, -74.4183, "Ocean City, NJ", "E", "NJZ024", "ANZ453");
    assert.strictEqual(result.record.coastFacingDirection, "E");
    assert.strictEqual(result.record.srfZone, "NJZ024");
    assert.strictEqual(result.record.marineZone, "ANZ453");
  });
  await test("omits coastFacingDirection/srfZone/marineZone entirely when not given or malformed", async () => {
    const bucket = makeFakeBucket({});
    const result = await saveTideTag(bucket, "A7K2", "8536110", "Atlantic City, NJ", 39.355, -74.4183, "Ocean City, NJ", "not-a-direction", "bad-zone", "");
    assert.strictEqual("coastFacingDirection" in result.record, false);
    assert.strictEqual("srfZone" in result.record, false);
    assert.strictEqual("marineZone" in result.record, false);
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
  await test("stores the new lat/lon on overwrite too, dropping the old ones", async () => {
    const bucket = makeFakeBucket({ "tide-tags/A7K2.json": JSON.stringify({ stationId: "ORIGINAL", stationName: "First Beach", createdAt: "x", lat: 10, lon: 20 }) });
    const record = await updateTideTag(bucket, "A7K2", "8536110", "Different Beach", 39.355, -74.4183);
    assert.deepStrictEqual({ lat: record.lat, lon: record.lon }, { lat: 39.355, lon: -74.4183 });
  });
  await test("stores the new townName on overwrite too, dropping the old one", async () => {
    const bucket = makeFakeBucket({ "tide-tags/A7K2.json": JSON.stringify({ stationId: "ORIGINAL", stationName: "First Beach", createdAt: "x", townName: "Old Town, NJ" }) });
    const record = await updateTideTag(bucket, "A7K2", "8534720", "Ventnor, NJ", 39.355, -74.4183, "Ocean City, NJ");
    assert.strictEqual(record.townName, "Ocean City, NJ");
  });
  await test("stores the new coastFacingDirection/srfZone/marineZone on overwrite too, dropping the old ones", async () => {
    const bucket = makeFakeBucket({ "tide-tags/A7K2.json": JSON.stringify({ stationId: "ORIGINAL", stationName: "First Beach", createdAt: "x", coastFacingDirection: "W", srfZone: "OLDZ001", marineZone: "OLDZ002" }) });
    const record = await updateTideTag(bucket, "A7K2", "8534720", "Ventnor, NJ", 39.355, -74.4183, "Ocean City, NJ", "E", "NJZ024", "ANZ453");
    assert.strictEqual(record.coastFacingDirection, "E");
    assert.strictEqual(record.srfZone, "NJZ024");
    assert.strictEqual(record.marineZone, "ANZ453");
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
