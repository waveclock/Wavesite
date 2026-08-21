"use strict";

// Exercises lib/astro.js directly with a stubbed fetch (no live NOAA
// call) -- see the header comment in lib/astro.js for why the NOAA fetch
// itself couldn't be live-verified from this development sandbox.

const assert = require("assert");
const {
  moonPhaseName,
  formatLocalTime,
  noaaDateParam,
  parseNoaaGmtTimestamp,
  fetchNoaaPredictions,
  fetchTideCardData
} = require("../lib/astro");

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

function mockNoaaFetch(predictionsByInterval) {
  return async (url) => {
    const interval = new URL(url).searchParams.get("interval");
    return { json: async () => ({ predictions: predictionsByInterval[interval] || [] }) };
  };
}

(async () => {
  await test("moonPhaseName buckets the 8 named phases in order", () => {
    assert.strictEqual(moonPhaseName(0), "New Moon");
    assert.strictEqual(moonPhaseName(0.1), "Waxing Crescent");
    assert.strictEqual(moonPhaseName(0.25), "First Quarter");
    assert.strictEqual(moonPhaseName(0.35), "Waxing Gibbous");
    assert.strictEqual(moonPhaseName(0.5), "Full Moon");
    assert.strictEqual(moonPhaseName(0.6), "Waning Gibbous");
    assert.strictEqual(moonPhaseName(0.75), "Last Quarter");
    assert.strictEqual(moonPhaseName(0.9), "Waning Crescent");
    assert.strictEqual(moonPhaseName(0.999), "New Moon");
  });

  await test("moonPhaseName normalizes an out-of-range phase (e.g. exactly 1, or negative)", () => {
    assert.strictEqual(moonPhaseName(1), "New Moon");
    assert.strictEqual(moonPhaseName(-0.1), moonPhaseName(0.9));
  });

  await test("formatLocalTime converts a UTC instant to the right wall-clock time (handles DST correctly, not just a fixed UTC offset)", () => {
    const summer = new Date("2026-07-15T19:15:00Z"); // EDT (UTC-4) in July
    assert.strictEqual(formatLocalTime(summer, "America/New_York"), "3:15 PM");
    const winter = new Date("2026-01-15T19:15:00Z"); // EST (UTC-5) in January
    assert.strictEqual(formatLocalTime(winter, "America/New_York"), "2:15 PM");
  });

  await test("formatLocalTime returns null for a null date (e.g. a moonless day's rise/set)", () => {
    assert.strictEqual(formatLocalTime(null, "America/New_York"), null);
  });

  await test("noaaDateParam formats a UTC date as NOAA's \"yyyyMMdd HH:mm\"", () => {
    assert.strictEqual(noaaDateParam(new Date("2026-07-05T06:07:00Z")), "20260705 06:07");
  });

  await test("parseNoaaGmtTimestamp reads NOAA's space-separated string as UTC, not local time", () => {
    const parsed = parseNoaaGmtTimestamp("2026-07-15 14:00");
    assert.strictEqual(parsed.toISOString(), "2026-07-15T14:00:00.000Z");
  });

  await test("fetchNoaaPredictions parses heights as numbers and flags isHigh only for interval=hilo", () => {
    return (async () => {
      const curveFetch = mockNoaaFetch({ h: [{ t: "2026-07-15 10:00", v: "2.345" }] });
      const curve = await fetchNoaaPredictions("8534720", new Date(), new Date(), "h", curveFetch);
      assert.strictEqual(curve.length, 1);
      assert.strictEqual(curve[0].heightFt, 2.345);
      assert.strictEqual(curve[0].isHigh, null);

      const hiloFetch = mockNoaaFetch({ hilo: [{ t: "2026-07-15 13:22", v: "4.4", type: "H" }, { t: "2026-07-15 07:14", v: "0.6", type: "L" }] });
      const hilo = await fetchNoaaPredictions("8534720", new Date(), new Date(), "hilo", hiloFetch);
      assert.strictEqual(hilo.length, 2);
      assert.strictEqual(hilo[0].isHigh, true);
      assert.strictEqual(hilo[1].isHigh, false);
    })();
  });

  await test("fetchNoaaPredictions throws on a NOAA-reported error (e.g. an unknown/retired station) instead of returning garbage", async () => {
    const errorFetch = async () => ({ json: async () => ({ error: { message: "No data was found. This product may not be offered at this station." } }) });
    await assert.rejects(
      () => fetchNoaaPredictions("0000000", new Date(), new Date(), "h", errorFetch),
      /No data was found/
    );
  });

  await test("fetchTideCardData assembles one payload from suncalc + both NOAA calls, filtering tideExtrema to only real hi/lo points", async () => {
    const mockFetch = mockNoaaFetch({
      h: [{ t: "2026-07-15 12:00", v: "2.00" }, { t: "2026-07-15 13:00", v: "2.50" }],
      hilo: [{ t: "2026-07-15 07:14", v: "0.60", type: "L" }, { t: "2026-07-15 13:22", v: "4.40", type: "H" }]
    });
    const now = new Date("2026-07-15T16:00:00Z");
    const data = await fetchTideCardData({ lat: 39.2776, lon: -74.5746, stationId: "8534720" }, now, mockFetch);

    assert.strictEqual(data.timeZone, "America/New_York");
    assert.ok(data.dawn.label && data.sunrise.label && data.sunset.label && data.dusk.label);
    assert.ok(typeof data.moon.illumination === "number" && data.moon.illumination >= 0 && data.moon.illumination <= 1);
    assert.ok(typeof data.moon.phaseName === "string");
    assert.strictEqual(data.tideCurve.length, 2);
    assert.strictEqual(data.tideCurve[0].heightFt, 2.00);
    assert.strictEqual(data.tideExtrema.length, 2);
    assert.strictEqual(data.tideExtrema[0].isHigh, false);
    assert.strictEqual(data.tideExtrema[0].label, "3:14 AM");
    assert.strictEqual(data.tideExtrema[1].isHigh, true);
  });

  console.log(passed + " passed, " + failed + " failed");
  if (failed > 0) process.exit(1);
})();
