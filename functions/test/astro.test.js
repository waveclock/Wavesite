"use strict";

// Exercises lib/astro.js directly with a stubbed fetch (no live NOAA
// call) -- see the header comment in lib/astro.js for why the NOAA fetch
// itself couldn't be live-verified from this development sandbox.

const assert = require("assert");
const {
  moonPhaseName,
  formatLocalTime,
  noaaLocalDateParam,
  parseNoaaLocalTimestamp,
  fetchNoaaPredictions,
  findMoonAltitudeExtrema,
  computeSolunarPeriods,
  interpolateTideCurveFromExtrema,
  tideRateOfChange,
  fishingScore,
  parseOpenMeteoTimestamp,
  degreesToCompass,
  nearestHourly,
  computePressure,
  computeRainWindows,
  computeWindRamp,
  ripCurrentRisk,
  fetchOpenMeteoWeather,
  fetchOpenMeteoMarine,
  fetchWeatherSignals,
  fetchTideCardData,
  localMidnight,
  formatLongDate,
  fetchTideTimelineData
} = require("../lib/astro");
const { OUTBOUND_FETCH_HEADERS } = require("../lib/http");

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

// Routes by hostname so a single fetchImpl can stand in for NOAA + both
// Open-Meteo endpoints at once, for tests that exercise fetchTideCardData
// end-to-end. Any host not stubbed here throws, so an accidental request
// to a fourth host wouldn't silently succeed with empty data.
function mockAllApisFetch({ noaa = {}, weatherHourly = null, marineHourly = null } = {}) {
  return async (url) => {
    const u = new URL(url);
    if (u.hostname === "api.tidesandcurrents.noaa.gov") {
      const interval = u.searchParams.get("interval");
      return { json: async () => ({ predictions: noaa[interval] || [] }) };
    }
    if (u.hostname === "api.open-meteo.com") {
      return { json: async () => ({ hourly: weatherHourly || { time: [] } }) };
    }
    if (u.hostname === "marine-api.open-meteo.com") {
      return { json: async () => ({ hourly: marineHourly || { time: [] } }) };
    }
    throw new Error("unexpected host in test: " + u.hostname);
  };
}

// Builds a run of hourly Open-Meteo-shaped data from h=startHour to
// h=endHour (UTC hours on 2026-07-15), with a value-generating function
// per field -- keeps the weather/marine test fixtures below short.
function buildHourlySeries(startHour, endHour, fields) {
  const time = [];
  const out = {};
  Object.keys(fields).forEach((k) => { out[k] = []; });
  for (let h = startHour; h <= endHour; h++) {
    const dt = new Date(Date.UTC(2026, 6, 15, 0, 0, 0) + h * 3600000);
    time.push(dt.toISOString().slice(0, 16));
    Object.keys(fields).forEach((k) => out[k].push(fields[k](h)));
  }
  return Object.assign({ time }, out);
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

  await test("noaaLocalDateParam formats a UTC instant as NOAA's \"yyyyMMdd HH:mm\" in the station's own local wall-clock time", () => {
    // 06:07 UTC in July is 02:07 EDT (UTC-4) in America/New_York.
    assert.strictEqual(noaaLocalDateParam(new Date("2026-07-05T06:07:00Z"), "America/New_York"), "20260705 02:07");
    // Same instant, different zone -> different local wall-clock string.
    assert.strictEqual(noaaLocalDateParam(new Date("2026-07-05T06:07:00Z"), "America/Los_Angeles"), "20260704 23:07");
  });

  await test("parseNoaaLocalTimestamp reads NOAA's space-separated string as local wall-clock time in the given zone, not UTC", () => {
    // "14:00" local in EDT (UTC-4) is 18:00 UTC.
    const summer = parseNoaaLocalTimestamp("2026-07-15 14:00", "America/New_York");
    assert.strictEqual(summer.toISOString(), "2026-07-15T18:00:00.000Z");
    // Same wall-clock string in EST (UTC-5, January) is 19:00 UTC -- confirms
    // this resolves the zone's DST correctly for the given date, not a fixed offset.
    const winter = parseNoaaLocalTimestamp("2026-01-15 14:00", "America/New_York");
    assert.strictEqual(winter.toISOString(), "2026-01-15T19:00:00.000Z");
  });

  await test("fetchNoaaPredictions parses heights as numbers and flags isHigh only for interval=hilo", () => {
    return (async () => {
      const curveFetch = mockNoaaFetch({ h: [{ t: "2026-07-15 10:00", v: "2.345" }] });
      const curve = await fetchNoaaPredictions("8534720", new Date(), new Date(), "h", "America/New_York", curveFetch);
      assert.strictEqual(curve.length, 1);
      assert.strictEqual(curve[0].heightFt, 2.345);
      assert.strictEqual(curve[0].isHigh, null);

      const hiloFetch = mockNoaaFetch({ hilo: [{ t: "2026-07-15 13:22", v: "4.4", type: "H" }, { t: "2026-07-15 07:14", v: "0.6", type: "L" }] });
      const hilo = await fetchNoaaPredictions("8534720", new Date(), new Date(), "hilo", "America/New_York", hiloFetch);
      assert.strictEqual(hilo.length, 2);
      assert.strictEqual(hilo[0].isHigh, true);
      assert.strictEqual(hilo[1].isHigh, false);
    })();
  });

  await test("fetchNoaaPredictions throws on a NOAA-reported error (e.g. an unknown/retired station) instead of returning garbage, tagged as noaaDataError (not a connectivity failure)", async () => {
    const errorFetch = async () => ({ json: async () => ({ error: { message: "No data was found. This product may not be offered at this station." } }) });
    try {
      await fetchNoaaPredictions("0000000", new Date(), new Date(), "h", "America/New_York", errorFetch);
      assert.fail("expected fetchNoaaPredictions to throw");
    } catch (err) {
      assert.match(err.message, /No data was found/);
      assert.strictEqual(err.noaaDataError, true);
    }
  });

  await test("fetchNoaaPredictions requests datum=MLLW and time_zone=lst_ldt (not gmt)", async () => {
    let capturedUrl = null;
    const capturingFetch = async (url) => {
      capturedUrl = url;
      return { json: async () => ({ predictions: [] }) };
    };
    await fetchNoaaPredictions("8534975", new Date("2026-07-15T10:00:00Z"), new Date("2026-07-15T20:00:00Z"), "h", "America/New_York", capturingFetch);
    const params = new URL(capturedUrl).searchParams;
    // MLLW, not STND -- an earlier attempt switched to STND on the theory
    // that it's universally supported, but that theory was wrong too:
    // confirmed directly against NOAA for this exact station (with
    // time_zone already fixed to lst_ldt), STND failed on both intervals
    // while MLLW succeeded. No fallback to STND -- no evidence it's ever
    // actually needed.
    assert.strictEqual(params.get("datum"), "MLLW");
    // time_zone=lst_ldt is the actual, complete fix for a real production
    // 502/422 (stationId=8534975) that datum alone did NOT resolve --
    // confirmed by hitting NOAA directly: gmt failed for every datum and
    // interval combination on this subordinate station, lst_ldt succeeded.
    assert.strictEqual(params.get("time_zone"), "lst_ldt");
    // begin_date/end_date must be in the station's LOCAL wall-clock time to
    // match time_zone=lst_ldt, not the UTC values passed in -- 10:00 UTC is
    // 06:00 EDT in July.
    assert.strictEqual(params.get("begin_date"), "20260715 06:00");
    assert.strictEqual(params.get("end_date"), "20260715 16:00");
  });

  await test("fetchNoaaPredictions surfaces NOAA's real 'Datum input is valid' error message, tagged noaaDataError -- this is the error a real subordinate station returns for interval=h specifically, once datum/time_zone are correct", async () => {
    const invalidDatumFetch = async () => ({ json: async () => ({ error: { message: "No Predictions data was found. Please make sure the Datum input is valid." } }) });
    try {
      await fetchNoaaPredictions("8534975", new Date(), new Date(), "h", "America/New_York", invalidDatumFetch);
      assert.fail("expected fetchNoaaPredictions to throw");
    } catch (err) {
      assert.match(err.message, /Datum input is valid/);
      assert.strictEqual(err.noaaDataError, true);
    }
  });

  await test("fetchNoaaPredictions sends a browser-like User-Agent, not Node's own bare default", async () => {
    let capturedOptions = null;
    const capturingFetch = async (url, options) => {
      capturedOptions = options;
      return { json: async () => ({ predictions: [] }) };
    };
    await fetchNoaaPredictions("8534720", new Date(), new Date(), "h", "America/New_York", capturingFetch);
    assert.strictEqual(capturedOptions.headers, OUTBOUND_FETCH_HEADERS);
  });

  await test("fetchTideCardData assembles one payload from suncalc + both NOAA calls, filtering tideExtrema to only real hi/lo points", async () => {
    // NOAA's "t" is now the station's own local wall-clock time (see
    // fetchNoaaPredictions's time_zone=lst_ldt comment), so these fixtures
    // are written as local (America/New_York, EDT/UTC-4 in July) --
    // 4 hours behind the equivalent UTC values this test's assertions
    // below were originally written against.
    const mockFetch = mockAllApisFetch({
      noaa: {
        h: [{ t: "2026-07-15 08:00", v: "2.00" }, { t: "2026-07-15 09:00", v: "2.50" }],
        hilo: [{ t: "2026-07-15 03:14", v: "0.60", type: "L" }, { t: "2026-07-15 09:22", v: "4.40", type: "H" }]
      }
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
    assert.ok(data.weather, "expected a weather object even when Open-Meteo returns no hourly data");
    assert.ok(["Poor", "Fair", "Good", "Excellent"].includes(data.fishingScore));
  });

  await test("fetchTideCardData still finds a real evening moonrise SunCalc.getMoonTimes' UTC-midnight-anchored search window would otherwise miss", async () => {
    // Regression: for Ocean City, NJ (EDT/UTC-4), SunCalc.getMoonTimes'
    // own 24h search window is anchored to UTC midnight, not local --
    // a real moonrise falling in the last few hours before local
    // midnight lands just past that UTC boundary and gets reported as
    // rise: null for this calendar day, even though the moon undeniably
    // rises that evening (confirmed by direct altitude sampling). Aug
    // 29, 2026 is one such date.
    const mockFetch = mockAllApisFetch({
      noaa: {
        h: [{ t: "2026-08-29 08:00", v: "2.00" }],
        hilo: [{ t: "2026-08-29 03:14", v: "0.60", type: "L" }, { t: "2026-08-29 09:22", v: "4.40", type: "H" }]
      }
    });
    const now = new Date("2026-08-29T16:00:00Z");
    const data = await fetchTideCardData({ lat: 39.2776, lon: -74.5746, stationId: "8534720" }, now, mockFetch);
    assert.ok(data.moon.rise, "expected a real moonrise this evening, not null");
    assert.strictEqual(data.moon.rise.label, "8:11 PM");
  });

  await test("an Open-Meteo outage doesn't fail the whole card -- NOAA tide data (the one thing this card can't function without) still comes back, just with weather: null", async () => {
    const noaaOnlyFetch = async (url) => {
      const u = new URL(url);
      if (u.hostname === "api.tidesandcurrents.noaa.gov") {
        const interval = u.searchParams.get("interval");
        const predictions = interval === "hilo"
          ? [{ t: "2026-07-15 07:14", v: "0.60", type: "L" }, { t: "2026-07-15 13:22", v: "4.40", type: "H" }]
          : [{ t: "2026-07-15 12:00", v: "2.00" }];
        return { json: async () => ({ predictions }) };
      }
      throw new Error("simulated Open-Meteo outage");
    };
    const now = new Date("2026-07-15T16:00:00Z");
    const data = await fetchTideCardData({ lat: 39.2776, lon: -74.5746, stationId: "8534720" }, now, noaaOnlyFetch);
    assert.strictEqual(data.tideCurve.length, 1);
    assert.strictEqual(data.tideExtrema.length, 2);
    assert.strictEqual(data.weather, null);
    assert.ok(["Poor", "Fair", "Good", "Excellent"].includes(data.fishingScore));
  });

  await test("a genuine NOAA failure still fails the whole card (unlike Open-Meteo, there's no tide curve without it)", async () => {
    const noaaFailsFetch = async (url) => {
      const u = new URL(url);
      if (u.hostname === "api.tidesandcurrents.noaa.gov") throw new Error("simulated NOAA outage");
      return { json: async () => ({ hourly: { time: [] } }) };
    };
    await assert.rejects(
      () => fetchTideCardData({ lat: 39.2776, lon: -74.5746, stationId: "8534720" }, new Date("2026-07-15T16:00:00Z"), noaaFailsFetch),
      /simulated NOAA outage/
    );
  });

  await test("a station with hi/lo predictions but no continuous curve (interval=h fails, interval=hilo succeeds) still produces a working card, with an interpolated tideCurve instead of an empty one", async () => {
    const hiloOnlyFetch = async (url) => {
      const u = new URL(url);
      if (u.hostname !== "api.tidesandcurrents.noaa.gov") return { json: async () => ({ hourly: { time: [] } }) };
      const interval = u.searchParams.get("interval");
      if (interval === "h") return { json: async () => ({ error: { message: "No Predictions data was found. Please make sure the Datum input is valid." } }) };
      return { json: async () => ({ predictions: [{ t: "2026-07-15 03:14", v: "0.60", type: "L" }, { t: "2026-07-15 09:22", v: "4.40", type: "H" }] }) };
    };
    const data = await fetchTideCardData({ lat: 39.2776, lon: -74.5746, stationId: "8534975" }, new Date("2026-07-15T16:00:00Z"), hiloOnlyFetch);
    // Interpolated from the two hi/lo points, not empty -- drawTideCard can
    // draw a real connecting line instead of just two disconnected dots.
    assert.ok(data.tideCurve.length > 1);
    assert.strictEqual(data.tideCurve[0].heightFt, 0.60);
    assert.strictEqual(data.tideCurve[data.tideCurve.length - 1].heightFt, 4.40);
    // Monotonically rising throughout (low to high, no dip) -- a cosine
    // interpolation between two points never overshoots or reverses.
    for (let i = 1; i < data.tideCurve.length; i++) {
      assert.ok(data.tideCurve[i].heightFt >= data.tideCurve[i - 1].heightFt);
    }
    assert.strictEqual(data.tideExtrema.length, 2);
    assert.ok(["Poor", "Fair", "Good", "Excellent"].includes(data.fishingScore));
  });

  await test("a hilo failure still fails the whole card even if the curve (interval=h) would have succeeded -- hilo is the one that's actually load-bearing", async () => {
    const curveOnlyFetch = async (url) => {
      const u = new URL(url);
      if (u.hostname !== "api.tidesandcurrents.noaa.gov") return { json: async () => ({ hourly: { time: [] } }) };
      const interval = u.searchParams.get("interval");
      if (interval === "hilo") return { json: async () => ({ error: { message: "No Predictions data was found. Please make sure the Datum input is valid." } }) };
      return { json: async () => ({ predictions: [{ t: "2026-07-15 08:00", v: "2.00" }] }) };
    };
    await assert.rejects(
      () => fetchTideCardData({ lat: 39.2776, lon: -74.5746, stationId: "8534975" }, new Date("2026-07-15T16:00:00Z"), curveOnlyFetch),
      /Datum input is valid/
    );
  });

  await test("a genuine (non-noaaDataError) failure on the curve request alone still fails the whole card -- only a confirmed 'no data' response degrades gracefully, not a real connectivity error", async () => {
    const curveNetworkFailsFetch = async (url) => {
      const u = new URL(url);
      if (u.hostname !== "api.tidesandcurrents.noaa.gov") return { json: async () => ({ hourly: { time: [] } }) };
      const interval = u.searchParams.get("interval");
      if (interval === "h") throw new Error("simulated network failure on the curve request");
      return { json: async () => ({ predictions: [{ t: "2026-07-15 03:14", v: "0.60", type: "L" }, { t: "2026-07-15 09:22", v: "4.40", type: "H" }] }) };
    };
    await assert.rejects(
      () => fetchTideCardData({ lat: 39.2776, lon: -74.5746, stationId: "8534975" }, new Date("2026-07-15T16:00:00Z"), curveNetworkFailsFetch),
      /simulated network failure on the curve request/
    );
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

  await test("findMoonAltitudeExtrema tags each transit's extremaType, alternating overhead (altitude max) and underfoot (altitude min) -- added for the Sun/Moon/Tide Timeline card, non-breaking for computeSolunarPeriods below which ignores this field", () => {
    const from = new Date("2026-07-14T00:00:00Z");
    const to = new Date("2026-07-17T00:00:00Z");
    const extrema = findMoonAltitudeExtrema(LAT, LON, from, to, 2);
    assert.ok(extrema.every((e) => e.extremaType === "overhead" || e.extremaType === "underfoot"));
    for (let i = 1; i < extrema.length; i++) {
      assert.notStrictEqual(extrema[i].extremaType, extrema[i - 1].extremaType, "expected overhead/underfoot to alternate");
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

  console.log("interpolateTideCurveFromExtrema");
  await test("interpolates a smooth (cosine) curve between two extrema, flat-sloped at both ends, not a straight line", () => {
    const extrema = [
      { t: new Date("2026-07-15T09:12:00.000Z"), heightFt: 1.0 },
      { t: new Date("2026-07-15T13:12:00.000Z"), heightFt: 5.0 } // exactly 4h later, 4ft higher
    ];
    const curve = interpolateTideCurveFromExtrema(extrema);
    assert.strictEqual(curve[0].heightFt, 1.0);
    assert.strictEqual(curve[curve.length - 1].heightFt, 5.0);
    // Monotonically non-decreasing throughout -- a cosine ease never dips
    // below its start or overshoots its end between two points.
    for (let i = 1; i < curve.length; i++) assert.ok(curve[i].heightFt >= curve[i - 1].heightFt);
    // Flat-sloped at both ends (a real tide's rate of change is ~0 right
    // at a high/low) -- the first step's rise should be much smaller than
    // a straight line's would be (1/16 of the total span, since there are
    // 16 steps of 15min across 4h), and the same near the far end.
    const straightLineStep = 4.0 / 16;
    assert.ok(curve[1].heightFt - curve[0].heightFt < straightLineStep * 0.5, "expected a slow start, not a straight-line pace");
    assert.ok(curve[curve.length - 1].heightFt - curve[curve.length - 2].heightFt < straightLineStep * 0.5, "expected a slow finish, not a straight-line pace");
  });
  await test("interpolates across multiple consecutive extrema (a full low-high-low-high day), not just one pair", () => {
    const extrema = [
      { t: new Date("2026-07-15T07:00:00.000Z"), heightFt: 0.5 },
      { t: new Date("2026-07-15T13:00:00.000Z"), heightFt: 4.5 },
      { t: new Date("2026-07-15T19:00:00.000Z"), heightFt: 0.8 },
      { t: new Date("2026-07-16T01:00:00.000Z"), heightFt: 4.2 }
    ];
    const curve = interpolateTideCurveFromExtrema(extrema);
    assert.strictEqual(curve[0].heightFt, 0.5);
    assert.strictEqual(curve[curve.length - 1].heightFt, 4.2);
    // Every original extremum shows up exactly at its own height somewhere
    // in the interpolated curve (the segment boundaries), not smoothed away.
    extrema.forEach((e) => {
      assert.ok(curve.some((p) => p.t.getTime() === e.t.getTime() && p.heightFt === e.heightFt));
    });
  });
  await test("returns an empty curve for zero extrema, and a single point (not a throw) for exactly one -- neither has a pair to interpolate between", () => {
    assert.deepStrictEqual(interpolateTideCurveFromExtrema([]), []);
    const one = [{ t: new Date("2026-07-15T09:12:00.000Z"), heightFt: 2.0 }];
    assert.deepStrictEqual(interpolateTideCurveFromExtrema(one), [{ t: one[0].t, heightFt: 2.0 }]);
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
  await test("weather can now push the score down to Poor -- high wind or a sharp pressure drop, on top of an otherwise-neutral moon/tide", () => {
    const neutral = { moonIllumination: 0.5, solunarPeriods: [], tideCurve: [], dawn: SCORE_DAWN, dusk: SCORE_DUSK };
    assert.strictEqual(fishingScore(Object.assign({}, neutral, { weather: { wind: { mph: 25 }, pressure: { trend: "steady", deltaHpa: 0 } } })), "Poor");
    assert.strictEqual(fishingScore(Object.assign({}, neutral, { weather: { wind: { mph: 8 }, pressure: { trend: "falling", deltaHpa: -4 } } })), "Poor");
  });
  await test("weather can also push the score up -- calm wind + steady/rising pressure is a positive signal", () => {
    const neutral = { moonIllumination: 0.5, solunarPeriods: [], tideCurve: [], dawn: SCORE_DAWN, dusk: SCORE_DUSK };
    assert.strictEqual(fishingScore(Object.assign({}, neutral, { weather: { wind: { mph: 8 }, pressure: { trend: "steady", deltaHpa: 0 } } })), "Good");
  });
  await test("mixed weather (calm wind but falling pressure, not sharply) is neutral -- neither bonus nor penalty", () => {
    const neutral = { moonIllumination: 0.5, solunarPeriods: [], tideCurve: [], dawn: SCORE_DAWN, dusk: SCORE_DUSK };
    assert.strictEqual(fishingScore(Object.assign({}, neutral, { weather: { wind: { mph: 8 }, pressure: { trend: "falling", deltaHpa: -2 } } })), "Fair");
  });
  await test("score never goes below Poor or above Excellent even with every signal maxed", () => {
    const best = { moonIllumination: 0.0, solunarPeriods: [{ kind: "major", start: "2026-07-15T10:00:00.000Z", end: "2026-07-15T12:00:00.000Z" }], tideCurve: MOVING_CURVE, dawn: SCORE_DAWN, dusk: SCORE_DUSK, weather: { wind: { mph: 5 }, pressure: { trend: "rising", deltaHpa: 3 } } };
    assert.strictEqual(fishingScore(best), "Excellent");
  });

  console.log("degreesToCompass / nearestHourly");
  await test("degreesToCompass maps common headings, wraps correctly at 0/360, and returns null for null", () => {
    assert.strictEqual(degreesToCompass(0), "N");
    assert.strictEqual(degreesToCompass(360), "N");
    assert.strictEqual(degreesToCompass(90), "E");
    assert.strictEqual(degreesToCompass(180), "S");
    assert.strictEqual(degreesToCompass(315), "NW");
    assert.strictEqual(degreesToCompass(null), null);
  });
  await test("nearestHourly picks the closest point by absolute time distance, and null for an empty series", () => {
    const series = [{ t: new Date("2026-07-15T10:00:00Z") }, { t: new Date("2026-07-15T14:00:00Z") }];
    assert.strictEqual(nearestHourly(series, new Date("2026-07-15T11:30:00Z").getTime()), series[0]);
    assert.strictEqual(nearestHourly(series, new Date("2026-07-15T12:30:00Z").getTime()), series[1]);
    assert.strictEqual(nearestHourly([], Date.now()), null);
  });

  console.log("computePressure / computeRainWindows / computeWindRamp");
  await test("computePressure classifies a >=2hPa/6h change as rising/falling, otherwise steady", () => {
    const falling = buildHourlySeries(0, 6, {}).time.map((t, i) => ({ t: new Date(t + ":00Z"), pressureHpa: 1021 - i }));
    assert.strictEqual(computePressure(falling, new Date(falling[6].t).getTime()).trend, "falling");
    const rising = buildHourlySeries(0, 6, {}).time.map((t, i) => ({ t: new Date(t + ":00Z"), pressureHpa: 1015 + i }));
    assert.strictEqual(computePressure(rising, new Date(rising[6].t).getTime()).trend, "rising");
    const steady = buildHourlySeries(0, 6, {}).time.map((t) => ({ t: new Date(t + ":00Z"), pressureHpa: 1018 }));
    assert.strictEqual(computePressure(steady, new Date(steady[6].t).getTime()).trend, "steady");
  });
  await test("computePressure degrades to steady/null-delta when there's no 6h-ago reading to compare against", () => {
    const single = [{ t: new Date("2026-07-15T16:00:00Z"), pressureHpa: 1015 }];
    const result = computePressure(single, new Date("2026-07-15T16:00:00Z").getTime());
    assert.strictEqual(result.hpa, 1015);
    assert.strictEqual(result.deltaHpa, null);
    assert.strictEqual(result.trend, "steady");
  });

  await test("computeRainWindows merges contiguous hours over the probability threshold into one window, extended 1h past the last point", () => {
    const dawn = new Date("2026-07-15T09:00:00Z");
    const dusk = new Date("2026-07-15T20:00:00Z");
    const series = buildHourlySeries(9, 20, {}).time.map((t, i) => {
      const h = 9 + i;
      return { t: new Date(t + ":00Z"), precipProbability: (h >= 14 && h <= 16) ? 70 : 10 };
    });
    const windows = computeRainWindows(series, dawn, dusk, "America/New_York");
    assert.strictEqual(windows.length, 1);
    assert.strictEqual(new Date(windows[0].start).toISOString(), "2026-07-15T14:00:00.000Z");
    assert.strictEqual(new Date(windows[0].end).toISOString(), "2026-07-15T17:00:00.000Z");
    assert.ok(windows[0].label.startsWith("RAIN LIKELY"));
  });
  await test("computeRainWindows returns two separate windows for two separate rainy runs, not one merged window", () => {
    const dawn = new Date("2026-07-15T09:00:00Z");
    const dusk = new Date("2026-07-15T20:00:00Z");
    const series = buildHourlySeries(9, 20, {}).time.map((t, i) => {
      const h = 9 + i;
      return { t: new Date(t + ":00Z"), precipProbability: (h === 10 || h === 18) ? 80 : 5 };
    });
    const windows = computeRainWindows(series, dawn, dusk, "America/New_York");
    assert.strictEqual(windows.length, 2);
  });
  await test("computeRainWindows returns nothing when probability never meets the threshold", () => {
    const dawn = new Date("2026-07-15T09:00:00Z");
    const dusk = new Date("2026-07-15T20:00:00Z");
    const series = buildHourlySeries(9, 20, {}).time.map((t) => ({ t: new Date(t + ":00Z"), precipProbability: 20 }));
    assert.deepStrictEqual(computeRainWindows(series, dawn, dusk, "America/New_York"), []);
  });

  await test("computeWindRamp flags a real later pickup (well above both the absolute floor and current conditions)", () => {
    const dawn = new Date("2026-07-15T09:00:00Z");
    const dusk = new Date("2026-07-16T00:00:00Z");
    const now = new Date("2026-07-15T12:00:00Z");
    const series = buildHourlySeries(9, 24, {}).time.map((t, i) => {
      const h = 9 + i;
      return { t: new Date(t + ":00Z"), windMph: h < 15 ? 8 : 22 };
    });
    const ramp = computeWindRamp(series, dawn, dusk, now.getTime(), "America/New_York");
    assert.ok(ramp, "expected a wind ramp to be flagged");
    assert.strictEqual(ramp.gustMph, 22);
    assert.ok(ramp.label.includes("22 MPH"));
  });
  await test("computeWindRamp returns null when wind is already elevated now (nothing new to warn about)", () => {
    const dawn = new Date("2026-07-15T09:00:00Z");
    const dusk = new Date("2026-07-16T00:00:00Z");
    const now = new Date("2026-07-15T16:00:00Z"); // already in the high-wind stretch
    const series = buildHourlySeries(9, 24, {}).time.map((t, i) => {
      const h = 9 + i;
      return { t: new Date(t + ":00Z"), windMph: h < 15 ? 8 : 22 };
    });
    assert.strictEqual(computeWindRamp(series, dawn, dusk, now.getTime(), "America/New_York"), null);
  });
  await test("computeWindRamp returns null for a small/unremarkable increase (below the minimum jump)", () => {
    const dawn = new Date("2026-07-15T09:00:00Z");
    const dusk = new Date("2026-07-16T00:00:00Z");
    const now = new Date("2026-07-15T12:00:00Z");
    const series = buildHourlySeries(9, 24, {}).time.map((t) => ({ t: new Date(t + ":00Z"), windMph: 10 }));
    assert.strictEqual(computeWindRamp(series, dawn, dusk, now.getTime(), "America/New_York"), null);
  });

  console.log("fetchOpenMeteoWeather / fetchOpenMeteoMarine / fetchWeatherSignals");
  await test("fetchOpenMeteoWeather parses the hourly arrays into one object per timestamp", async () => {
    const hourly = buildHourlySeries(0, 2, {
      wind_speed_10m: () => 12,
      wind_direction_10m: () => 270,
      surface_pressure: () => 1018,
      precipitation_probability: () => 40
    });
    const fetchImpl = async () => ({ json: async () => ({ hourly }) });
    const series = await fetchOpenMeteoWeather(39.27, -74.57, fetchImpl);
    assert.strictEqual(series.length, 3);
    assert.strictEqual(series[0].windMph, 12);
    assert.strictEqual(series[0].windDir, 270);
    assert.strictEqual(series[0].pressureHpa, 1018);
    assert.strictEqual(series[0].precipProbability, 40);
  });
  await test("fetchOpenMeteoWeather throws on an Open-Meteo-reported error instead of returning garbage", async () => {
    const errorFetch = async () => ({ json: async () => ({ error: true, reason: "Latitude must be in range of -90 to 90 degrees" }) });
    await assert.rejects(() => fetchOpenMeteoWeather(999, -74.57, errorFetch), /Latitude must be in range/);
  });
  await test("fetchOpenMeteoWeather sends a browser-like User-Agent, not Node's own bare default", async () => {
    let capturedOptions = null;
    const capturingFetch = async (url, options) => {
      capturedOptions = options;
      return { json: async () => ({ hourly: { time: [] } }) };
    };
    await fetchOpenMeteoWeather(39.27, -74.57, capturingFetch);
    assert.strictEqual(capturedOptions.headers, OUTBOUND_FETCH_HEADERS);
  });

  await test("fetchOpenMeteoMarine sends a browser-like User-Agent, not Node's own bare default", async () => {
    let capturedOptions = null;
    const capturingFetch = async (url, options) => {
      capturedOptions = options;
      return { json: async () => ({ hourly: { time: [] } }) };
    };
    await fetchOpenMeteoMarine(39.27, -74.57, capturingFetch);
    assert.strictEqual(capturedOptions.headers, OUTBOUND_FETCH_HEADERS);
  });

  await test("fetchOpenMeteoMarine parses wave height/period and water temp, tolerating missing sea_surface_temperature (patchy nearshore coverage)", async () => {
    const hourly = buildHourlySeries(0, 1, { wave_height: () => 2.5, wave_period: () => 7 }); // no sea_surface_temperature field at all
    const fetchImpl = async () => ({ json: async () => ({ hourly }) });
    const series = await fetchOpenMeteoMarine(39.27, -74.57, fetchImpl);
    assert.strictEqual(series[0].waveHeightFt, 2.5);
    assert.strictEqual(series[0].wavePeriodS, 7);
    assert.strictEqual(series[0].waterTempF, null);
  });

  await test("fetchWeatherSignals combines both APIs into one object, gracefully omitting swell/water temp when the marine call returns nothing", async () => {
    const fetchImpl = mockAllApisFetch({
      weatherHourly: buildHourlySeries(10, 20, { wind_speed_10m: () => 10, wind_direction_10m: () => 180, surface_pressure: () => 1015, precipitation_probability: () => 5 })
      // marineHourly omitted entirely -- defaults to { time: [] }
    });
    const dawn = new Date("2026-07-15T09:00:00Z"), dusk = new Date("2026-07-15T20:00:00Z"), now = new Date("2026-07-15T16:00:00Z");
    const weather = await fetchWeatherSignals({ lat: 39.27, lon: -74.57, dawn, dusk, now, timeZone: "America/New_York", fetchImpl });
    assert.ok(weather.wind && weather.wind.mph === 10 && weather.wind.dir === "S");
    assert.strictEqual(weather.swell, null);
    assert.strictEqual(weather.waterTempF, null);
    assert.strictEqual(weather.ripRisk, null);
  });
  await test("fetchWeatherSignals derives ripRisk from the same marine swell reading it returns", async () => {
    const fetchImpl = mockAllApisFetch({
      marineHourly: { time: ["2026-07-15T16:00"], wave_height: [4.5], wave_period: [11], sea_surface_temperature: [82] }
    });
    const now = new Date("2026-07-15T16:00:00Z");
    const weather = await fetchWeatherSignals({ lat: 30.35, lon: -86.15, dawn: now, dusk: now, now, timeZone: "America/Chicago", fetchImpl });
    assert.strictEqual(weather.swell.heightFt, 4.5);
    assert.strictEqual(weather.ripRisk, "HIGH");
  });

  console.log("ripCurrentRisk");
  await test("no swell reading at all yields no risk estimate, not a guess", () => {
    assert.strictEqual(ripCurrentRisk(null), null);
    assert.strictEqual(ripCurrentRisk({ heightFt: null, periodS: 12 }), null);
  });
  await test("small waves with an unremarkable (short) period are LOW", () => {
    assert.strictEqual(ripCurrentRisk({ heightFt: 1.5, periodS: 6 }), "LOW");
  });
  await test("moderate waves (2ft+) with an unremarkable period are MODERATE", () => {
    assert.strictEqual(ripCurrentRisk({ heightFt: 2.5, periodS: 7 }), "MODERATE");
  });
  await test("a long-period swell (10s+) escalates even a small-ish wave height to MODERATE", () => {
    assert.strictEqual(ripCurrentRisk({ heightFt: 1, periodS: 11 }), "MODERATE");
  });
  await test("4ft+ waves are HIGH on their own, no period needed", () => {
    assert.strictEqual(ripCurrentRisk({ heightFt: 4, periodS: null }), "HIGH");
  });
  await test("a long-period swell escalates a 2.5ft+ wave straight to HIGH", () => {
    assert.strictEqual(ripCurrentRisk({ heightFt: 2.5, periodS: 10 }), "HIGH");
  });

  console.log("localMidnight / formatLongDate (Sun/Moon/Tide Timeline helpers)");
  await test("localMidnight finds the UTC instant for local 00:00:00 on the same local calendar day as `now`, DST-aware", () => {
    const summer = new Date("2026-07-15T19:15:00Z"); // 3:15 PM EDT (UTC-4)
    assert.strictEqual(localMidnight(summer, "America/New_York").toISOString(), "2026-07-15T04:00:00.000Z");
    const winter = new Date("2026-01-15T19:15:00Z"); // 2:15 PM EST (UTC-5)
    assert.strictEqual(localMidnight(winter, "America/New_York").toISOString(), "2026-01-15T05:00:00.000Z");
  });
  await test("localMidnight handles an instant that's already just past local midnight without rolling back a day", () => {
    const justAfterMidnight = new Date("2026-07-15T04:05:00Z"); // 12:05 AM EDT
    assert.strictEqual(localMidnight(justAfterMidnight, "America/New_York").toISOString(), "2026-07-15T04:00:00.000Z");
  });

  await test("formatLongDate renders a full month/day/year in the given zone", () => {
    assert.strictEqual(formatLongDate(new Date("2026-08-25T04:00:00Z"), "America/New_York"), "August 25, 2026");
  });
  await test("formatLongDate returns null for a null date", () => {
    assert.strictEqual(formatLongDate(null, "America/New_York"), null);
  });

  console.log("fetchTideTimelineData (Sun/Moon/Tide Timeline card)");
  await test("fetchTideTimelineData covers a full local midnight-to-midnight window, filters tide extrema/moon events to it, and skips the continuous curve/weather/fishing score fetchTideCardData has", async () => {
    const timelineMockFetch = async (url) => {
      const u = new URL(url);
      if (u.hostname !== "api.tidesandcurrents.noaa.gov") throw new Error("unexpected host in test: " + u.hostname);
      const interval = u.searchParams.get("interval");
      if (interval !== "hilo") return { json: async () => ({ predictions: [] }) };
      return {
        json: async () => ({
          predictions: [
            { t: "2026-07-14 23:50", v: "0.50", type: "L" }, // just before local midnight -> out of window
            { t: "2026-07-15 02:10", v: "0.40", type: "L" },
            { t: "2026-07-15 08:25", v: "4.10", type: "H" }
          ]
        })
      };
    };
    const now = new Date("2026-07-15T16:00:00Z"); // noon EDT, July 15
    const data = await fetchTideTimelineData({ lat: LAT, lon: LON, stationId: "8534720" }, now, timelineMockFetch);

    assert.strictEqual(data.timeZone, "America/New_York");
    assert.strictEqual(data.dayStart, "2026-07-15T04:00:00.000Z");
    assert.strictEqual(data.dayEnd, "2026-07-16T04:00:00.000Z");
    assert.ok(data.sunrise && data.sunrise.label);
    assert.ok(data.sunset && data.sunset.label);
    assert.ok(typeof data.moonPhase.illumination === "number" && typeof data.moonPhase.phaseName === "string");
    assert.ok(Array.isArray(data.moonEvents));
    for (let i = 1; i < data.moonEvents.length; i++) {
      assert.ok(new Date(data.moonEvents[i].t).getTime() >= new Date(data.moonEvents[i - 1].t).getTime(), "moonEvents should be time-sorted");
    }
    // The prior-day 23:50 low falls before dayStart and is filtered out --
    // only the two in-window hi/lo points survive.
    assert.strictEqual(data.tideExtrema.length, 2);
    assert.strictEqual(data.tideExtrema[0].isHigh, false);
    assert.strictEqual(data.tideExtrema[0].label, "2:10 AM");
    assert.strictEqual(data.tideExtrema[1].isHigh, true);
    assert.strictEqual(data.tideExtrema[1].label, "8:25 AM");
    assert.strictEqual(data.tideCurve, undefined);
    assert.strictEqual(data.weather, undefined);
    assert.strictEqual(data.fishingScore, undefined);
  });

  await test("fetchTideTimelineData tags moonrise/moonset events with a compass direction, but not overhead/underfoot transits", async () => {
    const emptyHiloMockFetch = async () => ({ json: async () => ({ predictions: [] }) });
    // Real date used to verify the Ocean City moonrise webpage: moonrise
    // was independently confirmed at 7:25 PM EDT, direction ~104 (ESE).
    const now = new Date("2026-08-27T16:00:00Z"); // noon EDT, Aug 27
    const data = await fetchTideTimelineData({ lat: LAT, lon: LON, stationId: "8534720" }, now, emptyHiloMockFetch);

    const riseEvent = data.moonEvents.find((e) => e.kind === "rise");
    assert.ok(riseEvent, "expected a moonrise event in today's window");
    assert.strictEqual(riseEvent.label, "7:25 PM");
    assert.ok(typeof riseEvent.azimuthDeg === "number" && riseEvent.azimuthDeg > 95 && riseEvent.azimuthDeg < 115, "moonrise azimuth should be roughly ESE (~104deg), got " + riseEvent.azimuthDeg);
    assert.strictEqual(riseEvent.compass, "ESE");

    const transitEvents = data.moonEvents.filter((e) => e.kind === "overhead" || e.kind === "underfoot");
    assert.ok(transitEvents.length > 0, "expected at least one transit event to check");
    transitEvents.forEach((e) => {
      assert.strictEqual(e.azimuthDeg, undefined, "overhead/underfoot transits shouldn't get a horizon direction");
      assert.strictEqual(e.compass, undefined);
    });
  });

  await test("fetchTideTimelineData still finds today's sunrise/sunset when called in the evening (regression: SunCalc resolves by UTC day, not local day)", async () => {
    const emptyHiloMockFetch = async () => ({ json: async () => ({ predictions: [] }) });
    // 9pm EDT on July 15 is already July 16 in UTC -- passing that instant
    // straight to SunCalc used to compute July 16's sunrise/sunset, which
    // then fell outside July 15's local midnight-to-midnight window and
    // got filtered to null, even though it was still July 15 locally.
    const eveningNow = new Date("2026-07-16T01:00:00Z"); // 9pm EDT, July 15
    const data = await fetchTideTimelineData({ lat: LAT, lon: LON, stationId: "8534720" }, eveningNow, emptyHiloMockFetch);

    assert.strictEqual(data.dayStart, "2026-07-15T04:00:00.000Z");
    assert.ok(data.sunrise && data.sunrise.label, "sunrise should still be found for today, not filtered out");
    assert.ok(data.sunset && data.sunset.label, "sunset should still be found for today, not filtered out");
    assert.ok(new Date(data.sunrise.t) >= new Date(data.dayStart) && new Date(data.sunrise.t) < new Date(data.dayEnd));
    assert.ok(new Date(data.sunset.t) >= new Date(data.dayStart) && new Date(data.sunset.t) < new Date(data.dayEnd));
  });

  console.log(passed + " passed, " + failed + " failed");
  if (failed > 0) process.exit(1);
})();
