"use strict";

// Exercises lib/hurricaneTracker.js against stubbed fetches returning the
// documented NHC CurrentStorms.json / Forecast-Advisory text shapes --
// never a live call (nhc.noaa.gov is unreachable from this dev sandbox;
// see hurricaneTracker.js's own header comment for the live-verification
// caveat this shares with the ESPN integration).

const assert = require("assert");
const { createCanvas } = require("canvas");
const {
  NHC_CURRENT_STORMS_URL,
  MAX_RELEVANT_MILES,
  haversineMiles,
  bearingCompass,
  classificationLabel,
  categoryFromWindKt,
  ktToMph,
  fetchActiveStorms,
  findNearestStorm,
  parseForecastTrack,
  fetchForecastTrack,
  pickClosestApproach,
  pickCoastlineTemplate,
  selectMapTrackPoints,
  fetchHurricaneTrackerCardData,
  drawHurricaneTrackerCard
} = require("../lib/hurricaneTracker");
const dynamic = require("../lib/dynamic");
dynamic.ensureFontsRegistered();

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

function whiteCanvas(w, h) {
  const c = createCanvas(w, h);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  return c;
}

function hasInkInRegion(canvas, x, y, w, h) {
  const data = canvas.getContext("2d").getImageData(x, y, w, h).data;
  for (let i = 0; i < data.length; i += 4) { if (data[i] < 200) return true; }
  return false;
}

const SAMPLE_FORECAST_TEXT = `
ZCZC MIATCMAT4 ALL
TROPICAL DEPRESSION NINE FORECAST/ADVISORY NUMBER   3
NWS NATIONAL HURRICANE CENTER MIAMI FL

INIT  06/2100Z 22.1N  95.6W   30 KT
FORECAST VALID  07/1600Z 23.4N  94.0W
 MAX WIND  35 KT...GUSTS  45 KT
FORECAST VALID  08/0800Z 25.9N  91.8W
 MAX WIND  55 KT...GUSTS  70 KT
FORECAST VALID  08/2000Z 27.6N  89.9W
 MAX WIND  75 KT...GUSTS  90 KT
FORECAST VALID  09/0800Z 29.3N  88.0W
 MAX WIND  85 KT...GUSTS 105 KT
`;

// 6 forecast points -- longer than the map panel's old hard-coded "first
// 4" cutoff -- where the point nearest Gulf Shores, AL is the 5th one
// (index 4), not the 4th. Reproduces a real published card where the
// closest-approach point fell past what the map was slicing off.
const LONG_FORECAST_TEXT = `
ZCZC MIATCMAT5 ALL
HURRICANE TEST FORECAST/ADVISORY NUMBER   7
NWS NATIONAL HURRICANE CENTER MIAMI FL

INIT  06/2100Z 22.1N  95.6W   30 KT
FORECAST VALID  07/1600Z 23.4N  94.0W
 MAX WIND  35 KT...GUSTS  45 KT
FORECAST VALID  08/0200Z 25.9N  91.8W
 MAX WIND  55 KT...GUSTS  70 KT
FORECAST VALID  08/1400Z 27.6N  89.9W
 MAX WIND  75 KT...GUSTS  90 KT
FORECAST VALID  09/0200Z 28.5N  89.0W
 MAX WIND  85 KT...GUSTS 100 KT
FORECAST VALID  09/1400Z 29.8N  88.0W
 MAX WIND  95 KT...GUSTS 115 KT
FORECAST VALID  10/0200Z 31.5N  86.5W
 MAX WIND  80 KT...GUSTS  95 KT
`;

const SAMPLE_STORM = {
  id: "al092026",
  name: "ISAIAS",
  classification: "TD",
  intensity: "35",
  latitudeNumeric: 22.1,
  longitudeNumeric: -95.6,
  forecastAdvisory: { advNum: "3", issuance: "2026-10-06T21:00:00.000Z", url: "https://www.nhc.noaa.gov/text/MIATCMAT4.shtml" }
};

function fetchImplFor(storms, forecastText, opts) {
  return async (url) => {
    const s = String(url);
    if (s === NHC_CURRENT_STORMS_URL) {
      if (opts && opts.currentStormsFail) return { ok: false, status: 500 };
      return { ok: true, async json() { return { activeStorms: storms }; } };
    }
    if (s.includes("MIATCMAT4")) {
      if (opts && opts.forecastFail) return { ok: false, status: 500 };
      if (opts && opts.forecastThrows) throw new Error("network down");
      return { ok: true, async text() { return forecastText; } };
    }
    throw new Error("unexpected fetch in test: " + s);
  };
}

(async () => {
  console.log("geometry (haversineMiles / bearingCompass)");
  await test("haversineMiles is 0 for the same point", () => {
    assert.strictEqual(Math.round(haversineMiles(30, -87, 30, -87)), 0);
  });
  await test("haversineMiles matches a known real-world distance (Gulf Shores, AL to the storm's real Oct 6 2026 position)", () => {
    const miles = haversineMiles(30.246, -87.7008, 22.1, -95.6);
    assert.ok(Math.abs(miles - 746) < 2, "got " + miles);
  });
  await test("bearingCompass: storm due south of town reads S", () => {
    assert.strictEqual(bearingCompass(30, -87, 20, -87), "S");
  });
  await test("bearingCompass: storm due west of town reads W", () => {
    assert.strictEqual(bearingCompass(30, -87, 30, -97), "W");
  });

  console.log("classificationLabel / categoryFromWindKt / ktToMph");
  await test("classificationLabel: HU at various knots maps to the right category", () => {
    assert.strictEqual(classificationLabel("HU", 70), "CAT 1");
    assert.strictEqual(classificationLabel("HU", 90), "CAT 2");
    assert.strictEqual(classificationLabel("HU", 100), "CAT 3");
    assert.strictEqual(classificationLabel("HU", 120), "CAT 4");
    assert.strictEqual(classificationLabel("HU", 140), "CAT 5");
  });
  await test("classificationLabel: TS/TD map to plain labels, not a category number", () => {
    assert.strictEqual(classificationLabel("TS", 50), "TROP. STORM");
    assert.strictEqual(classificationLabel("TD", 25), "TROP. DEPRESSION");
  });
  await test("classificationLabel: unknown/missing classification degrades instead of guessing", () => {
    assert.strictEqual(classificationLabel(undefined, 50), "UNKNOWN");
    assert.strictEqual(classificationLabel("EX", 50), "EX");
  });
  await test("categoryFromWindKt derives a category from wind speed ALONE -- a forecast point has no classification string of its own", () => {
    assert.strictEqual(categoryFromWindKt(25), "TROP. DEPRESSION");
    assert.strictEqual(categoryFromWindKt(50), "TROP. STORM");
    assert.strictEqual(categoryFromWindKt(85), "CAT 2");
    assert.strictEqual(categoryFromWindKt(140), "CAT 5");
    assert.strictEqual(categoryFromWindKt(NaN), "UNKNOWN");
  });
  await test("ktToMph converts, and degrades to null on a non-numeric input", () => {
    assert.strictEqual(ktToMph(100), 115);
    assert.strictEqual(ktToMph("not a number"), null);
  });

  console.log("fetchActiveStorms");
  await test("parses activeStorms out of a real-shaped response", async () => {
    const storms = await fetchActiveStorms(fetchImplFor([SAMPLE_STORM], SAMPLE_FORECAST_TEXT));
    assert.strictEqual(storms.length, 1);
    assert.strictEqual(storms[0].name, "ISAIAS");
  });
  await test("throws on a non-ok response (caller should retry next run, not treat as 'no storms')", async () => {
    await assert.rejects(
      () => fetchActiveStorms(fetchImplFor([], "", { currentStormsFail: true })),
      /NHC CurrentStorms fetch failed/
    );
  });
  await test("degrades to an empty array when activeStorms is missing/malformed, rather than throwing", async () => {
    const fetchImpl = async () => ({ ok: true, async json() { return {}; } });
    const storms = await fetchActiveStorms(fetchImpl);
    assert.deepStrictEqual(storms, []);
  });

  console.log("findNearestStorm");
  await test("picks the nearest of several storms", () => {
    const near = { name: "NEAR", latitudeNumeric: 30, longitudeNumeric: -87 };
    const far = { name: "FAR", latitudeNumeric: 10, longitudeNumeric: -40 };
    const result = findNearestStorm([far, near], 30.2, -87.5);
    assert.strictEqual(result.storm.name, "NEAR");
  });
  await test("returns null when nothing is within MAX_RELEVANT_MILES", () => {
    const farAway = { name: "FAR", latitudeNumeric: 10, longitudeNumeric: -40 };
    const result = findNearestStorm([farAway], 30.2, -87.5);
    assert.strictEqual(result, null);
    assert.ok(haversineMiles(30.2, -87.5, 10, -40) > MAX_RELEVANT_MILES, "test fixture should actually be out of range");
  });
  await test("skips a storm with missing/non-numeric coordinates instead of crashing", () => {
    const bad = { name: "BAD", latitudeNumeric: null, longitudeNumeric: undefined };
    const good = { name: "GOOD", latitudeNumeric: 30, longitudeNumeric: -87 };
    const result = findNearestStorm([bad, good], 30.2, -87.5);
    assert.strictEqual(result.storm.name, "GOOD");
  });
  await test("returns null for an empty storm list", () => {
    assert.strictEqual(findNearestStorm([], 30, -87), null);
  });

  console.log("parseForecastTrack");
  await test("parses all 4 FORECAST VALID blocks from a real-shaped advisory", () => {
    const points = parseForecastTrack(SAMPLE_FORECAST_TEXT, new Date("2026-10-06T21:00:00Z"));
    assert.strictEqual(points.length, 4);
    assert.strictEqual(points[0].lat, 23.4);
    assert.strictEqual(points[0].lon, -94.0);
    assert.strictEqual(points[0].windKt, 35);
  });
  await test("rolls over to the next month when the forecast day is earlier than the issuance day", () => {
    // Issued Oct 30; a forecast point dated the 2nd must mean Nov 2, not Oct 2.
    const text = "FORECAST VALID  02/1200Z 25.0N  85.0W\n MAX WIND  50 KT...GUSTS  60 KT";
    const points = parseForecastTrack(text, new Date("2026-10-30T12:00:00Z"));
    assert.strictEqual(points.length, 1);
    assert.strictEqual(points[0].validAt.getUTCMonth(), 10, "expected November (0-indexed 10)");
    assert.strictEqual(points[0].validAt.getUTCDate(), 2);
  });
  await test("returns an empty array for text with no FORECAST VALID lines, rather than throwing", () => {
    assert.deepStrictEqual(parseForecastTrack("nothing useful here", new Date()), []);
    assert.deepStrictEqual(parseForecastTrack(null, new Date()), []);
    assert.deepStrictEqual(parseForecastTrack(undefined, new Date()), []);
  });

  console.log("fetchForecastTrack (degrades gracefully -- this is an enhancement, not the core fetch)");
  await test("returns the parsed track on success", async () => {
    const points = await fetchForecastTrack("https://www.nhc.noaa.gov/text/MIATCMAT4.shtml", new Date("2026-10-06T21:00:00Z"), fetchImplFor([], SAMPLE_FORECAST_TEXT));
    assert.strictEqual(points.length, 4);
  });
  await test("returns [] (not a throw) on a non-ok response, a network error, or a missing URL", async () => {
    const notOk = await fetchForecastTrack("https://www.nhc.noaa.gov/text/MIATCMAT4.shtml", new Date(), fetchImplFor([], "", { forecastFail: true }));
    assert.deepStrictEqual(notOk, []);
    const networkDown = await fetchForecastTrack("https://www.nhc.noaa.gov/text/MIATCMAT4.shtml", new Date(), fetchImplFor([], "", { forecastThrows: true }));
    assert.deepStrictEqual(networkDown, []);
    const noUrl = await fetchForecastTrack(null, new Date(), fetchImplFor([], SAMPLE_FORECAST_TEXT));
    assert.deepStrictEqual(noUrl, []);
  });

  console.log("pickClosestApproach");
  await test("finds the track point nearest the given coordinates", () => {
    const track = parseForecastTrack(SAMPLE_FORECAST_TEXT, new Date("2026-10-06T21:00:00Z"));
    const result = pickClosestApproach(track, 30.246, -87.7008); // Gulf Shores, AL
    assert.ok(result);
    assert.strictEqual(result.point.windKt, 85, "the last/northernmost forecast point should be nearest a Gulf Coast town");
  });
  await test("returns null for an empty track", () => {
    assert.strictEqual(pickClosestApproach([], 30, -87), null);
  });

  console.log("pickCoastlineTemplate");
  await test("a Gulf Coast town (west of ~85W, south of 31N) gets the Gulf template", () => {
    const t = pickCoastlineTemplate(30.246, -87.7008);
    assert.ok(t.delta, "expected the Gulf template, which has the Mississippi delta feature");
  });
  await test("an Atlantic/Mid-Atlantic town falls back to the Mid-Atlantic template", () => {
    const t = pickCoastlineTemplate(39.2776, -74.5746); // Ocean City, NJ
    assert.ok(!t.delta, "expected the Mid-Atlantic template, which has no delta feature");
  });

  console.log("selectMapTrackPoints");
  await test("a track of 4 or fewer points is shown in full, in order", () => {
    const track = [{ v: 0 }, { v: 1 }, { v: 2 }];
    const result = selectMapTrackPoints(track, null);
    assert.deepStrictEqual(result.map((r) => r.point.v), [0, 1, 2]);
    assert.ok(result.every((r) => !r.isClosest), "no closestApproachIndex given -- nothing should be flagged");
  });
  await test("returns [] for an empty or missing track", () => {
    assert.deepStrictEqual(selectMapTrackPoints([], 0), []);
    assert.deepStrictEqual(selectMapTrackPoints(null, 0), []);
  });
  await test("a longer track always ends the plotted span AT the closest-approach index, not just the first 4 points", () => {
    const track = [{ v: 0 }, { v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }, { v: 5 }];
    const result = selectMapTrackPoints(track, 4);
    const last = result[result.length - 1];
    assert.strictEqual(last.point.v, 4, "the closest-approach point (index 4) must be the last one plotted, not index 3");
    assert.strictEqual(last.isClosest, true);
    assert.ok(result.length <= 4, "still respects the panel's ~4-point budget");
    assert.strictEqual(result[0].point.v, 0, "always starts from the current/first point");
  });
  await test("with no closest-approach data at all, falls back to the track's own last point", () => {
    const track = [{ v: 0 }, { v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }, { v: 5 }];
    const result = selectMapTrackPoints(track, null);
    assert.strictEqual(result[result.length - 1].point.v, 5);
    assert.ok(result.every((r) => !r.isClosest));
  });

  console.log("fetchHurricaneTrackerCardData (orchestration)");
  await test("no saved location at all skips the live fetch entirely and returns noActiveStorm", async () => {
    let called = false;
    const fetchImpl = async () => { called = true; throw new Error("should never be called"); };
    const data = await fetchHurricaneTrackerCardData({ lat: null, lon: null, townName: "Nowhere" }, new Date(), fetchImpl);
    assert.strictEqual(data.noActiveStorm, true);
    assert.strictEqual(data.townName, "Nowhere");
    assert.strictEqual(called, false);
  });
  await test("no storm within range returns noActiveStorm, with townName carried through", async () => {
    const data = await fetchHurricaneTrackerCardData(
      { lat: 39.2776, lon: -74.5746, townName: "Ocean City, NJ" },
      new Date("2026-10-06T22:00:00Z"),
      fetchImplFor([SAMPLE_STORM], SAMPLE_FORECAST_TEXT)
    );
    assert.strictEqual(data.noActiveStorm, true);
    assert.strictEqual(data.townName, "Ocean City, NJ");
  });
  await test("a real nearby storm returns the full card data, including a correctly-categorized closest approach", async () => {
    const data = await fetchHurricaneTrackerCardData(
      { lat: 30.246, lon: -87.7008, townName: "Gulf Shores, AL" },
      new Date("2026-10-06T22:00:00Z"),
      fetchImplFor([SAMPLE_STORM], SAMPLE_FORECAST_TEXT)
    );
    assert.strictEqual(data.noActiveStorm, false);
    assert.strictEqual(data.stormName, "ISAIAS");
    assert.strictEqual(data.direction, "SW");
    assert.ok(Math.abs(data.miles - 746) < 2);
    assert.strictEqual(data.classificationNow, "TROP. DEPRESSION");
    assert.ok(data.closestApproach);
    // The forecast strengthens this storm well past "depression" by its
    // closest approach -- this must NOT still read "TROP. DEPRESSION"
    // just because that's the storm's CURRENT classification.
    assert.strictEqual(data.closestApproach.classification, "CAT 2");
    assert.strictEqual(data.closestApproach.windMph, 98);
    assert.strictEqual(data.closestApproachIndex, 3, "closest approach is this track's last (4th) point");
  });
  await test("closestApproachIndex points past the map panel's old 4-point cutoff when that's where closest approach falls", async () => {
    const data = await fetchHurricaneTrackerCardData(
      { lat: 30.246, lon: -87.7008, townName: "Gulf Shores, AL" },
      new Date("2026-10-06T22:00:00Z"),
      fetchImplFor([SAMPLE_STORM], LONG_FORECAST_TEXT)
    );
    assert.strictEqual(data.track.length, 6);
    assert.strictEqual(data.closestApproachIndex, 4, "the nearest point is the 5th one, not one of the first 4");
    const plotted = selectMapTrackPoints(data.track, data.closestApproachIndex);
    const last = plotted[plotted.length - 1];
    assert.strictEqual(last.isClosest, true);
    assert.strictEqual(last.point.lat, data.track[4].lat, "the map must still plot the real closest-approach point, not stop at index 3");
  });
  await test("a failed forecast-track fetch still returns current position/intensity, with closestApproach null", async () => {
    const data = await fetchHurricaneTrackerCardData(
      { lat: 30.246, lon: -87.7008, townName: "Gulf Shores, AL" },
      new Date("2026-10-06T22:00:00Z"),
      fetchImplFor([SAMPLE_STORM], "", { forecastFail: true })
    );
    assert.strictEqual(data.noActiveStorm, false);
    assert.strictEqual(data.stormName, "ISAIAS");
    assert.strictEqual(data.closestApproach, null);
  });
  await test("a genuine CurrentStorms failure throws (caller should retry, not show a blank/wrong card)", async () => {
    await assert.rejects(
      () => fetchHurricaneTrackerCardData({ lat: 30.246, lon: -87.7008 }, new Date(), fetchImplFor([], "", { currentStormsFail: true })),
      /NHC CurrentStorms fetch failed/
    );
  });

  console.log("drawHurricaneTrackerCard");
  await test("draws the no-active-storm state without throwing, with real ink in the panel", () => {
    const c = whiteCanvas(792, 272);
    assert.doesNotThrow(() => {
      drawHurricaneTrackerCard(c.getContext("2d"), { noActiveStorm: true, townName: "Ocean City, NJ" });
    });
    assert.ok(hasInkInRegion(c, 0, 0, 792, 272));
  });
  await test("draws the full card (hero/closest/map panels) without throwing", async () => {
    const data = await fetchHurricaneTrackerCardData(
      { lat: 30.246, lon: -87.7008, townName: "Gulf Shores, AL" },
      new Date("2026-10-06T22:00:00Z"),
      fetchImplFor([SAMPLE_STORM], SAMPLE_FORECAST_TEXT)
    );
    const c = whiteCanvas(792, 272);
    assert.doesNotThrow(() => {
      drawHurricaneTrackerCard(c.getContext("2d"), Object.assign({ townLat: 30.246, townLon: -87.7008 }, data));
    });
    assert.ok(hasInkInRegion(c, 0, 0, 792, 272));
  });
  await test("draws the 'forecast track not available' fallback within the closest-approach panel when closestApproach is null, without throwing", () => {
    const c = whiteCanvas(792, 272);
    assert.doesNotThrow(() => {
      drawHurricaneTrackerCard(c.getContext("2d"), {
        noActiveStorm: false, townName: "Gulf Shores, AL", stormName: "ISAIAS",
        direction: "SW", miles: 746, classificationNow: "TROP. DEPRESSION", windMphNow: 40,
        track: [], closestApproach: null, townLat: 30.246, townLon: -87.7008
      });
    });
  });

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
