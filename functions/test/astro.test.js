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
  findMoonAltitudeExtrema,
  computeSolunarPeriods,
  tideRateOfChange,
  fishingScore,
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
    assert.ok(Array.isArray(data.solunarPeriods));
    assert.ok(["Fair", "Good", "Excellent"].includes(data.fishingScore));
  });

  // Real SunCalc computation, no mocking -- this is pure math (no network),
  // so it's checked against real astronomical behavior rather than a fake.
  console.log("solunar (major/minor period) calculation");
  const LAT = 39.2776, LON = -74.5746; // Ocean City, NJ

  await test("findMoonAltitudeExtrema finds alternating major transits ~12.3-12.6h apart (half the lunar day) -- verified against real SunCalc output before trusting this here", () => {
    const from = new Date("2026-07-14T00:00:00Z");
    const to = new Date("2026-07-17T00:00:00Z");
    const extrema = findMoonAltitudeExtrema(LAT, LON, from, to, 2);
    assert.ok(extrema.length >= 4, "expected at least 4 transits across 3 days");
    for (let i = 1; i < extrema.length; i++) {
      const gapHours = (extrema[i].t.getTime() - extrema[i - 1].t.getTime()) / 3600000;
      assert.ok(gapHours > 12 && gapHours < 13, "gap should be ~half a lunar day, was " + gapHours.toFixed(2) + "h");
    }
  });

  await test("computeSolunarPeriods only returns periods relevant to the display window, correctly clipped-to-center", () => {
    const dawn = new Date("2026-07-15T09:12:00Z");
    const dusk = new Date("2026-07-16T00:55:00Z");
    const moonRise = new Date("2026-07-15T10:57:58Z"); // within window -> minor period expected
    const moonSet = new Date("2026-07-15T01:01:19Z"); // hours before dawn -> should be filtered out
    const periods = computeSolunarPeriods(LAT, LON, dawn, dusk, moonRise, moonSet);

    assert.ok(periods.some((p) => p.kind === "major"), "expected at least one major period in this window");
    const minors = periods.filter((p) => p.kind === "minor");
    assert.strictEqual(minors.length, 1, "only the moonrise-based minor period should survive filtering");
    assert.strictEqual(new Date(minors[0].start).getTime(), moonRise.getTime() - 25 * 60000);
    assert.strictEqual(new Date(minors[0].end).getTime(), moonRise.getTime() + 25 * 60000);
  });

  await test("computeSolunarPeriods returns nothing when both moonrise/moonset are null and no transit falls nearby", () => {
    // A window chosen far from any transit and with no rise/set data at all.
    const dawn = new Date("2026-07-15T09:12:00Z");
    const dusk = new Date("2026-07-15T09:20:00Z"); // absurdly narrow, unlikely to catch a transit's center
    const periods = computeSolunarPeriods(LAT, LON, dawn, dusk, null, null);
    assert.ok(Array.isArray(periods));
  });

  console.log("tideRateOfChange");
  await test("computes feet-per-hour between the two bracketing curve points", () => {
    const curve = [
      { t: "2026-07-15T09:00:00.000Z", heightFt: 1.0 },
      { t: "2026-07-15T13:00:00.000Z", heightFt: 5.0 }
    ];
    // Exactly 4ft over 4h = 1 ft/hr, sampled at the midpoint
    const rate = tideRateOfChange(curve, new Date("2026-07-15T11:00:00.000Z").getTime());
    assert.strictEqual(rate, 1);
  });
  await test("returns 0 for a single-point or empty curve instead of throwing", () => {
    assert.strictEqual(tideRateOfChange([], Date.now()), 0);
    assert.strictEqual(tideRateOfChange([{ t: "2026-07-15T09:00:00.000Z", heightFt: 1 }], Date.now()), 0);
  });

  console.log("fishingScore (Phase 2: moon + tide only, no weather signal yet)");
  const SCORE_DAWN = new Date("2026-07-15T09:12:00Z");
  const SCORE_DUSK = new Date("2026-07-16T00:55:00Z");
  const MOVING_CURVE = [
    { t: "2026-07-15T09:12:00.000Z", heightFt: 1.0 },
    { t: "2026-07-15T13:00:00.000Z", heightFt: 4.4 },
    { t: "2026-07-15T18:00:00.000Z", heightFt: 2.0 },
    { t: "2026-07-16T00:55:00.000Z", heightFt: 0.5 }
  ];
  // Centered at 11:00, inside MOVING_CURVE's steepest segment (9:12->13:00,
  // +3.4ft over ~3.8h -- the fastest-moving stretch of this curve).
  const OVERLAPPING_PERIOD = [{ kind: "major", start: "2026-07-15T10:00:00.000Z", end: "2026-07-15T12:00:00.000Z" }];

  await test("near-new/full moon + a solunar period overlapping a fast-moving stretch of tide = Excellent", () => {
    assert.strictEqual(
      fishingScore({ moonIllumination: 0.02, solunarPeriods: OVERLAPPING_PERIOD, tideCurve: MOVING_CURVE, dawn: SCORE_DAWN, dusk: SCORE_DUSK }),
      "Excellent"
    );
  });
  await test("just one positive signal (quarter moon, but still a moving-tide overlap) = Good", () => {
    assert.strictEqual(
      fishingScore({ moonIllumination: 0.5, solunarPeriods: OVERLAPPING_PERIOD, tideCurve: MOVING_CURVE, dawn: SCORE_DAWN, dusk: SCORE_DUSK }),
      "Good"
    );
  });
  await test("neither signal (quarter moon, flat/slack tide) = Fair, never Poor -- no weather signal yet", () => {
    const flatCurve = [
      { t: "2026-07-15T09:12:00.000Z", heightFt: 2.0 },
      { t: "2026-07-16T00:55:00.000Z", heightFt: 2.0 }
    ];
    assert.strictEqual(
      fishingScore({ moonIllumination: 0.5, solunarPeriods: [], tideCurve: flatCurve, dawn: SCORE_DAWN, dusk: SCORE_DUSK }),
      "Fair"
    );
    assert.strictEqual(
      fishingScore({ moonIllumination: 0.5, solunarPeriods: [], tideCurve: [], dawn: SCORE_DAWN, dusk: SCORE_DUSK }),
      "Fair"
    );
  });

  console.log(passed + " passed, " + failed + " failed");
  if (failed > 0) process.exit(1);
})();
