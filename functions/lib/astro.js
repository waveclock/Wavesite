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

const SunCalc = require("suncalc");
const tzlookup = require("tz-lookup");

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
  const resp = await doFetch(NOAA_BASE + "?" + params.toString());
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
// "not live tested"/"unofficial API" notes elsewhere in this file). Two
// inputs, both classic angling folklore rather than settled fact:
//   1. Tidal range (and, per the folklore, fish activity) is greatest
//      near new/full moon (spring tides) and least near the quarters
//      (neap tides).
//   2. Fish are said to feed more actively while the tide is actively
//      moving, not near slack -- so a major/minor solunar period that
//      overlaps a fast-moving stretch of today's tide curve is a second
//      positive signal.
// Phase 2 (moon + tide only) has no NEGATIVE signal yet -- that needs
// weather (Phase 3: high wind, sharp pressure drops), so this never
// returns "Poor" yet.
const FISHING_SCORE_LEVELS = ["Fair", "Good", "Excellent"];

function fishingScore({ moonIllumination, solunarPeriods, tideCurve, dawn, dusk }) {
  let points = 0;

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

  return FISHING_SCORE_LEVELS[Math.min(points, FISHING_SCORE_LEVELS.length - 1)];
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
    fishingScore: fishingScore({ moonIllumination: illum.fraction, solunarPeriods, tideCurve, dawn, dusk })
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
  fetchTideCardData
};
