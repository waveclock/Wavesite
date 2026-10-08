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
  stormTypeWord,
  ktToMph,
  fetchActiveStorms,
  findNearestStorm,
  parseForecastTrack,
  fetchForecastTrack,
  pickClosestApproach,
  pickCoastlineTemplate,
  selectMapTrackPoints,
  computeTrackScale,
  projectTrackPoint,
  enforceMinRadiusFromAnchor,
  rectOverlapArea,
  layoutTrackLabels,
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
    assert.strictEqual(classificationLabel("TD", 25), "TD");
  });
  await test("classificationLabel: unknown/missing classification degrades instead of guessing", () => {
    assert.strictEqual(classificationLabel(undefined, 50), "UNKNOWN");
    assert.strictEqual(classificationLabel("EX", 50), "EX");
  });
  await test("categoryFromWindKt derives a category from wind speed ALONE -- a forecast point has no classification string of its own", () => {
    assert.strictEqual(categoryFromWindKt(25), "TD");
    assert.strictEqual(categoryFromWindKt(50), "TROP. STORM");
    assert.strictEqual(categoryFromWindKt(85), "CAT 2");
    assert.strictEqual(categoryFromWindKt(140), "CAT 5");
    assert.strictEqual(categoryFromWindKt(NaN), "UNKNOWN");
  });
  await test("ktToMph converts, and degrades to null on a non-numeric input", () => {
    assert.strictEqual(ktToMph(100), 115);
    assert.strictEqual(ktToMph("not a number"), null);
  });
  await test("stormTypeWord spells out the storm's type for the banner title", () => {
    assert.strictEqual(stormTypeWord("CAT 1"), "HURRICANE");
    assert.strictEqual(stormTypeWord("CAT 5"), "HURRICANE");
    assert.strictEqual(stormTypeWord("TROP. STORM"), "TROPICAL STORM");
    assert.strictEqual(stormTypeWord("TD"), "TROPICAL DEPRESSION");
    assert.strictEqual(stormTypeWord("UNKNOWN"), "", "omits the word rather than guessing on an unrecognized label");
    assert.strictEqual(stormTypeWord(undefined), "");
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
  await test("finds a point BETWEEN two real forecast points that's closer than either one alone -- NHC only publishes a position every 12-24h, the real path can swing closer in between", () => {
    // Town sits due north of the segment's midpoint -- the true closest
    // point on the straight line between A and B is that midpoint, well
    // inside the segment, not either endpoint.
    const a = { lat: 30.0, lon: -88.0, windKt: 60, validAt: new Date("2026-09-01T00:00:00Z") };
    const b = { lat: 30.0, lon: -86.0, windKt: 80, validAt: new Date("2026-09-01T12:00:00Z") };
    const townLat = 30.5, townLon = -87.0;
    const result = pickClosestApproach([a, b], townLat, townLon);
    const discreteMinMiles = Math.min(haversineMiles(townLat, townLon, a.lat, a.lon), haversineMiles(townLat, townLon, b.lat, b.lon));
    assert.ok(result.miles < discreteMinMiles, "interpolated distance (" + result.miles + ") should beat the nearest discrete point (" + discreteMinMiles + ")");
    assert.strictEqual(result.index, 1, "brackets through the segment's later endpoint");
    assert.ok(result.point.interpolated, "flagged as an interpolated point, not one of the two real ones");
    assert.ok(Math.abs(result.point.lat - 30.0) < 0.01, "the interpolated point should sit right on the line between A and B");
    assert.ok(result.point.windKt > 60 && result.point.windKt < 80, "wind speed interpolated between the two real readings");
    assert.ok(result.point.validAt.getTime() > a.validAt.getTime() && result.point.validAt.getTime() < b.validAt.getTime());
  });
  await test("falls back to a real discrete point when no segment's interior comes closer (the storm keeps moving straight toward town)", () => {
    const a = { lat: 25.0, lon: -90.0, windKt: 40, validAt: new Date("2026-09-01T00:00:00Z") };
    const b = { lat: 29.0, lon: -88.0, windKt: 70, validAt: new Date("2026-09-01T12:00:00Z") }; // the nearest point to town below
    const townLat = 29.0, townLon = -88.0;
    const result = pickClosestApproach([a, b], townLat, townLon);
    assert.ok(!result.point.interpolated, "point B itself is the true minimum -- no interior improvement");
    assert.strictEqual(result.index, 1);
    assert.ok(result.miles < 0.001);
  });
  await test("still works with only a single track point (no segment to check)", () => {
    const a = { lat: 30.0, lon: -88.0, windKt: 60, validAt: new Date("2026-09-01T00:00:00Z") };
    const result = pickClosestApproach([a], 30.5, -87.0);
    assert.strictEqual(result.index, 0);
    assert.ok(!result.point.interpolated);
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
  await test("a longer track always includes the closest-approach point, not just the first 4 points", () => {
    const track = [{ v: 0 }, { v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }, { v: 5 }];
    const result = selectMapTrackPoints(track, 4);
    const closestEntry = result.find((r) => r.isClosest);
    assert.ok(closestEntry, "the closest-approach point (index 4) must be included");
    assert.strictEqual(closestEntry.point.v, 4);
    assert.ok(result.length <= 4, "still respects the panel's ~4-point budget");
    assert.strictEqual(result[0].point.v, 0, "always starts from the current/first point");
  });
  await test("also shows one point AFTER closest approach when the real track has one, so the path visibly turns away", () => {
    const track = [{ v: 0 }, { v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }, { v: 5 }];
    const result = selectMapTrackPoints(track, 4);
    const last = result[result.length - 1];
    assert.strictEqual(last.point.v, 5, "the point after closest approach should be the last one plotted");
    assert.strictEqual(last.isClosest, false);
    assert.ok(result.length <= 4);
  });
  await test("no trailing point to show when closest approach IS the track's own last point", () => {
    const track = [{ v: 0 }, { v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }];
    const result = selectMapTrackPoints(track, 4);
    const last = result[result.length - 1];
    assert.strictEqual(last.point.v, 4);
    assert.strictEqual(last.isClosest, true);
  });
  await test("with no closest-approach data at all, falls back to the track's own last point", () => {
    const track = [{ v: 0 }, { v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }, { v: 5 }];
    const result = selectMapTrackPoints(track, null);
    assert.strictEqual(result[result.length - 1].point.v, 5);
    assert.ok(result.every((r) => !r.isClosest));
  });

  console.log("projectTrackPoint / computeTrackScale (real track map projection)");
  await test("a point due north of the anchor projects straight up (smaller y), not sideways", () => {
    const anchor = { x: 100, y: 100 };
    const p = projectTrackPoint(anchor, 30, -87, 31, -87, 1);
    assert.ok(p.y < anchor.y, "north should move up the canvas");
    assert.ok(Math.abs(p.x - anchor.x) < 0.01, "due north shouldn't shift x at all");
  });
  await test("a point due east of the anchor projects to a larger x, same y", () => {
    const anchor = { x: 100, y: 100 };
    const p = projectTrackPoint(anchor, 30, -87, 30, -86, 1);
    assert.ok(p.x > anchor.x, "east should move right");
    assert.ok(Math.abs(p.y - anchor.y) < 0.01, "due east shouldn't shift y at all");
  });
  await test("computeTrackScale shrinks to fit far points inside the given room, not just the max cap", () => {
    const anchor = { x: 560, y: 70 };
    const bounds = { x: 514, y: 48, w: 270, h: 216 };
    const farPoint = { lat: 32, lon: -84 }; // several hundred miles from a Gulf anchor
    const scale = computeTrackScale(anchor, 30.38, -86.86, [farPoint], bounds);
    assert.ok(scale < 0.6, "a far point should force a smaller scale than the zoom cap");
    assert.ok(scale > 0, "scale must stay positive");
  });
  await test("computeTrackScale stays at the zoom cap when every point is close", () => {
    const anchor = { x: 560, y: 150 };
    const bounds = { x: 514, y: 48, w: 270, h: 216 };
    const nearPoint = { lat: 30.40, lon: -86.84 }; // a couple miles away
    const scale = computeTrackScale(anchor, 30.38, -86.86, [nearPoint], bounds);
    assert.strictEqual(scale, 0.6, "shouldn't zoom in tighter than the cap just because the point is close");
  });

  console.log("enforceMinRadiusFromAnchor (keeps the town star visible)");
  await test("pushes a too-close point out to the minimum radius, preserving its direction", () => {
    const anchor = { x: 100, y: 100 };
    const tooClose = { x: 105, y: 100 }; // 5px east, inside a 26px floor
    const result = enforceMinRadiusFromAnchor(tooClose, anchor, 26);
    assert.ok(Math.abs(Math.hypot(result.x - anchor.x, result.y - anchor.y) - 26) < 0.01);
    assert.ok(result.x > anchor.x, "stays on the same (east) side");
    assert.strictEqual(result.y, anchor.y);
  });
  await test("leaves a point that's already far enough away untouched", () => {
    const anchor = { x: 100, y: 100 };
    const farEnough = { x: 160, y: 100 };
    const result = enforceMinRadiusFromAnchor(farEnough, anchor, 26);
    assert.deepStrictEqual(result, farEnough);
  });

  console.log("layoutTrackLabels (no label collisions, even for tightly clustered real points)");
  await test("three nearly-collinear, closely-spaced points (confirmed to overlap with an above/below-only layout) get non-overlapping label boxes", () => {
    const c = createCanvas(100, 100);
    const ctx = c.getContext("2d");
    const mapPanel = { x: 514, y: 48, w: 270, h: 216 };
    // Mirrors the real Isaias/Navarre Beach case that exposed the bug:
    // three points marching SSW-to-NNE along nearly the same bearing,
    // close enough together that a plain above/below choice collided.
    const positions = [
      { x: 534.0, y: 232.0, label: { day: "THU", time: "8PM" }, isClosest: false },
      { x: 559.6, y: 182.6, label: { day: "FRI", time: "8AM" }, isClosest: false },
      { x: 579.5, y: 139.7, label: { day: "FRI", time: "8PM" }, isClosest: true }
    ];
    const townBox = { x1: 570, y1: 100, x2: 600, y2: 130 };
    const layout = layoutTrackLabels(ctx, positions, mapPanel, [townBox]);
    ctx.font = "bold 13px sans-serif";
    const boxes = layout.map((l, i) => {
      const w = ctx.measureText(positions[i].label.day + " " + positions[i].label.time).width;
      const halfW = w / 2 + 3;
      return l.align === "center"
        ? { x1: l.labelX - halfW, x2: l.labelX + halfW, y1: l.labelY - 15, y2: l.labelY + 4 }
        : { x1: Math.min(l.labelX, l.labelX + (l.align === "left" ? w : -w)), x2: Math.max(l.labelX, l.labelX + (l.align === "left" ? w : -w)), y1: l.labelY - 9, y2: l.labelY + 9 };
    });
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        assert.strictEqual(rectOverlapArea(boxes[i], boxes[j]), 0, "labels " + i + " and " + j + " overlap");
      }
      assert.strictEqual(rectOverlapArea(boxes[i], townBox), 0, "label " + i + " overlaps the town marker");
    }
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
    assert.strictEqual(data.classificationNow, "TD");
    assert.ok(data.closestApproach);
    // The forecast strengthens this storm well past "depression" by its
    // closest approach -- this must NOT still read "TD" just because
    // that's the storm's CURRENT classification.
    assert.strictEqual(data.closestApproach.classification, "CAT 2");
    assert.strictEqual(data.closestApproach.windMph, 98);
    assert.strictEqual(data.closestApproachIndex, 3, "closest approach is this track's last (4th) point");
  });
  await test("closestApproachIndex points well past the map panel's old 4-point cutoff, and segment interpolation finds an even closer pass than any single discrete point", async () => {
    const data = await fetchHurricaneTrackerCardData(
      { lat: 30.246, lon: -87.7008, townName: "Gulf Shores, AL" },
      new Date("2026-10-06T22:00:00Z"),
      fetchImplFor([SAMPLE_STORM], LONG_FORECAST_TEXT)
    );
    assert.strictEqual(data.track.length, 6);
    assert.strictEqual(data.closestApproachIndex, 5, "the real forecast point bracketing the interpolated minimum is the 6th one");
    // The nearest single discrete point (index 4) is ~36 mi away -- the
    // true path between it and index 5 swings much closer than either
    // endpoint on its own.
    assert.ok(data.closestApproach.miles < 10, "segment interpolation should find a much closer pass than any single discrete point here, got " + data.closestApproach.miles);
    const plotted = selectMapTrackPoints(data.track, data.closestApproachIndex);
    const closestEntry = plotted.find((p) => p.isClosest);
    assert.ok(closestEntry, "the map must still plot a real bracketing point for the closest approach");
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
        direction: "SW", miles: 746, classificationNow: "TD", windMphNow: 40,
        track: [], closestApproach: null, townLat: 30.246, townLon: -87.7008
      });
    });
  });
  await test("a synthetic very-long classification string (a safety net -- real classifications are all short now that 'TD' replaced 'TROP. DEPRESSION') in the closest-approach panel's middle block doesn't throw, and still shrinks to fit rather than overlapping the numbers", () => {
    const c = whiteCanvas(792, 272);
    assert.doesNotThrow(() => {
      drawHurricaneTrackerCard(c.getContext("2d"), {
        noActiveStorm: false, townName: "Ocean City, NJ", stormName: "Nine",
        direction: "SSE", miles: 920, classificationNow: "SOMETHING VERY LONG", windMphNow: null,
        track: [
          { lat: 36.0, lon: -71.0, label: { day: "WED", time: "8AM" } },
          { lat: 37.5, lon: -72.5, label: { day: "WED", time: "8PM" } }
        ],
        closestApproachIndex: 1,
        closestApproach: { miles: 410, classification: "SOMETHING VERY LONG", windMph: null, label: { day: "WED", time: "8PM" } },
        townLat: 39.2776, townLon: -74.5746
      });
    });
  });

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
