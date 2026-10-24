"use strict";

// Exercises lib/beachDayCache.js directly: a fully in-memory fake bucket
// (same makeFakeBucket shape test/coastOrientationReport.test.js and
// test/tideTagProxy.test.js already use) plus a stubbed fetch for the
// render step, no live GCS or Open-Meteo/NOAA/NWS calls.

const assert = require("assert");
const {
  beachDayCacheKey,
  extractFromDeviceLocation,
  extractFromTideTag,
  collectActiveBeachDayLocations,
  renderBeachDayForLocation,
  regenerateBeachDayCache
} = require("../lib/beachDayCache");

function makeFakeBucket(initialFiles) {
  const store = new Map(Object.entries(initialFiles || {}));
  function fileHandle(path) {
    return {
      path,
      name: path,
      async download() {
        if (!store.has(path)) {
          const err = new Error("not found");
          err.code = 404;
          throw err;
        }
        return [Buffer.from(store.get(path), "utf8")];
      },
      async save(data) { store.set(path, data); }
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

function deviceStatusFile(location) {
  return JSON.stringify({ location, settings: {} });
}
function locationsFile(fields) {
  return JSON.stringify(fields);
}
function tideTagFile(fields) {
  return JSON.stringify(Object.assign({ stationName: "x", createdAt: "2026-01-01T00:00:00.000Z" }, fields));
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
  console.log("beachDayCacheKey");
  await test("is deterministic for identical inputs", async () => {
    const loc = { lat: 39.2776, lon: -74.5746, stationId: "8534720", srfZone: "NJZ025", coastFacingDirection: "E" };
    assert.strictEqual(beachDayCacheKey(loc), beachDayCacheKey(Object.assign({}, loc)));
  });
  await test("rounds lat/lon to 2 decimal places -- nearby pins share a key", async () => {
    const a = { lat: 39.27761, lon: -74.57464, stationId: "8534720", srfZone: "NJZ025", coastFacingDirection: "E" };
    const b = { lat: 39.27755, lon: -74.57459, stationId: "8534720", srfZone: "NJZ025", coastFacingDirection: "E" };
    assert.strictEqual(beachDayCacheKey(a), beachDayCacheKey(b));
  });
  await test("a different stationId, srfZone, or coastFacingDirection changes the key", async () => {
    const base = { lat: 39.28, lon: -74.57, stationId: "8534720", srfZone: "NJZ025", coastFacingDirection: "E" };
    const k0 = beachDayCacheKey(base);
    assert.notStrictEqual(beachDayCacheKey(Object.assign({}, base, { stationId: "8534975" })), k0);
    assert.notStrictEqual(beachDayCacheKey(Object.assign({}, base, { srfZone: "NJZ024" })), k0);
    assert.notStrictEqual(beachDayCacheKey(Object.assign({}, base, { coastFacingDirection: "SE" })), k0);
  });
  await test("missing srfZone/coastFacingDirection still produces a stable key, not a crash", async () => {
    const loc = { lat: 39.28, lon: -74.57, stationId: "8534720", srfZone: null, coastFacingDirection: null };
    assert.strictEqual(beachDayCacheKey(loc), beachDayCacheKey(Object.assign({}, loc)));
  });

  console.log("extractFromDeviceLocation / extractFromTideTag");
  await test("extractFromDeviceLocation returns null when lat/lon/stationId is missing", async () => {
    assert.strictEqual(extractFromDeviceLocation(null), null);
    assert.strictEqual(extractFromDeviceLocation({ srfZone: "NJZ025" }), null);
    assert.strictEqual(extractFromDeviceLocation({ lat: 39.28, lon: -74.57 }), null);
  });
  await test("extractFromDeviceLocation normalizes a full record", async () => {
    const loc = extractFromDeviceLocation({
      name: "BRIGANTINE", stationId: "8534496", lat: 39.41, lon: -74.36,
      srfZone: "NJZ025", cwfZone: "ANZ452", srfOffice: "kphi", coastFacingDirection: "E", srfProductPrefix: "fzus51"
    });
    assert.deepStrictEqual(loc, {
      lat: 39.41, lon: -74.36, stationId: "8534496",
      srfZone: "NJZ025", coastFacingDirection: "E", srfOffice: "kphi", srfProductPrefix: "fzus51", townName: "BRIGANTINE"
    });
  });
  await test("extractFromTideTag never has srfOffice/srfProductPrefix -- tide-tags/ never stores them", async () => {
    const loc = extractFromTideTag({ stationId: "8534720", lat: 39.28, lon: -74.57, srfZone: "NJZ025", coastFacingDirection: "E", townName: "Ocean City" });
    assert.strictEqual(loc.srfOffice, null);
    assert.strictEqual(loc.srfProductPrefix, null);
    assert.strictEqual(loc.townName, "Ocean City");
  });
  await test("extractFromTideTag returns null when lat/lon/stationId is missing", async () => {
    assert.strictEqual(extractFromTideTag({ srfZone: "NJZ025" }), null);
  });

  console.log("collectActiveBeachDayLocations");
  await test("two devices sharing a town dedupe to one entry", async () => {
    const bucket = makeFakeBucket({
      "device-status/WC-A1.json": deviceStatusFile({ stationId: "8534720", lat: 39.28, lon: -74.57, srfZone: "NJZ025", coastFacingDirection: "E" }),
      "device-status/WC-A2.json": deviceStatusFile({ stationId: "8534720", lat: 39.28, lon: -74.57, srfZone: "NJZ025", coastFacingDirection: "E" })
    });
    const locs = await collectActiveBeachDayLocations(bucket);
    assert.strictEqual(locs.length, 1);
  });
  await test("device-status is preferred over locations/ for the same device", async () => {
    const bucket = makeFakeBucket({
      "device-status/WC-A1.json": deviceStatusFile({ stationId: "8534720", lat: 39.28, lon: -74.57, srfZone: "NJZ025", coastFacingDirection: "E" }),
      "locations/WC-A1.json": locationsFile({ stationId: "9999999", lat: 10, lon: 10, srfZone: "XXZ000", coastFacingDirection: "W" })
    });
    const locs = await collectActiveBeachDayLocations(bucket);
    assert.strictEqual(locs.length, 1);
    assert.strictEqual(locs[0].stationId, "8534720");
  });
  await test("locations/ is used for a device with no device-status entry", async () => {
    const bucket = makeFakeBucket({
      "locations/WC-B1.json": locationsFile({ stationId: "8534720", lat: 39.28, lon: -74.57, srfZone: "NJZ025", coastFacingDirection: "E" })
    });
    const locs = await collectActiveBeachDayLocations(bucket);
    assert.strictEqual(locs.length, 1);
    assert.strictEqual(locs[0].stationId, "8534720");
  });
  await test("tide-tags/ (standalone keychains) are included", async () => {
    const bucket = makeFakeBucket({
      "tide-tags/AAAAAAAAAABBBBBBBBBB.json": tideTagFile({ stationId: "8534720", lat: 39.28, lon: -74.57, srfZone: "NJZ025", coastFacingDirection: "E", townName: "Ocean City" })
    });
    const locs = await collectActiveBeachDayLocations(bucket);
    assert.strictEqual(locs.length, 1);
    assert.strictEqual(locs[0].townName, "Ocean City");
  });
  await test("when a complete record and an incomplete record share a key, the complete one (has srfOffice) wins -- regardless of which the scan sees first", async () => {
    const bucket = makeFakeBucket({
      // tide-tags/ sorts after device-status/ alphabetically, so this
      // exercises "complete wins even when it was seen FIRST" --
      "device-status/WC-C1.json": deviceStatusFile({ stationId: "8534720", lat: 39.28, lon: -74.57, srfZone: "NJZ025", coastFacingDirection: "E", srfOffice: "kphi", srfProductPrefix: "fzus51" }),
      "tide-tags/AAAAAAAAAABBBBBBBBBB.json": tideTagFile({ stationId: "8534720", lat: 39.28, lon: -74.57, srfZone: "NJZ025", coastFacingDirection: "E" })
    });
    const locs = await collectActiveBeachDayLocations(bucket);
    assert.strictEqual(locs.length, 1);
    assert.strictEqual(locs[0].srfOffice, "kphi");
  });
  await test("a malformed device/tag filename (path-traversal shape) is skipped", async () => {
    const bucket = makeFakeBucket({
      "device-status/../../etc/passwd.json": deviceStatusFile({ stationId: "8534720", lat: 39.28, lon: -74.57 })
    });
    const locs = await collectActiveBeachDayLocations(bucket);
    assert.strictEqual(locs.length, 0);
  });
  await test("a record missing lat/lon/stationId is skipped, not a crash", async () => {
    const bucket = makeFakeBucket({
      "device-status/WC-D1.json": deviceStatusFile({ srfZone: "NJZ025" })
    });
    const locs = await collectActiveBeachDayLocations(bucket);
    assert.strictEqual(locs.length, 0);
  });

  console.log("renderBeachDayForLocation");
  function hourlyTimesFor(dateStr) {
    const times = [];
    for (let h = 0; h < 24; h++) times.push(dateStr + "T" + String(h).padStart(2, "0") + ":00");
    return times;
  }
  function seriesWith(overrides) {
    const arr = new Array(24).fill(null);
    for (const [h, v] of Object.entries(overrides)) arr[Number(h)] = v;
    return arr;
  }
  function fakeFetch({ weather, marine, noaaPredictions, ripBulletin }) {
    return async (url) => {
      const u = new URL(url);
      if (u.hostname === "api.open-meteo.com") return { ok: true, json: async () => weather };
      if (u.hostname === "marine-api.open-meteo.com") return { ok: true, json: async () => marine };
      if (u.hostname === "api.tidesandcurrents.noaa.gov") return { ok: true, json: async () => ({ predictions: noaaPredictions || [] }) };
      if (u.hostname === "tgftp.nws.noaa.gov") return { ok: true, text: async () => ripBulletin || "" };
      throw new Error("unexpected host in test: " + u.hostname);
    };
  }
  const SAMPLE_WEATHER = {
    hourly: {
      time: hourlyTimesFor("2026-07-15"),
      temperature_2m: seriesWith({ 13: 81 }),
      wind_speed_10m: seriesWith({ 11: 10, 12: 12, 13: 14, 14: 13, 15: 11, 16: 8, 17: 9 }),
      wind_direction_10m: seriesWith({ 13: 225 }),
      precipitation: seriesWith({}),
      relative_humidity_2m: seriesWith({ 13: 62 }),
      weather_code: seriesWith({ 13: 2 })
    },
    daily: { temperature_2m_max: [84], temperature_2m_min: [69], uv_index_max: [8] }
  };
  const SAMPLE_MARINE = {
    hourly: {
      time: hourlyTimesFor("2026-07-15"),
      wave_height: seriesWith({ 13: 2.3 }), wave_period: seriesWith({ 13: 7 }),
      wave_direction: seriesWith({}), sea_surface_temperature: seriesWith({ 13: 72.4 })
    }
  };

  await test("renders a 792x272 image and fills in town/weekday/subtitle from the location + the given date", async () => {
    const { loadImage } = require("canvas");
    const { CANVAS_WIDTH, CANVAS_HEIGHT } = require("../lib/dynamic");
    const now = new Date("2026-07-15T16:00:00Z"); // noon EDT, a Wednesday
    const loc = { lat: 39.2776, lon: -74.5746, stationId: "8534720", srfZone: "NJZ024", srfOffice: "kphi", srfProductPrefix: "fzus51", coastFacingDirection: "E", townName: "Ocean City, NJ" };
    const fetchImpl = fakeFetch({ weather: SAMPLE_WEATHER, marine: SAMPLE_MARINE, noaaPredictions: [], ripBulletin: "" });
    const { binBuffer, pngBuffer } = await renderBeachDayForLocation(loc, now, fetchImpl);
    assert.ok(binBuffer.some((b) => b !== 0));
    const decoded = await loadImage(pngBuffer);
    assert.strictEqual(decoded.width, CANVAS_WIDTH);
    assert.strictEqual(decoded.height, CANVAS_HEIGHT);
  });

  console.log("regenerateBeachDayCache");
  await test("two devices sharing a location render ONCE and write ONE cache entry, not two", async () => {
    const bucket = makeFakeBucket({
      "device-status/WC-E1.json": deviceStatusFile({ stationId: "8534720", lat: 39.2776, lon: -74.5746, srfZone: "NJZ024", srfOffice: "kphi", srfProductPrefix: "fzus51", coastFacingDirection: "E" }),
      "device-status/WC-E2.json": deviceStatusFile({ stationId: "8534720", lat: 39.2776, lon: -74.5746, srfZone: "NJZ024", srfOffice: "kphi", srfProductPrefix: "fzus51", coastFacingDirection: "E" })
    });
    let fetchCount = 0;
    const dispatch = fakeFetch({ weather: SAMPLE_WEATHER, marine: SAMPLE_MARINE, noaaPredictions: [], ripBulletin: "" });
    const countingFetch = async (url) => { fetchCount++; return dispatch(url); };
    const now = new Date("2026-07-15T16:00:00Z");
    const result = await regenerateBeachDayCache(bucket, now, countingFetch);
    assert.strictEqual(result.locationCount, 1);
    assert.strictEqual(result.updated, 1);
    assert.strictEqual(result.failed, 0);
    const written = Array.from(bucket._store.keys()).filter((k) => k.startsWith("beach-day-cache/"));
    assert.strictEqual(written.length, 2); // one .bin + one .png, for the single deduped location
    // weather+marine+NOAA+rip-bulletin = 4 fetch calls for the ONE
    // location (full srfZone/srfOffice/srfProductPrefix here, so the
    // bulletin fetch fires too) -- not 8 for two devices.
    assert.strictEqual(fetchCount, 4);
  });
  await test("one location's render failure is counted but doesn't stop the others from writing", async () => {
    const bucket = makeFakeBucket({
      "device-status/WC-F1.json": deviceStatusFile({ stationId: "0000000", lat: 1, lon: 1, srfZone: "NONE", coastFacingDirection: null }),
      "device-status/WC-F2.json": deviceStatusFile({ stationId: "8534720", lat: 39.2776, lon: -74.5746, srfZone: "NJZ024", srfOffice: "kphi", srfProductPrefix: "fzus51", coastFacingDirection: "E" })
    });
    const goodDispatch = fakeFetch({ weather: SAMPLE_WEATHER, marine: SAMPLE_MARINE, noaaPredictions: [], ripBulletin: "" });
    const fetchImpl = async (url) => {
      const u = new URL(url);
      if (u.searchParams.get("latitude") === "1") throw new Error("network down for this one");
      return goodDispatch(url);
    };
    const now = new Date("2026-07-15T16:00:00Z");
    const result = await regenerateBeachDayCache(bucket, now, fetchImpl);
    assert.strictEqual(result.locationCount, 2);
    assert.strictEqual(result.updated, 1);
    assert.strictEqual(result.failed, 1);
  });

  console.log(passed + " passed, " + failed + " failed");
  if (failed > 0) process.exit(1);
})();
