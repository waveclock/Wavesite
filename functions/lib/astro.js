"use strict";

// Sun/moon/twilight (via suncalc) + NOAA tide predictions, shaped into one
// ready-to-draw payload for the Tide & Fishing card. Both the live preview
// (astroProxy, called from design-v2's browser) and the daily regeneration
// job call fetchTideCardData directly -- neither duplicates this
// computation, unlike Team's findNextGame (which IS duplicated
// client/server because it's simple enough to keep in sync by hand). This
// one isn't: twilight bounds, moon phase naming, and NOAA's date/timezone
// quirks are exactly the kind of thing that drifts out of sync if written
// twice, so there's a single source of truth instead.
//
// NOT live-tested against NOAA from this development sandbox -- outbound
// network here is allowlisted and neither api.tidesandcurrents.noaa.gov
// nor api.open-meteo.com are reachable from it (both returned a 403 from
// the sandbox's own egress proxy, not from NOAA/Open-Meteo). Built against
// NOAA's long-stable, publicly documented CO-OPS "datagetter" JSON shape;
// verify against a real station once this is deployed, the same way
// espnProxy's live reachability was confirmed after the fact (see
// README's "Known tradeoffs").
//
// All three outbound fetches (NOAA, Open-Meteo weather, Open-Meteo
// marine) now send OUTBOUND_FETCH_HEADERS (lib/http.js) -- a real
// browser User-Agent instead of Node's own default ("User-Agent: node",
// a plain bot signal). A live 502 from astroProxy after deploy couldn't
// be reproduced from this sandbox (both hosts are policy-blocked here
// too, same as before), so this isn't a confirmed repro -- it's the same
// fix applied to fetchDitheredLogo (dynamic.js) after a real live ESPN
// CDN failure, tried here on the same theory since Node's bare "node"
// User-Agent is a plausible reason for a CDN/API to reject the request.
// If a live check after deploy shows this wasn't it, see this file's
// header comment above (and dynamic.js's fetchHeadlines) for the
// header-flip-flop history -- it's not a fix that's worked everywhere.

const SunCalc = require("suncalc");
const tzlookup = require("tz-lookup");
const { OUTBOUND_FETCH_HEADERS } = require("./http");

const NOAA_BASE = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";

// 8 named phases, each roughly 1/8 of the cycle, with New/First
// Quarter/Full/Last Quarter given a slightly narrower window (they're
// exact instants; the crescent/gibbous windows either side are wider by
// convention) -- standard bucketing used by most moon-phase calculators.
const PHASE_NAMES = [
  { max: 0.033, name: "New Moon" },
  { max: 0.217, name: "Waxing Crescent" },
  { max: 0.283, name: "First Quarter" },
  { max: 0.467, name: "Waxing Gibbous" },
  { max: 0.533, name: "Full Moon" },
  { max: 0.717, name: "Waning Gibbous" },
  { max: 0.783, name: "Last Quarter" },
  { max: 0.967, name: "Waning Crescent" },
  { max: 1.001, name: "New Moon" }
];

function moonPhaseName(phase) {
  const p = ((phase % 1) + 1) % 1; // normalize into [0, 1)
  for (const bucket of PHASE_NAMES) {
    if (p < bucket.max) return bucket.name;
  }
  return "New Moon";
}

function formatLocalTime(date, timeZone) {
  if (!date) return null;
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone }).format(date);
}

// NOAA's begin_date/end_date, precise to the minute, in the station's
// (irrelevant here, since we request time_zone=gmt) or GMT clock --
// "yyyyMMdd HH:mm".
function noaaDateParam(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    date.getUTCFullYear() + pad(date.getUTCMonth() + 1) + pad(date.getUTCDate()) +
    " " + pad(date.getUTCHours()) + ":" + pad(date.getUTCMinutes())
  );
}

// NOAA's "t" field under time_zone=gmt is "yyyy-MM-dd HH:mm" with no
// timezone marker -- parsed as local time by JS's Date constructor if
// handed to it as-is, which would silently corrupt every timestamp on any
// machine not already running in UTC. Force it to be read as UTC instead.
function parseNoaaGmtTimestamp(t) {
  return new Date(t.replace(" ", "T") + "Z");
}

async function fetchNoaaPredictions(stationId, begin, end, interval, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const params = new URLSearchParams({
    station: stationId,
    product: "predictions",
    datum: "MLLW",
    time_zone: "gmt",
    units: "english",
    format: "json",
    begin_date: noaaDateParam(begin),
    end_date: noaaDateParam(end),
    interval
  });
  const resp = await doFetch(NOAA_BASE + "?" + params.toString(), { headers: OUTBOUND_FETCH_HEADERS });
  const data = await resp.json();
  if (data && data.error) throw new Error(data.error.message || "NOAA returned an error");
  return (data.predictions || []).map((p) => ({
    t: parseNoaaGmtTimestamp(p.t),
    heightFt: parseFloat(p.v),
    isHigh: p.type === "H" ? true : p.type === "L" ? false : null
  }));
}

// Solunar major/minor periods -- NOT provided by suncalc, unlike
// everything else here. Major periods are centered on the moon's transit
// (directly overhead) and its antitransit (directly underfoot, ~12h25m
// later -- half the ~24h50m lunar day); minor periods are centered on
// moonrise/moonset. There's no closed-form time for lunar transit the way
// there is for solar noon, so this finds it numerically: sample the
// moon's altitude (SunCalc.getMoonPosition) every few minutes and look
// for local maxima (overhead) and minima (underfoot).
//
// Verified against real SunCalc output for several dates/locations before
// being trusted here: consecutive extrema alternate max/min and land
// ~12.3-12.6h apart, exactly the expected half lunar-day spacing. A
// tempting cross-check -- transit should be roughly the midpoint of
// moonrise and moonset -- turned out to be UNRELIABLE and was dropped:
// SunCalc's getMoonTimes can return a rise/set pair that don't actually
// bracket the same transit (the moon rises ~50min later each day, so a
// given day's "set" is sometimes left over from the previous day's
// rise), which makes their midpoint land near the wrong extremum
// entirely. Direct altitude sampling has no such pairing ambiguity.
const MAJOR_HALF_WIDTH_MIN = 60; // major period = 2h total, centered on transit/antitransit
const MINOR_HALF_WIDTH_MIN = 25; // minor period = ~50min total, centered on moonrise/moonset
const SOLUNAR_SAMPLE_STEP_MIN = 2;
const SOLUNAR_MARGIN_MS = 3 * 3600000; // how far outside [dawn, dusk] a period's CENTER may still fall and be considered relevant

function findMoonAltitudeExtrema(lat, lon, from, to, stepMinutes) {
  const extrema = [];
  let prevAlt = SunCalc.getMoonPosition(from, lat, lon).altitude;
  let prevPrevAlt = null;
  let prevT = from;
  for (let ms = from.getTime() + stepMinutes * 60000; ms <= to.getTime(); ms += stepMinutes * 60000) {
    const t = new Date(ms);
    const alt = SunCalc.getMoonPosition(t, lat, lon).altitude;
    if (prevPrevAlt !== null) {
      if (prevAlt > prevPrevAlt && prevAlt > alt) extrema.push({ kind: "major", t: prevT });
      if (prevAlt < prevPrevAlt && prevAlt < alt) extrema.push({ kind: "major", t: prevT });
    }
    prevPrevAlt = prevAlt;
    prevAlt = alt;
    prevT = t;
  }
  return extrema;
}

// dawn/dusk: Date objects (the card's display window). moonRiseDate/
// moonSetDate: Date or null. Returns [{ kind: "major"|"minor", start, end
// }] (ISO strings) for periods plausibly relevant to this card -- the
// caller (drawTideCard) does its own precise overlap-with-[dawn,dusk]
// check before actually drawing one, same as it already does for tide
// extrema.
function computeSolunarPeriods(lat, lon, dawn, dusk, moonRiseDate, moonSetDate) {
  const sampleFrom = new Date(dawn.getTime() - SOLUNAR_MARGIN_MS - 3600000);
  const sampleTo = new Date(dusk.getTime() + SOLUNAR_MARGIN_MS + 3600000);
  const transits = findMoonAltitudeExtrema(lat, lon, sampleFrom, sampleTo, SOLUNAR_SAMPLE_STEP_MIN);

  const periods = transits.map((e) => ({
    kind: "major",
    start: new Date(e.t.getTime() - MAJOR_HALF_WIDTH_MIN * 60000).toISOString(),
    end: new Date(e.t.getTime() + MAJOR_HALF_WIDTH_MIN * 60000).toISOString()
  }));
  [moonRiseDate, moonSetDate].forEach((d) => {
    if (!d) return;
    periods.push({
      kind: "minor",
      start: new Date(d.getTime() - MINOR_HALF_WIDTH_MIN * 60000).toISOString(),
      end: new Date(d.getTime() + MINOR_HALF_WIDTH_MIN * 60000).toISOString()
    });
  });

  return periods.filter((p) => {
    const mid = (new Date(p.start).getTime() + new Date(p.end).getTime()) / 2;
    return mid >= dawn.getTime() - SOLUNAR_MARGIN_MS && mid <= dusk.getTime() + SOLUNAR_MARGIN_MS;
  });
}

// Feet-per-hour at a given instant, from the two curve points bracketing
// it (or the nearest edge point if outside the curve's own range).
function tideRateOfChange(curve, atMs) {
  if (curve.length < 2) return 0;
  let i = 0;
  while (i < curve.length - 2 && new Date(curve[i + 1].t).getTime() < atMs) i++;
  const a = curve[i], b = curve[i + 1];
  const tA = new Date(a.t).getTime(), tB = new Date(b.t).getTime();
  if (tB === tA) return 0;
  return (b.heightFt - a.heightFt) / ((tB - tA) / 3600000);
}

// A simple, explicitly-a-heuristic-not-science fishing score (see the
// README section for the honesty caveat, same spirit as the ESPN/NOAA
// "not live tested"/"unofficial API" notes elsewhere in this file). Moon
// + tide (always available) contribute 0-2 points; weather (optional --
// omitted where a caller has none, e.g. old tests) can add or subtract 1:
//   1. Tidal range (and, per the folklore, fish activity) is greatest
//      near new/full moon (spring tides) and least near the quarters
//      (neap tides).
//   2. Fish are said to feed more actively while the tide is actively
//      moving, not near slack -- so a major/minor solunar period that
//      overlaps a fast-moving stretch of today's tide curve is a second
//      positive signal.
//   3. Calm wind + steady/rising pressure is a positive signal; high wind
//      or a sharp pressure drop (a front moving through) is a negative
//      one -- this is what actually lets the score reach "Poor".
const FISHING_SCORE_LEVELS = ["Poor", "Fair", "Good", "Excellent"];
const WEATHER_CALM_WIND_MPH = 15;
const WEATHER_HIGH_WIND_MPH = 20;
const WEATHER_SHARP_PRESSURE_DROP_HPA = -3;

function fishingScore({ moonIllumination, solunarPeriods, tideCurve, dawn, dusk, weather }) {
  // Starts at 1 ("Fair" -- the FISHING_SCORE_LEVELS index for a day with
  // no positive or negative signal at all), not 0: Phase 2 had 2 possible
  // positive points landing on Fair/Good/Excellent, and adding "Poor"
  // here must not silently shift those down a level for existing (no
  // weather) callers.
  let points = 1;

  const distFromNewOrFull = Math.min(moonIllumination, 1 - moonIllumination); // 0 at new/full, 0.5 at quarter
  if (distFromNewOrFull < 0.15) points += 1;

  if (tideCurve.length >= 2) {
    const rates = [];
    for (let i = 0; i < tideCurve.length - 1; i++) {
      rates.push(Math.abs(tideRateOfChange(tideCurve, (new Date(tideCurve[i].t).getTime() + new Date(tideCurve[i + 1].t).getTime()) / 2)));
    }
    const maxRate = Math.max(...rates, 0);
    const movingThreshold = maxRate * 0.5;
    const dawnMs = dawn.getTime(), duskMs = dusk.getTime();
    const hasMovingOverlap = maxRate > 0 && solunarPeriods.some((p) => {
      const mid = (new Date(p.start).getTime() + new Date(p.end).getTime()) / 2;
      if (mid < dawnMs || mid > duskMs) return false;
      return Math.abs(tideRateOfChange(tideCurve, mid)) >= movingThreshold;
    });
    if (hasMovingOverlap) points += 1;
  }

  if (weather) {
    const windMph = weather.wind ? weather.wind.mph : null;
    const pressureDelta = weather.pressure ? weather.pressure.deltaHpa : null;
    const windCalm = windMph == null || windMph <= WEATHER_CALM_WIND_MPH;
    const pressureGood = !weather.pressure || weather.pressure.trend !== "falling";
    const windBad = windMph != null && windMph > WEATHER_HIGH_WIND_MPH;
    const pressureBad = pressureDelta != null && pressureDelta <= WEATHER_SHARP_PRESSURE_DROP_HPA;
    if (windBad || pressureBad) points -= 1;
    else if (windCalm && pressureGood) points += 1;
  }

  const clamped = Math.max(0, Math.min(points, FISHING_SCORE_LEVELS.length - 1));
  return FISHING_SCORE_LEVELS[clamped];
}

const OPEN_METEO_WEATHER_BASE = "https://api.open-meteo.com/v1/forecast";
const OPEN_METEO_MARINE_BASE = "https://marine-api.open-meteo.com/v1/marine";
const RAIN_PROBABILITY_THRESHOLD = 50; // percent
const WIND_RAMP_MIN_ABS_MPH = 15;
const WIND_RAMP_MIN_INCREASE_MPH = 8;

// Open-Meteo's hourly.time entries look like "2026-07-15T09:00" (no
// seconds, no timezone marker) -- requested with timezone=UTC below for
// the same reason NOAA's calls use time_zone=gmt: read explicitly as UTC
// rather than risk the ambiguous default.
function parseOpenMeteoTimestamp(t) {
  return new Date(t + ":00Z");
}

async function fetchOpenMeteoWeather(lat, lon, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: "wind_speed_10m,wind_direction_10m,surface_pressure,precipitation_probability",
    wind_speed_unit: "mph",
    timezone: "UTC",
    past_hours: "6",
    forecast_hours: "30"
  });
  const resp = await doFetch(OPEN_METEO_WEATHER_BASE + "?" + params.toString(), { headers: OUTBOUND_FETCH_HEADERS });
  const data = await resp.json();
  if (data && data.error) throw new Error(data.reason || "Open-Meteo weather returned an error");
  const h = data.hourly || {};
  const times = h.time || [];
  return times.map((t, i) => ({
    t: parseOpenMeteoTimestamp(t),
    windMph: h.wind_speed_10m ? h.wind_speed_10m[i] : null,
    windDir: h.wind_direction_10m ? h.wind_direction_10m[i] : null,
    pressureHpa: h.surface_pressure ? h.surface_pressure[i] : null,
    precipProbability: h.precipitation_probability ? h.precipitation_probability[i] : null
  }));
}

async function fetchOpenMeteoMarine(lat, lon, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: "wave_height,wave_period,sea_surface_temperature",
    length_unit: "imperial",
    temperature_unit: "fahrenheit",
    timezone: "UTC",
    forecast_hours: "30"
  });
  const resp = await doFetch(OPEN_METEO_MARINE_BASE + "?" + params.toString(), { headers: OUTBOUND_FETCH_HEADERS });
  const data = await resp.json();
  if (data && data.error) throw new Error(data.reason || "Open-Meteo marine returned an error");
  const h = data.hourly || {};
  const times = h.time || [];
  // sea_surface_temperature coverage is inconsistent close to shore in
  // parts of the US -- a device very near the coast may just get nulls
  // for it here, which the card handles by omitting water temp rather
  // than showing a wrong/stale number (see fetchTideCardData below).
  return times.map((t, i) => ({
    t: parseOpenMeteoTimestamp(t),
    waveHeightFt: h.wave_height ? h.wave_height[i] : null,
    wavePeriodS: h.wave_period ? h.wave_period[i] : null,
    waterTempF: h.sea_surface_temperature ? h.sea_surface_temperature[i] : null
  }));
}

const COMPASS_POINTS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
function degreesToCompass(deg) {
  if (deg == null) return null;
  const idx = Math.round(((((deg % 360) + 360) % 360) / 360) * 16) % 16;
  return COMPASS_POINTS[idx];
}

function nearestHourly(series, atMs) {
  if (!series.length) return null;
  let best = series[0], bestDiff = Math.abs(series[0].t.getTime() - atMs);
  for (const item of series) {
    const diff = Math.abs(item.t.getTime() - atMs);
    if (diff < bestDiff) { best = item; bestDiff = diff; }
  }
  return best;
}

// Compares "now" to ~6h ago (both nearest-hourly) -- a plain threshold in
// hPa/6h, not a fitted trendline, since a coarse rising/falling/steady
// bucket is all the card actually displays.
const PRESSURE_LOOKBACK_TOLERANCE_MS = 90 * 60000; // nearestHourly always returns ITS closest point, even if that's nowhere near 6h away (e.g. a short series) -- only trust it as "6h ago" within this tolerance

function computePressure(weatherSeries, nowMs) {
  const current = nearestHourly(weatherSeries, nowMs);
  const targetMs = nowMs - 6 * 3600000;
  const sixHoursAgo = nearestHourly(weatherSeries, targetMs);
  const sixHoursAgoValid = sixHoursAgo && Math.abs(sixHoursAgo.t.getTime() - targetMs) <= PRESSURE_LOOKBACK_TOLERANCE_MS;
  if (!current || current.pressureHpa == null || !sixHoursAgoValid || sixHoursAgo.pressureHpa == null) {
    return { hpa: current && current.pressureHpa != null ? Math.round(current.pressureHpa) : null, deltaHpa: null, trend: "steady" };
  }
  const deltaHpa = Math.round((current.pressureHpa - sixHoursAgo.pressureHpa) * 10) / 10;
  let trend = "steady";
  if (deltaHpa <= -2) trend = "falling";
  else if (deltaHpa >= 2) trend = "rising";
  return { hpa: Math.round(current.pressureHpa), deltaHpa, trend };
}

// Contiguous windows (within [dawn, dusk]) where precipitation
// probability meets the threshold -- each hourly point represents the
// hour STARTING at its timestamp, so a run's window extends 1h past its
// last point.
function computeRainWindows(weatherSeries, dawn, dusk, timeZone) {
  const dawnMs = dawn.getTime(), duskMs = dusk.getTime();
  const inWindow = weatherSeries.filter((p) => p.t.getTime() >= dawnMs && p.t.getTime() <= duskMs && p.precipProbability != null);
  const runs = [];
  let current = null;
  inWindow.forEach((p) => {
    if (p.precipProbability >= RAIN_PROBABILITY_THRESHOLD) {
      if (!current) current = { startMs: p.t.getTime(), endMs: p.t.getTime() };
      else current.endMs = p.t.getTime();
    } else if (current) {
      runs.push(current);
      current = null;
    }
  });
  if (current) runs.push(current);

  return runs.map((r) => {
    const startDate = new Date(r.startMs);
    const endDate = new Date(r.endMs + 3600000);
    return {
      start: startDate.toISOString(),
      end: endDate.toISOString(),
      label: "RAIN LIKELY " + formatLocalTime(startDate, timeZone) + "-" + formatLocalTime(endDate, timeZone)
    };
  });
}

// A meaningful wind pickup later in the window: the later peak has to
// clear an absolute floor (WIND_RAMP_MIN_ABS_MPH) AND be a real jump over
// current conditions (WIND_RAMP_MIN_INCREASE_MPH) -- a 16mph day that's
// already blowing 14mph isn't a "heads up," it's just breezy.
function computeWindRamp(weatherSeries, dawn, dusk, nowMs, timeZone) {
  const dawnMs = dawn.getTime(), duskMs = dusk.getTime();
  const future = weatherSeries.filter((p) => p.t.getTime() >= Math.max(nowMs, dawnMs) && p.t.getTime() <= duskMs && p.windMph != null);
  if (!future.length) return null;

  const current = nearestHourly(weatherSeries, nowMs);
  const currentMph = current && current.windMph != null ? current.windMph : 0;
  let peak = future[0];
  future.forEach((p) => { if (p.windMph > peak.windMph) peak = p; });

  if (peak.windMph < WIND_RAMP_MIN_ABS_MPH || peak.windMph - currentMph < WIND_RAMP_MIN_INCREASE_MPH) return null;

  const crossThreshold = currentMph + (peak.windMph - currentMph) * 0.5;
  const crossing = future.find((p) => p.windMph >= crossThreshold) || peak;
  const gustMph = Math.round(peak.windMph);
  const afterLabel = formatLocalTime(crossing.t, timeZone);
  return { gustMph, after: crossing.t.toISOString(), label: "WIND TO " + gustMph + " MPH AFTER " + afterLabel };
}

// Both Open-Meteo calls in parallel; returns null fields gracefully
// rather than throwing when a value just isn't available (e.g. water
// temp near shore) -- unlike a NOAA/network failure, a missing data
// field is not a reason to fail the whole card.
async function fetchWeatherSignals({ lat, lon, dawn, dusk, now, timeZone, fetchImpl }) {
  const [weatherSeries, marineSeries] = await Promise.all([
    fetchOpenMeteoWeather(lat, lon, fetchImpl),
    fetchOpenMeteoMarine(lat, lon, fetchImpl)
  ]);
  const nowMs = now.getTime();
  const currentWeather = nearestHourly(weatherSeries, nowMs);
  const currentMarine = nearestHourly(marineSeries, nowMs);

  return {
    wind: currentWeather && currentWeather.windMph != null
      ? { mph: Math.round(currentWeather.windMph), dir: degreesToCompass(currentWeather.windDir) }
      : null,
    pressure: computePressure(weatherSeries, nowMs),
    rainWindows: computeRainWindows(weatherSeries, dawn, dusk, timeZone),
    windRamp: computeWindRamp(weatherSeries, dawn, dusk, nowMs, timeZone),
    swell: currentMarine && currentMarine.waveHeightFt != null
      ? { heightFt: Math.round(currentMarine.waveHeightFt * 10) / 10, periodS: currentMarine.wavePeriodS != null ? Math.round(currentMarine.wavePeriodS) : null }
      : null,
    waterTempF: currentMarine && currentMarine.waterTempF != null ? Math.round(currentMarine.waterTempF) : null
  };
}

// station: NOAA CO-OPS station ID (numeric string, e.g. "8534720").
// lat/lon: device's (or fishing spot's) saved coordinates.
// now: injected for tests; real callers omit it and get the current time.
// fetchImpl: injected for tests; real callers omit it and get global fetch.
async function fetchTideCardData({ lat, lon, stationId }, now, fetchImpl) {
  const at = now || new Date();
  const timeZone = tzlookup(lat, lon);
  const times = SunCalc.getTimes(at, lat, lon);
  const moonTimes = SunCalc.getMoonTimes(at, lat, lon);
  const illum = SunCalc.getMoonIllumination(at);

  const dawn = times.dawn;
  const dusk = times.dusk;

  const [curve, extrema] = await Promise.all([
    fetchNoaaPredictions(stationId, dawn, dusk, "h", fetchImpl),
    fetchNoaaPredictions(stationId, dawn, dusk, "hilo", fetchImpl)
  ]);

  function labeled(date) {
    return date ? { t: date.toISOString(), label: formatLocalTime(date, timeZone) } : null;
  }

  const tideCurve = curve.map((p) => ({ t: p.t.toISOString(), heightFt: p.heightFt }));
  const solunarPeriods = computeSolunarPeriods(lat, lon, dawn, dusk, moonTimes.rise || null, moonTimes.set || null);

  // Weather is supplementary (the alert strip, footer row, and part of
  // the fishing score) -- NOAA's tide curve above is the one thing this
  // card genuinely can't function without, so only ITS failure should
  // fail the whole card. An Open-Meteo outage (or a location just outside
  // its marine model's coverage) degrades to no weather data instead,
  // same principle as swell/water-temp already degrading field-by-field
  // inside fetchWeatherSignals.
  let weather = null;
  try {
    weather = await fetchWeatherSignals({ lat, lon, dawn, dusk, now: at, timeZone, fetchImpl });
  } catch (err) {
    console.error("Couldn't reach Open-Meteo for lat=" + lat + " lon=" + lon + " (continuing without weather data):", err);
  }

  return {
    timeZone,
    dawn: labeled(dawn),
    sunrise: labeled(times.sunrise),
    sunset: labeled(times.sunset),
    dusk: labeled(dusk),
    moon: {
      illumination: illum.fraction,
      waxing: illum.waxing,
      phaseName: moonPhaseName(illum.phase),
      rise: labeled(moonTimes.rise || null),
      set: labeled(moonTimes.set || null)
    },
    tideCurve,
    tideExtrema: extrema
      .filter((p) => p.isHigh !== null)
      .map((p) => ({ t: p.t.toISOString(), label: formatLocalTime(p.t, timeZone), heightFt: p.heightFt, isHigh: p.isHigh })),
    solunarPeriods,
    weather,
    fishingScore: fishingScore({ moonIllumination: illum.fraction, solunarPeriods, tideCurve, dawn, dusk, weather })
  };
}

module.exports = {
  moonPhaseName,
  formatLocalTime,
  noaaDateParam,
  parseNoaaGmtTimestamp,
  fetchNoaaPredictions,
  findMoonAltitudeExtrema,
  computeSolunarPeriods,
  tideRateOfChange,
  fishingScore,
  parseOpenMeteoTimestamp,
  degreesToCompass,
  nearestHourly,
  computePressure,
  computeRainWindows,
  computeWindRamp,
  fetchOpenMeteoWeather,
  fetchOpenMeteoMarine,
  fetchWeatherSignals,
  fetchTideCardData
};
