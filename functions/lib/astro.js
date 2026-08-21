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
    tideCurve: curve.map((p) => ({ t: p.t.toISOString(), heightFt: p.heightFt })),
    tideExtrema: extrema
      .filter((p) => p.isHigh !== null)
      .map((p) => ({ t: p.t.toISOString(), label: formatLocalTime(p.t, timeZone), heightFt: p.heightFt, isHigh: p.isHigh }))
  };
}

module.exports = {
  moonPhaseName,
  formatLocalTime,
  noaaDateParam,
  parseNoaaGmtTimestamp,
  fetchNoaaPredictions,
  fetchTideCardData
};
