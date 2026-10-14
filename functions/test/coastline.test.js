"use strict";

// Exercises lib/coastline.js's fetchCoastlineNear against a fake injected
// fetch (no live Overpass call) -- same fetchImpl-injection convention
// lib/astro.js already uses.

const assert = require("assert");
const { COASTLINE_SEARCH_RADII_KM, OVERPASS_ENDPOINTS, buildCoastlineQuery, fetchCoastlineNear } = require("../lib/coastline");

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

const REAL_COASTLINE_DATA = {
  elements: [
    { type: "node", id: 1, lat: 39.26, lon: -74.58 },
    { type: "node", id: 2, lat: 39.30, lon: -74.58 },
    { type: "way", id: 100, nodes: [1, 2] }
  ]
};

(async () => {
  console.log("buildCoastlineQuery");
  await test("builds an Overpass QL query for a bounding box around the point", () => {
    const q = buildCoastlineQuery(39.2776, -74.5746, 3);
    assert.ok(q.includes('way["natural"="coastline"]'));
    assert.ok(/\(-?\d+\.\d+,-?\d+\.\d+,-?\d+\.\d+,-?\d+\.\d+\)/.test(q), "expects a (south,west,north,east) bbox");
  });

  console.log("fetchCoastlineNear");
  await test("returns the first mirror's data when it succeeds on the first radius", async () => {
    let calls = 0;
    const fakeFetch = async () => { calls++; return { ok: true, json: async () => REAL_COASTLINE_DATA }; };
    const data = await fetchCoastlineNear(39.2776, -74.5746, fakeFetch);
    assert.deepStrictEqual(data, REAL_COASTLINE_DATA);
    assert.strictEqual(calls, 1, "shouldn't try a second mirror once the first succeeds");
  });

  await test("falls through to the remaining mirrors (raced in parallel) when the first returns no usable coastline", async () => {
    let call = 0;
    const fakeFetch = async () => {
      call++;
      if (call === 1) return { ok: true, json: async () => ({ elements: [] }) };
      return { ok: true, json: async () => REAL_COASTLINE_DATA };
    };
    const data = await fetchCoastlineNear(39.2776, -74.5746, fakeFetch);
    assert.deepStrictEqual(data, REAL_COASTLINE_DATA);
    // The first mirror is tried alone (call 1, no usable data), then the
    // REMAINING mirrors are raced in parallel rather than one at a time --
    // both get invoked even though only the faster one's result is used.
    assert.strictEqual(call, 3);
  });

  await test("doesn't wait for a slow mirror once a faster one in the same race resolves", async () => {
    // Mirror[0] fails fast. Of the remaining two, one resolves slowly
    // (an unresolved promise standing in for "still pending"), the other
    // resolves immediately with real data -- proves the two are raced
    // (Promise.any), not awaited one after another, which is the whole
    // point of parallelizing them: a single slow/hanging mirror must
    // never hold up the other's already-successful answer.
    let callIndex = 0;
    const neverResolves = new Promise(() => {});
    const fakeFetch = async () => {
      callIndex++;
      if (callIndex === 1) return { ok: false, status: 500 }; // mirror[0]
      if (callIndex === 2) return neverResolves; // one of the parallel pair hangs forever
      return { ok: true, json: async () => REAL_COASTLINE_DATA }; // the other resolves right away
    };
    const data = await fetchCoastlineNear(39.2776, -74.5746, fakeFetch);
    assert.deepStrictEqual(data, REAL_COASTLINE_DATA);
  });

  await test("falls through to the next mirror when one errors outright", async () => {
    let call = 0;
    const fakeFetch = async () => {
      call++;
      if (call === 1) throw new Error("connect refused");
      return { ok: true, json: async () => REAL_COASTLINE_DATA };
    };
    const data = await fetchCoastlineNear(39.2776, -74.5746, fakeFetch);
    assert.deepStrictEqual(data, REAL_COASTLINE_DATA);
  });

  await test("falls through to the next mirror on a non-ok HTTP response", async () => {
    let call = 0;
    const fakeFetch = async () => {
      call++;
      if (call === 1) return { ok: false, status: 406 };
      return { ok: true, json: async () => REAL_COASTLINE_DATA };
    };
    const data = await fetchCoastlineNear(39.2776, -74.5746, fakeFetch);
    assert.deepStrictEqual(data, REAL_COASTLINE_DATA);
  });

  await test("widens the search radius once every mirror fails at the closer one", async () => {
    const triedRadii = [];
    const fakeFetch = async (url, opts) => {
      // Recover which radius this query was built for by re-deriving it
      // against each known radius -- simpler than parsing the bbox back
      // out of the query string, and just as exact.
      const body = opts.body;
      const radius = COASTLINE_SEARCH_RADII_KM.find((km) => body === "data=" + encodeURIComponent(buildCoastlineQuery(39.2776, -74.5746, km)));
      if (radius != null && !triedRadii.includes(radius)) triedRadii.push(radius);
      if (radius === COASTLINE_SEARCH_RADII_KM[0]) return { ok: true, json: async () => ({ elements: [] }) };
      return { ok: true, json: async () => REAL_COASTLINE_DATA };
    };
    const data = await fetchCoastlineNear(39.2776, -74.5746, fakeFetch);
    assert.deepStrictEqual(data, REAL_COASTLINE_DATA);
    assert.deepStrictEqual(triedRadii, COASTLINE_SEARCH_RADII_KM, "should try the closer radius across all mirrors before widening");
  });

  await test("throws once every radius/mirror combination is exhausted", async () => {
    const fakeFetch = async () => ({ ok: false, status: 500 });
    await assert.rejects(() => fetchCoastlineNear(39.2776, -74.5746, fakeFetch));
  });

  await test("tries exactly OVERPASS_ENDPOINTS.length mirrors per radius before widening", async () => {
    let callsAtFirstRadius = 0;
    let sawSecondRadius = false;
    const fakeFetch = async (url, opts) => {
      const isFirstRadius = opts.body === "data=" + encodeURIComponent(buildCoastlineQuery(39.2776, -74.5746, COASTLINE_SEARCH_RADII_KM[0]));
      if (isFirstRadius) callsAtFirstRadius++;
      else sawSecondRadius = true;
      return { ok: true, json: async () => ({ elements: [] }) };
    };
    await assert.rejects(() => fetchCoastlineNear(39.2776, -74.5746, fakeFetch));
    assert.strictEqual(callsAtFirstRadius, OVERPASS_ENDPOINTS.length);
    assert.ok(sawSecondRadius);
  });

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
