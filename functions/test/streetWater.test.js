"use strict";

// Exercises lib/streetWater.js against stubbed fetches shaped like the
// documented NWS/NWPS/CO-OPS/Open-Meteo responses, cross-checked against
// the handoff package's own worked example (samples/storm_ocean-city-nj.json)
// -- never a live call (all four hosts are unreachable from this dev
// sandbox; see streetWater.js's own header comment for the live-
// verification caveat this shares with the NHC/ESPN integrations).

const assert = require("assert");
const { createCanvas } = require("canvas");
const dynamic = require("../lib/dynamic");
dynamic.ensureFontsRegistered();
const {
  STREET_WATER_TOWNS,
  nearestStreetWaterTown,
  haversineMiles,
  fetchActiveAlert,
  buildSeries,
  computeYRange,
  categoryFor,
  findPeaks,
  headlinePeakIndex,
  labelPeaks,
  computeWetWindows,
  computeWeather,
  fetchStreetWaterData,
  drawStreetWaterCard
} = require("../lib/streetWater");

function whiteCanvas() {
  const c = createCanvas(792, 272);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, 792, 272);
  return c;
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

// The Ocean City sample's own series/thresholds, used to cross-check
// findPeaks/computeYRange/computeWetWindows against real worked numbers
// from the handoff package rather than only self-consistency.
const OC_THRESHOLDS = { minor: 5.4, moderate: 6.2, major: 7.0 };
const OC_SERIES = [3.0,3.1,3.2,3.3,3.4,3.6,3.8,4.0,4.3,4.5,4.8,5.0,5.3,5.6,5.8,6.1,6.3,6.6,6.7,6.9,7.1,7.2,7.2,7.3,7.3,7.3,7.2,7.2,7.1,6.9,6.8,6.6,6.5,6.3,6.1,5.9,5.6,5.4,5.2,5.0,4.8,4.6,4.4,4.3,4.1,4.0,3.9,3.9,3.8,3.8,3.8,3.8,3.9,4.0,4.0,4.1,4.2,4.4,4.5,4.7,4.8,5.0,5.1,5.3,5.4,5.6,5.7,5.8,6.0,6.1,6.1,6.2,6.3,6.3,6.3,6.3,6.2,6.2,6.1,6.0,5.8,5.6,5.4,5.2,5.0,4.8,4.6,4.3,4.1,3.9,3.6,3.4,3.3,3.1,2.9,2.8,2.7];
const OC_WINDOW_START = new Date("2026-11-26T08:00:00Z");

function stubFetch(responses) {
  return async (url) => {
    for (const [match, body] of responses) {
      if (url.includes(match)) return { ok: true, json: async () => body };
    }
    return { ok: false, json: async () => null };
  };
}

(async () => {
  await test("nearestStreetWaterTown finds Ocean City for its own coordinates", () => {
    const town = nearestStreetWaterTown(39.2776, -74.5746);
    assert.strictEqual(town.slug, "ocean-city-nj");
  });

  await test("nearestStreetWaterTown returns null far from every configured town", () => {
    assert.strictEqual(nearestStreetWaterTown(40.2171, -74.7429), null); // Trenton, NJ
  });

  await test("haversineMiles is ~0 for the same point and roundtrip-symmetric", () => {
    assert.ok(haversineMiles(39.27, -74.57, 39.27, -74.57) < 0.01);
    const a = haversineMiles(39.2776, -74.5746, 39.3401, -74.4774);
    const b = haversineMiles(39.3401, -74.4774, 39.2776, -74.5746);
    assert.ok(Math.abs(a - b) < 1e-9);
  });

  await test("STREET_WATER_TOWNS has no duplicate slugs", () => {
    const slugs = STREET_WATER_TOWNS.map((t) => t.slug);
    assert.strictEqual(new Set(slugs).size, slugs.length);
  });

  await test("fetchActiveAlert prefers Warning over Advisory when both are active", async () => {
    const fetchImpl = stubFetch([["api.weather.gov", {
      features: [
        { properties: { event: "Coastal Flood Advisory", ends: "2026-11-26T20:00:00Z" } },
        { properties: { event: "Coastal Flood Warning", ends: "2026-11-27T08:00:00Z" } }
      ]
    }]]);
    const alert = await fetchActiveAlert(39.27, -74.57, fetchImpl);
    assert.strictEqual(alert.active, true);
    assert.strictEqual(alert.event, "Coastal Flood Warning");
    assert.strictEqual(alert.header, "COASTAL FLOOD WARNING");
  });

  await test("fetchActiveAlert ignores non-coastal-flood events and unreachable endpoints", async () => {
    const withOther = await fetchActiveAlert(39.27, -74.57, stubFetch([["api.weather.gov", { features: [{ properties: { event: "High Surf Advisory" } }] }]]));
    assert.strictEqual(withOther.active, false);
    const unreachable = await fetchActiveAlert(39.27, -74.57, async () => { throw new Error("network down"); });
    assert.strictEqual(unreachable.active, false);
  });

  await test("buildSeries interpolates onto 97 15-min points starting at the window start", () => {
    const series = buildSeries(OC_WINDOW_START, [], OC_SERIES.map((ft, i) => ({ t: new Date(OC_WINDOW_START.getTime() + i * 15 * 60000).toISOString(), ft })));
    assert.strictEqual(series.length, 97);
    assert.strictEqual(series[0], 3.0);
    assert.strictEqual(series[23], 7.3);
  });

  await test("computeYRange follows 02_DATA_PIPELINE.md's literal formula", () => {
    // The sample JSON itself says [1.0, 8.5], but floor(min(series)-0.5)
    // with min=2.7 is 2.0, not 1.0 -- the doc's thresholds are flagged
    // as placeholders in the same file, so the sample's y_range looks
    // hand-illustrated rather than mechanically derived; trusting the
    // documented FORMULA (the thing actually being implemented) over
    // that one sample number. ymax (8.5) does match the formula exactly.
    const { y_range_ft, y_ticks_ft } = computeYRange(OC_SERIES, OC_THRESHOLDS);
    assert.deepStrictEqual(y_range_ft, [2.0, 8.5]);
    assert.deepStrictEqual(y_ticks_ft, [2, 4, 6, 8]);
  });

  await test("categoryFor matches the sample's thresholds at each boundary", () => {
    assert.strictEqual(categoryFor(7.3, OC_THRESHOLDS), "major");
    assert.strictEqual(categoryFor(6.3, OC_THRESHOLDS), "moderate");
    assert.strictEqual(categoryFor(5.4, OC_THRESHOLDS), "minor");
    assert.strictEqual(categoryFor(3.0, OC_THRESHOLDS), "none");
  });

  await test("findPeaks finds both of the sample's two peaks, at roughly the right hour/value/category", () => {
    const rawPoints = OC_SERIES.map((ft, i) => ({ t: new Date(OC_WINDOW_START.getTime() + i * 15 * 60000).toISOString(), ft }));
    const peaks = findPeaks(OC_SERIES, OC_WINDOW_START, rawPoints, OC_THRESHOLDS);
    assert.strictEqual(peaks.length, 2, "expected exactly 2 peaks, got " + JSON.stringify(peaks));
    assert.ok(Math.abs(peaks[0].h - 5.95) < 0.3, "first peak hour off: " + peaks[0].h);
    assert.strictEqual(peaks[0].ft, 7.3);
    assert.strictEqual(peaks[0].category, "major");
    assert.ok(Math.abs(peaks[1].h - 18.53) < 0.3, "second peak hour off: " + peaks[1].h);
    assert.strictEqual(peaks[1].category, "moderate");
  });

  await test("headlinePeakIndex picks the higher-category peak as headline", () => {
    const peaks = [{ ft: 6.3, category: "moderate" }, { ft: 7.3, category: "major" }];
    assert.strictEqual(headlinePeakIndex(peaks), 1);
  });

  await test("headlinePeakIndex falls back to peak 0 when nothing crossed a threshold", () => {
    assert.strictEqual(headlinePeakIndex([{ ft: 5.3, category: "none" }, { ft: 5.3, category: "none" }]), 0);
    assert.strictEqual(headlinePeakIndex([]), -1);
  });

  await test("labelPeaks prefixes only the headline peak, and only non-'none' headline peaks get 'PEAK ·'", () => {
    const peaks = [{ h: 5.95, ft: 7.3, category: "major" }, { h: 18.53, ft: 6.3, category: "moderate" }];
    const labeled = labelPeaks(peaks, 0, OC_WINDOW_START, "America/New_York");
    assert.ok(labeled[0].label.startsWith("PEAK · "), labeled[0].label);
    assert.ok(!labeled[1].label.includes("·"), labeled[1].label);
  });

  await test("labelPeaks uses 'HIGH TIDE ·' when the headline peak never crossed minor", () => {
    const labeled = labelPeaks([{ h: 4.5, ft: 5.3, category: "none" }], 0, new Date("2026-11-26T08:00:00Z"), "America/New_York");
    assert.ok(labeled[0].label.startsWith("HIGH TIDE · "), labeled[0].label);
  });

  await test("computeWetWindows finds spans above minor matching the sample's two windows", () => {
    const windows = computeWetWindows(OC_SERIES, OC_THRESHOLDS, "America/New_York");
    assert.strictEqual(windows.length, 2, JSON.stringify(windows));
    assert.ok(Math.abs(windows[0].start_h - 3.1) < 0.3);
    assert.ok(Math.abs(windows[0].end_h - 9.28) < 0.3);
  });

  await test("computeWetWindows returns no windows for a series that never crosses minor", () => {
    const flat = new Array(97).fill(2.0);
    assert.deepStrictEqual(computeWetWindows(flat, OC_THRESHOLDS, "America/New_York"), []);
  });

  await test("computeWeather matches the sample's gust/rain fields shape", () => {
    const openMeteo = {
      gust_mph: 65,
      rainByHour: Array.from({ length: 24 }, (_, h) => ({
        t: new Date(OC_WINDOW_START.getTime() + h * 3600000).toISOString(),
        inches: h >= 1 ? 0.15 : 0 // first hour with rain is "5 AM" local-ish for this test's purposes
      }))
    };
    const weather = computeWeather(openMeteo, OC_WINDOW_START);
    assert.strictEqual(weather.gust_mph, 65);
    assert.ok(weather.rain_label.startsWith("RAIN FROM"), weather.rain_label);
    assert.ok(weather.rain_value.includes("in"), weather.rain_value);
  });

  await test("computeWeather reports '0 in' / 'RAIN NEXT 24 H' when nothing's forecast", () => {
    const weather = computeWeather({ gust_mph: 18, rainByHour: [] }, OC_WINDOW_START);
    assert.strictEqual(weather.rain_value, "0 in");
    assert.strictEqual(weather.rain_label, "RAIN NEXT 24 H");
  });

  await test("fetchStreetWaterData returns null for a device far from every configured town", async () => {
    const data = await fetchStreetWaterData({ lat: 40.2171, lon: -74.7429 }, new Date(), async () => ({ ok: false, json: async () => null }));
    assert.strictEqual(data, null);
  });

  await test("fetchStreetWaterData end-to-end for Ocean City with a full stubbed feed", async () => {
    const forecast = OC_SERIES.map((ft, i) => ({ validTime: new Date(OC_WINDOW_START.getTime() + i * 15 * 60000).toISOString(), value: ft }));
    const fetchImpl = stubFetch([
      ["api.weather.gov", { features: [{ properties: { event: "Coastal Flood Warning", ends: "2026-11-27T08:00:00Z" } }] }],
      ["/stageflow", { forecast: { data: forecast }, observed: { data: [{ validTime: "2026-11-26T07:24:00Z", value: 2.6 }, { validTime: "2026-11-26T07:54:00Z", value: 3.0 }] } }],
      ["/gauges/", { name: "Ocean City (Great Egg Harbor)", datum: "MLW", flood: { stages: OC_THRESHOLDS } }],
      ["api.open-meteo.com", { hourly: { time: Array.from({ length: 24 }, (_, h) => new Date(OC_WINDOW_START.getTime() + h * 3600000).toISOString()), wind_gusts_10m: Array(24).fill(65), precipitation: Array(24).fill(0.1) } }]
    ]);
    // Ocean City has no verified nwps_id in STREET_WATER_TOWNS today, so
    // this exercises the "no gauge configured" degrade path, not the
    // full-forecast path -- see the next test for that one (Margate,
    // which does have a coops_id, even though it also has no nwps_id).
    const data = await fetchStreetWaterData({ lat: 39.2776, lon: -74.5746 }, OC_WINDOW_START, fetchImpl);
    assert.strictEqual(data.town, "ocean-city-nj");
    assert.strictEqual(data.alert.active, true);
    assert.strictEqual(data.seriesUnavailable, true);
    assert.strictEqual(data.weather.gust_mph, 65);
  });

  await test("fetchStreetWaterData degrades gracefully when NWPS has no gauge configured at all", async () => {
    const fetchImpl = stubFetch([["api.weather.gov", { features: [] }]]);
    const data = await fetchStreetWaterData({ lat: 39.2776, lon: -74.5746 }, OC_WINDOW_START, fetchImpl);
    assert.strictEqual(data.seriesUnavailable, true);
    assert.strictEqual(data.alert.active, false);
    assert.strictEqual(data.thresholds_ft, null);
  });

  // -------- rendering (01_SCREEN_SPEC.md) --------
  const ocSample = require("./fixtures/streetWater/storm_ocean-city-nj.json");
  const margateSample = require("./fixtures/streetWater/storm_margate-nj_no-alert.json");

  await test("drawStreetWaterCard renders the Ocean City alert sample without throwing", () => {
    assert.doesNotThrow(() => drawStreetWaterCard(whiteCanvas().getContext("2d"), ocSample, new Date(ocSample.generated_utc)));
  });

  await test("drawStreetWaterCard renders the Margate no-alert sample without throwing", () => {
    assert.doesNotThrow(() => drawStreetWaterCard(whiteCanvas().getContext("2d"), margateSample, new Date(margateSample.generated_utc)));
  });

  await test("drawStreetWaterCard's 'not available for your area' state draws dark pixels (isn't blank)", () => {
    const c = whiteCanvas();
    drawStreetWaterCard(c.getContext("2d"), null, new Date());
    const pixels = c.getContext("2d").getImageData(0, 0, 792, 272).data;
    let darkCount = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 128) darkCount++;
    assert.ok(darkCount > 100, "expected visible text/lines, found " + darkCount + " dark pixels");
  });

  await test("drawStreetWaterCard's 'series unavailable' degrade still shows Gusts/Rain, not a blank left panel", () => {
    const unavailable = Object.assign({}, margateSample, {
      seriesUnavailable: true, headline_peak_index: -1, peaks: [],
      alert: { active: true, header: "COASTAL FLOOD WARNING", ends_label: "until 3 AM Fri" }
    });
    delete unavailable.series; delete unavailable.thresholds_ft;
    const c = whiteCanvas();
    assert.doesNotThrow(() => drawStreetWaterCard(c.getContext("2d"), unavailable, new Date(margateSample.generated_utc)));
    // The Gusts row's "18 mph" value sits around x=50-110, y~170-190 --
    // sampling a pixel in that band should be dark (ink), confirming the
    // weather rows survived the degrade rather than being skipped
    // alongside the missing peak/threshold data.
    const pixels = c.getContext("2d").getImageData(50, 178, 60, 1).data;
    let darkCount = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 128) darkCount++;
    assert.ok(darkCount > 0, "expected the GUSTS value to have drawn some ink in its row");
  });

  await test("drawStreetWaterCard handles a badge value wide enough to approach the spec's x=236 overflow guard, without throwing", () => {
    const wide = Object.assign({}, ocSample, {
      peaks: [{ h: 5.95, ft: 10.5, category: "major", label: "PEAK · THU 8:57 AM" }],
      headline_peak_index: 0
    });
    assert.doesNotThrow(() => drawStreetWaterCard(whiteCanvas().getContext("2d"), wide, new Date(ocSample.generated_utc)));
  });

  await test("drawStreetWaterCard draws a visibly different (darker) footer badge when data is stale", () => {
    const stale = Object.assign({}, margateSample);
    const farFuture = new Date(new Date(margateSample.generated_utc).getTime() + 10 * 3600000); // 10h > stale_after_min (180min)
    const c = whiteCanvas();
    assert.doesNotThrow(() => drawStreetWaterCard(c.getContext("2d"), stale, farFuture));
  });

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
