"use strict";

// Sun/moon/twilight (via suncalc) + NOAA tide predictions, shaped into one
// ready-to-draw payload for the Tide & Fishing card. Both the live preview
// (astroProxy, called from design's browser) and the daily regeneration
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
// see fetchNoaaPredictions below for how a real production failure was
// actually diagnosed instead -- by asking the customer to hit NOAA
// directly from their own browser and compare responses, since this
// sandbox can't reach it either.
//
// All three outbound fetches (NOAA, Open-Meteo weather, Open-Meteo
// marine) send OUTBOUND_FETCH_HEADERS (lib/http.js) -- a real browser
// User-Agent instead of Node's own default ("User-Agent: node", a plain
// bot signal) -- the same fix applied to fetchDitheredLogo (dynamic.js)
// after a real live ESPN CDN failure. This did NOT turn out to be the
// cause of a live NOAA 502 that came up after deploy (see
// fetchNoaaPredictions's comment for the actual cause -- time_zone, not
// headers or datum), but it's a real improvement in its own right and
// left in place.

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

// "August 25, 2026" -- the Sun/Moon/Tide Timeline card's date line.
function formatLongDate(date, timeZone) {
  if (!date) return null;
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone }).format(date);
}

// NOAA's begin_date/end_date, precise to the minute, in the station's own
// local wall-clock time (time_zone=lst_ldt -- see the fetchNoaaPredictions
// comment below for why this has to be local time, not GMT) --
// "yyyyMMdd HH:mm". Intl.DateTimeFormat already does the UTC-instant ->
// local-wall-clock conversion directly; no offset math needed in this
// direction.
function noaaLocalDateParam(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  const hour = get("hour") === "24" ? "00" : get("hour"); // some ICU versions format midnight as "24:00" with hour12:false
  return get("year") + get("month") + get("day") + " " + hour + ":" + get("minute");
}

// NOAA's "t" field under time_zone=lst_ldt is "yyyy-MM-dd HH:mm" in the
// station's own local wall-clock time (LST or LDT, whichever applies on
// that date -- NOAA picks the right one; this uses the same IANA zone
// tzlookup derived for this lat/lon, which should always agree). JS has
// no built-in "wall time in this zone -> UTC instant" conversion, so this
// uses the standard trick: parse the string as if it were UTC (a
// guess), format that guess back out in `timeZone` to see what wall
// clock time it actually represents there, and correct by the
// difference -- one pass is enough since zone offsets are whole/half
// hours, not something that drifts across a single correction.
function parseNoaaLocalTimestamp(t, timeZone) {
  const naiveUtc = new Date(t.replace(" ", "T") + "Z");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).formatToParts(naiveUtc);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const hour = parts.find((p) => p.type === "hour").value === "24" ? 0 : get("hour");
  const asIfUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return new Date(naiveUtc.getTime() - (asIfUtc - naiveUtc.getTime()));
}

// datum is "MLLW" -- an earlier attempt switched this to "STND" on the
// theory that STND is universally supported and MLLW isn't, but that
// theory was wrong: confirmed directly against NOAA for a real
// subordinate station (stationId=8534975, with time_zone already fixed
// to lst_ldt -- see below), STND failed on both interval=h and
// interval=hilo, while MLLW succeeded. NOAA's own docs call STND the
// universal fallback, but real subordinate-station behavior doesn't
// bear that out, at least for this station -- MLLW is what actually
// works, matching ordinary usage (nautical charts, other tide clocks),
// so that's what's used, with no fallback chain to STND since there's
// no evidence it's ever actually needed.
//
// time_zone is "lst_ldt" (the station's own local time), not "gmt" --
// this is the actual cause of a live 502/422 for stationId=8534975 that
// switching datum alone did NOT fix (identical error with both MLLW and
// STND, when both were tried under time_zone=gmt). Confirmed directly
// against NOAA, no code involved: requesting this station's predictions
// with time_zone=gmt failed for every datum and every interval (h and
// hilo both), but the exact same request with time_zone=lst_ldt instead
// succeeded -- for both this subordinate station and a reference station
// (Atlantic City) that already worked fine either way. Likely
// explanation: subordinate-station predictions are computed as a time/
// height offset from a reference station, anchored to local calendar
// days -- a gmt-specified window can straddle different local calendar
// days than intended, breaking that computation, while a reference
// station's full harmonic computation doesn't care either way (hence it
// working under both time zones, masking the real bug until a
// subordinate station was actually tried).
async function fetchNoaaPredictions(stationId, begin, end, interval, timeZone, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const params = new URLSearchParams({
    station: stationId,
    product: "predictions",
    datum: "MLLW",
    time_zone: "lst_ldt",
    units: "english",
    format: "json",
    begin_date: noaaLocalDateParam(begin, timeZone),
    end_date: noaaLocalDateParam(end, timeZone),
    interval
  });
  const resp = await doFetch(NOAA_BASE + "?" + params.toString(), { headers: OUTBOUND_FETCH_HEADERS });
  const data = await resp.json();
  if (data && data.error) {
    // A well-formed JSON error body means NOAA was reached fine and gave a
    // clear answer -- this is NOT a connectivity problem, so it's tagged
    // separately from a thrown/network-level failure (a timeout, DNS
    // failure, etc.) so astroProxyHandler can tell a customer something
    // more useful than "couldn't reach NOAA" when the real story is "this
    // station has no predictions data for this specific request" -- which,
    // once datum/time_zone are both right, can still legitimately happen
    // for interval=h alone: some subordinate stations only carry
    // time/height-offset hi/lo predictions (interval=hilo) from a
    // reference station, with no continuous harmonic curve computed for
    // them at all. fetchTideCardData below treats that one case as
    // recoverable (empty curve, hi/lo points only) and everything else
    // (interval=hilo failing, or a genuine connectivity error) as fatal.
    const err = new Error(data.error.message || "NOAA returned an error");
    err.noaaDataError = true;
    throw err;
  }
  return (data.predictions || []).map((p) => ({
    t: parseNoaaLocalTimestamp(p.t, timeZone),
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

// SunCalc.getMoonTimes always truncates its own search window to UTC
// midnight (`t.setUTCHours(0,0,0,0)` in its source) regardless of what
// time-of-day is passed in -- so for any US timezone, its 24h search
// window is offset several hours from the LOCAL calendar day we actually
// want. A real Ocean City moonrise at 8:14 PM EDT (00:14 UTC the next
// day) falls just past that UTC boundary, so getMoonTimes(anchor) for
// that local day returns rise: null (the rise "belongs" to the next
// UTC day's search instead) -- even though the moon undeniably rises
// that evening. Confirmed by direct altitude sampling: every day in a
// real multi-day span had exactly one rise and one set, contradicting
// getMoonTimes' null. This is the same class of bug findMoonAltitudeExtrema
// below already sidesteps for transits (see its own comment) --
// horizon-crossing sampling has no day-boundary ambiguity because it
// operates on the caller's own absolute [from, to) window, not
// SunCalc's internal one.
// A raw altitude=0 crossing is NOT what "moonrise" conventionally means --
// SunCalc's own (unexported) getMoonTimes internals define it via a
// "moonHeight" that adds a parallax term (the moon is close enough that its
// horizontal parallax matters, unlike the sun) plus a small refraction
// constant: altitude + 0.2725*asin(earthRadius/distance) [in degrees] +
// 0.09deg. Confirmed by cross-checking: using raw altitude<0 here landed
// real Ocean City moonrises ~2 minutes late against both getMoonTimes and
// independently-sourced real moonrise times for the same date/location.
// Reimplemented locally (rather than switching back to getMoonTimes
// itself) because getMoonTimes' *search window* is the actual bug this
// function exists to fix -- see the comment below.
const MOON_EARTH_RADIUS_KM = 6378.14;
function moonHeightDeg(lat, lon, date) {
  const p = SunCalc.getMoonPosition(date, lat, lon);
  return p.altitude + 0.2725 * (Math.asin(MOON_EARTH_RADIUS_KM / p.distance) * 180 / Math.PI) + 0.09;
}

function findMoonRiseSet(lat, lon, from, to, stepMinutes) {
  const events = [];
  let prevH = moonHeightDeg(lat, lon, from);
  let prevT = from;
  for (let ms = from.getTime() + stepMinutes * 60000; ms <= to.getTime(); ms += stepMinutes * 60000) {
    const t = new Date(ms);
    const h = moonHeightDeg(lat, lon, t);
    if ((prevH < 0) !== (h < 0)) {
      // Bisect within the bracket for a precise crossing time (20 halvings
      // shrinks a several-minute step down to a fraction of a second --
      // far more precise than a "h:mm AM/PM" label needs).
      let lo = prevT.getTime(), hi = t.getTime(), loNeg = prevH < 0;
      for (let i = 0; i < 20; i++) {
        const mid = (lo + hi) / 2;
        const midNeg = moonHeightDeg(lat, lon, new Date(mid)) < 0;
        if (midNeg === loNeg) lo = mid; else hi = mid;
      }
      events.push({ kind: h > prevH ? "rise" : "set", t: new Date((lo + hi) / 2) });
    }
    prevH = h;
    prevT = t;
  }
  return events;
}

// extremaType distinguishes which kind of transit this is -- "overhead"
// (altitude local max, the moon crossing the local meridian) vs
// "underfoot" (altitude local min, the antitransit on the opposite side
// of the earth) -- added for the Sun/Moon/Tide Timeline card, which
// draws these as two different markers. computeSolunarPeriods below
// only ever needed "this is a major-period center," so it ignores this
// field; adding it here is non-breaking for that caller.
function findMoonAltitudeExtrema(lat, lon, from, to, stepMinutes) {
  const extrema = [];
  let prevAlt = SunCalc.getMoonPosition(from, lat, lon).altitude;
  let prevPrevAlt = null;
  let prevT = from;
  for (let ms = from.getTime() + stepMinutes * 60000; ms <= to.getTime(); ms += stepMinutes * 60000) {
    const t = new Date(ms);
    const alt = SunCalc.getMoonPosition(t, lat, lon).altitude;
    if (prevPrevAlt !== null) {
      if (prevAlt > prevPrevAlt && prevAlt > alt) extrema.push({ kind: "major", extremaType: "overhead", t: prevT });
      if (prevAlt < prevPrevAlt && prevAlt < alt) extrema.push({ kind: "major", extremaType: "underfoot", t: prevT });
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

// The UTC instant that reads as 00:00:00 local, on the same local
// calendar date as `now` -- for the Sun/Moon/Tide Timeline card's
// midnight-to-midnight x-axis. JS has no built-in local-midnight
// lookup, but this doesn't need one: `now`'s own local wall-clock time
// (via Intl) is exactly how far past local midnight `now` already is,
// so subtracting that off `now` lands on local midnight directly --
// no guess-and-correct needed (unlike parseNoaaLocalTimestamp above,
// which has to invert an arbitrary wall-clock STRING with no anchor
// instant to measure from in the first place).
function localMidnight(now, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).formatToParts(now);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const hour = get("hour") % 24; // some ICU versions format midnight as "24" with hour12:false
  const msIntoLocalDay = hour * 3600000 + get("minute") * 60000 + get("second") * 1000;
  return new Date(now.getTime() - msIntoLocalDay);
}

// Sun/moon/tide data for the Sun/Moon/Tide Timeline card -- a full
// local calendar day (midnight to midnight), unlike fetchTideCardData's
// dawn-to-dusk window. Doesn't need the continuous tide curve (only
// hi/lo points), weather, or the fishing score, so it skips all three
// -- lighter weight than fetchTideCardData on purpose. moonEvents
// combines rise/set/overhead/underfoot into one time-ordered list (like
// tideExtrema's own array-of-events shape) rather than fixed named
// fields, since a 24h window can rarely hold zero or two of any of
// them (the lunar day runs ~24h50m, not 24h).
const TIMELINE_SAMPLE_MARGIN_MS = 3 * 3600000;
async function fetchTideTimelineData({ lat, lon, stationId }, now, fetchImpl) {
  const at = now || new Date();
  const timeZone = tzlookup(lat, lon);
  const dayStart = localMidnight(at, timeZone);
  const dayEnd = new Date(dayStart.getTime() + 24 * 3600000);

  // SunCalc buckets a date's sun/moon events by its UTC calendar day, not
  // the caller's local one -- passing `at` directly would compute
  // *tomorrow's* sunrise/sunset (in UTC terms) for any local evening hour
  // whose UTC instant has already rolled to the next UTC date (roughly
  // 8pm-midnight local time for US beach towns), silently filtering both
  // out of the inWindow() checks below. Anchoring to local noon of this
  // same calendar day sidesteps that regardless of what time `at` is.
  const localNoonAnchor = new Date(dayStart.getTime() + 12 * 3600000);
  const times = SunCalc.getTimes(localNoonAnchor, lat, lon);
  const illum = SunCalc.getMoonIllumination(at);

  const transits = findMoonAltitudeExtrema(
    lat, lon,
    new Date(dayStart.getTime() - TIMELINE_SAMPLE_MARGIN_MS),
    new Date(dayEnd.getTime() + TIMELINE_SAMPLE_MARGIN_MS),
    SOLUNAR_SAMPLE_STEP_MIN
  );
  const riseSetEvents = findMoonRiseSet(
    lat, lon,
    new Date(dayStart.getTime() - TIMELINE_SAMPLE_MARGIN_MS),
    new Date(dayEnd.getTime() + TIMELINE_SAMPLE_MARGIN_MS),
    SOLUNAR_SAMPLE_STEP_MIN
  );

  const extrema = await fetchNoaaPredictions(stationId, dayStart, dayEnd, "hilo", timeZone, fetchImpl);

  function labeled(date) {
    return { t: date.toISOString(), label: formatLocalTime(date, timeZone) };
  }
  function labeledEvent(date, kind) {
    const event = { t: date.toISOString(), label: formatLocalTime(date, timeZone), kind };
    // Direction only makes sense at the horizon (rise/set) -- SunCalc's
    // getMoonPosition().azimuth is already standard compass degrees
    // (0=N, clockwise) in this version, no radian conversion needed.
    if (kind === "rise" || kind === "set") {
      const azimuthDeg = Math.round(SunCalc.getMoonPosition(date, lat, lon).azimuth);
      event.azimuthDeg = azimuthDeg;
      event.compass = degreesToCompass(azimuthDeg);
    }
    return event;
  }
  const inWindow = (d) => d >= dayStart && d < dayEnd;

  const moonEvents = [];
  riseSetEvents.forEach((ev) => { if (inWindow(ev.t)) moonEvents.push(labeledEvent(ev.t, ev.kind)); });
  transits.forEach((tr) => { if (inWindow(tr.t)) moonEvents.push(labeledEvent(tr.t, tr.extremaType)); });
  moonEvents.sort((a, b) => new Date(a.t) - new Date(b.t));

  return {
    timeZone,
    dayStart: dayStart.toISOString(),
    dayEnd: dayEnd.toISOString(),
    sunrise: inWindow(times.sunrise) ? labeled(times.sunrise) : null,
    sunset: inWindow(times.sunset) ? labeled(times.sunset) : null,
    moonPhase: {
      illumination: illum.fraction,
      waxing: illum.waxing,
      phaseName: moonPhaseName(illum.phase)
    },
    moonEvents,
    tideExtrema: extrema
      .filter((p) => p.isHigh !== null && inWindow(p.t))
      .map((p) => ({ t: p.t.toISOString(), label: formatLocalTime(p.t, timeZone), heightFt: p.heightFt, isHigh: p.isHigh }))
  };
}

// Some subordinate stations have no continuous curve at all (see
// fetchNoaaPredictions's comment) -- only discrete hi/lo points. Rather
// than draw nothing between them, approximate the shape with a cosine
// ("versine") interpolation between each consecutive pair: a tide
// genuinely flattens out right at each high/low (zero rate of change at
// the extremum itself) and moves fastest around the midpoint, which is
// exactly the shape a cosine interpolation produces -- unlike a straight
// line, which would draw a sharp, physically-wrong corner at every
// hi/lo. This is the same shape behind the "rule of twelfths" mariners
// have used by hand for centuries to estimate tide height between known
// highs and lows. Purely a visual approximation for stations lacking
// real curve data -- fetchTideCardData only calls this when the real
// curve came back empty.
const CURVE_INTERPOLATION_STEP_MIN = 15;
function interpolateTideCurveFromExtrema(extrema) {
  const points = [];
  for (let i = 0; i < extrema.length - 1; i++) {
    const a = extrema[i], b = extrema[i + 1];
    const aMs = a.t.getTime(), bMs = b.t.getTime();
    for (let ms = aMs; ms < bMs; ms += CURVE_INTERPOLATION_STEP_MIN * 60000) {
      const frac = (ms - aMs) / (bMs - aMs);
      const eased = (1 - Math.cos(Math.PI * frac)) / 2; // 0 at a, 1 at b, flat-sloped at both ends
      points.push({ t: new Date(ms), heightFt: a.heightFt + (b.heightFt - a.heightFt) * eased });
    }
  }
  if (extrema.length) points.push({ t: extrema[extrema.length - 1].t, heightFt: extrema[extrema.length - 1].heightFt });
  return points;
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
    hourly: "wind_speed_10m,wind_direction_10m,surface_pressure,precipitation_probability,cloud_cover",
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
    precipProbability: h.precipitation_probability ? h.precipitation_probability[i] : null,
    // Percent (0-100) of sky covered by cloud -- drives Beach Buddy's
    // "sunny, no clouds" signal (see businessHoursCloudCoverPct below),
    // not used by the Tide & Fishing card.
    cloudCoverPct: h.cloud_cover ? h.cloud_cover[i] : null
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

// The single most extreme reading of `key` within [startMs, endMs]
// (inclusive) -- the same "scan a window, keep the worst/most-notable
// point" shape computeWindRamp's own peak search already uses,
// generalized so businessHoursWind/businessHoursSwell below (and any
// future window-based signal) can share it instead of each
// reimplementing the loop.
function computeWindowPeak(series, key, startMs, endMs) {
  const inWindow = series.filter((p) => p.t.getTime() >= startMs && p.t.getTime() <= endMs && p[key] != null);
  if (!inWindow.length) return null;
  let best = inWindow[0];
  inWindow.forEach((p) => { if (p[key] > best[key]) best = p; });
  return best;
}

// The AVERAGE value of `key` within [startMs, endMs] (inclusive) --
// unlike computeWindowPeak's "worst single point," a signal like cloud
// cover cares about the overall day, not one particularly clear or
// overcast hour: a single clear 10am reading inside an otherwise
// overcast business-hours window shouldn't read as "sunny."
function computeWindowAverage(series, key, startMs, endMs) {
  const inWindow = series.filter((p) => p.t.getTime() >= startMs && p.t.getTime() <= endMs && p[key] != null);
  if (!inWindow.length) return null;
  const sum = inWindow.reduce((total, p) => total + p[key], 0);
  return sum / inWindow.length;
}

// Both Open-Meteo calls in parallel; returns null fields gracefully
// rather than throwing when a value just isn't available (e.g. water
// temp near shore) -- unlike a NOAA/network failure, a missing data
// field is not a reason to fail the whole card.
//
// `businessHoursStart`/`businessHoursEnd`, when given, add two EXTRA
// forward-looking fields (businessHoursWind/businessHoursSwell) on top
// of the existing "right now" wind/swell -- Beach Buddy's mood
// (moodForBeachData in dynamic.js) needs to know what conditions will
// be like during the hours someone's actually likely to be looking at
// the display, not literally this instant: the once-a-day regeneration
// job runs overnight, when "current" conditions say nothing about the
// afternoon ahead. The Tide & Fishing card doesn't pass these and
// doesn't get them -- it genuinely wants "right now," unchanged.
async function fetchWeatherSignals({ lat, lon, dawn, dusk, now, timeZone, businessHoursStart, businessHoursEnd, fetchImpl }) {
  const [weatherSeries, marineSeries] = await Promise.all([
    fetchOpenMeteoWeather(lat, lon, fetchImpl),
    fetchOpenMeteoMarine(lat, lon, fetchImpl)
  ]);
  const nowMs = now.getTime();
  const currentWeather = nearestHourly(weatherSeries, nowMs);
  const currentMarine = nearestHourly(marineSeries, nowMs);

  const bhStartMs = businessHoursStart ? businessHoursStart.getTime() : null;
  const bhEndMs = businessHoursEnd ? businessHoursEnd.getTime() : null;
  const bhWindPeak = bhStartMs != null ? computeWindowPeak(weatherSeries, "windMph", bhStartMs, bhEndMs) : null;
  const bhSwellPeak = bhStartMs != null ? computeWindowPeak(marineSeries, "waveHeightFt", bhStartMs, bhEndMs) : null;
  const bhCloudCoverAvg = bhStartMs != null ? computeWindowAverage(weatherSeries, "cloudCoverPct", bhStartMs, bhEndMs) : null;

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
    waterTempF: currentMarine && currentMarine.waterTempF != null ? Math.round(currentMarine.waterTempF) : null,
    businessHoursWind: bhWindPeak
      ? { mph: Math.round(bhWindPeak.windMph), dir: degreesToCompass(bhWindPeak.windDir) }
      : null,
    businessHoursSwell: bhSwellPeak
      ? { heightFt: Math.round(bhSwellPeak.waveHeightFt * 10) / 10, periodS: bhSwellPeak.wavePeriodS != null ? Math.round(bhSwellPeak.wavePeriodS) : null }
      : null,
    // Average, not peak (see computeWindowAverage) -- Beach Buddy's "big
    // sun" detail (moodForBeachData in dynamic.js) wants "is today
    // mostly clear," not "was there one especially clear hour."
    businessHoursCloudCoverPct: bhCloudCoverAvg != null ? Math.round(bhCloudCoverAvg) : null
  };
}

// station: NOAA CO-OPS station ID (numeric string, e.g. "8534720").
// lat/lon: device's (or fishing spot's) saved coordinates.
// now: injected for tests; real callers omit it and get the current time.
// fetchImpl: injected for tests; real callers omit it and get global fetch.
async function fetchTideCardData({ lat, lon, stationId }, now, fetchImpl) {
  const at = now || new Date();
  const timeZone = tzlookup(lat, lon);
  // See fetchTideTimelineData's comment on localNoonAnchor -- same fix,
  // needed here too since dawn/dusk (derived from SunCalc) set the NOAA
  // fetch window below and would otherwise silently shift to tomorrow for
  // any local evening `at`.
  const dayStart = localMidnight(at, timeZone);
  const dayEnd = new Date(dayStart.getTime() + 24 * 3600000);
  const localNoonAnchor = new Date(dayStart.getTime() + 12 * 3600000);
  const times = SunCalc.getTimes(localNoonAnchor, lat, lon);
  const illum = SunCalc.getMoonIllumination(at);

  const dawn = times.dawn;
  const dusk = times.dusk;

  // Beach Buddy's "business hours" reference window (10:00am-4:30pm
  // local) -- see moodForBeachData in dynamic.js for the full reasoning.
  // Short version: rain/wind/swell/tide should be judged against what's
  // actually forecast for the hours someone's likely to be at their
  // desk, not literally "right now" -- the once-daily regeneration job
  // runs overnight. Same fixed-offset-from-local-midnight approach
  // localNoonAnchor above already uses (not exact across a DST-
  // transition day, an existing, accepted limitation of that pattern in
  // this file).
  const businessHoursStart = new Date(dayStart.getTime() + 10 * 3600000);
  const businessHoursEnd = new Date(dayStart.getTime() + 16.5 * 3600000);

  // See findMoonRiseSet's comment above: SunCalc.getMoonTimes' own search
  // window is UTC-midnight-anchored, not local-midnight, so it silently
  // drops real evening moonrise/moonset events for US timezones. Sampling
  // directly over this card's own local calendar day (with margin, same
  // as fetchTideTimelineData) sidesteps that.
  const riseSetEvents = findMoonRiseSet(
    lat, lon,
    new Date(dayStart.getTime() - TIMELINE_SAMPLE_MARGIN_MS),
    new Date(dayEnd.getTime() + TIMELINE_SAMPLE_MARGIN_MS),
    SOLUNAR_SAMPLE_STEP_MIN
  );
  const inCalendarDay = (d) => d >= dayStart && d < dayEnd;
  const moonRise = riseSetEvents.find((ev) => ev.kind === "rise" && inCalendarDay(ev.t)) || null;
  const moonSet = riseSetEvents.find((ev) => ev.kind === "set" && inCalendarDay(ev.t)) || null;

  // hilo (the day's high/low points) is the one thing this card can't
  // function without -- if NOAA has no predictions data for this station
  // at all, there's nothing to draw and the whole card should fail, same
  // as before. The continuous curve (interval=h) is a nice-to-have on
  // top of that: confirmed for a real production station that some
  // subordinate stations only carry hi/lo predictions (a time/height
  // offset from a reference station) with no continuous curve computed
  // for them at all -- interval=h failed there under every datum/
  // time_zone combination tried, while interval=hilo succeeded once
  // datum/time_zone were both right. So only a hilo failure fails the
  // whole card; an h-specific noaaDataError degrades to an empty curve.
  // drawTideCard already skips the curve line entirely when tideCurve
  // has 0-1 points (see dynamic.js), showing just the hi/lo dots and
  // labels -- and its height-scale calculation includes extrema heights
  // precisely so that still-shown case scales correctly with no curve
  // data to derive a range from.
  const hiloPromise = fetchNoaaPredictions(stationId, dawn, dusk, "hilo", timeZone, fetchImpl);
  const curvePromise = fetchNoaaPredictions(stationId, dawn, dusk, "h", timeZone, fetchImpl);
  // Both promises start concurrently, but only get awaited (and their
  // rejection handled) below, at different points -- if hiloPromise
  // rejects first, curvePromise's own independent rejection would
  // otherwise be a real unhandled promise rejection (Node treats that as
  // fatal). Attaching a no-op .catch() here doesn't swallow the real
  // handling below -- a promise can have multiple independent .then/
  // .catch/await chains off the same settled value, so the try/catch
  // around "await curvePromise" further down still sees and handles the
  // original rejection; this just stops it from ever being unhandled.
  curvePromise.catch(() => {});
  const extrema = await hiloPromise;
  let curve = [];
  try {
    curve = await curvePromise;
  } catch (err) {
    if (!err.noaaDataError) throw err; // a genuine connectivity failure should still fail the whole card
    console.error("NOAA has no continuous tide curve for stationId=" + stationId + " (continuing with an interpolated curve from hi/lo points):", err);
  }
  if (curve.length === 0 && extrema.length >= 2) {
    curve = interpolateTideCurveFromExtrema(extrema);
  }

  function labeled(date) {
    return date ? { t: date.toISOString(), label: formatLocalTime(date, timeZone) } : null;
  }

  const tideCurve = curve.map((p) => ({ t: p.t.toISOString(), heightFt: p.heightFt }));
  const solunarPeriods = computeSolunarPeriods(lat, lon, dawn, dusk, moonRise ? moonRise.t : null, moonSet ? moonSet.t : null);

  // Weather is supplementary (the alert strip, footer row, and part of
  // the fishing score) -- NOAA's tide curve above is the one thing this
  // card genuinely can't function without, so only ITS failure should
  // fail the whole card. An Open-Meteo outage (or a location just outside
  // its marine model's coverage) degrades to no weather data instead,
  // same principle as swell/water-temp already degrading field-by-field
  // inside fetchWeatherSignals.
  let weather = null;
  try {
    weather = await fetchWeatherSignals({ lat, lon, dawn, dusk, now: at, timeZone, businessHoursStart, businessHoursEnd, fetchImpl });
  } catch (err) {
    console.error("Couldn't reach Open-Meteo for lat=" + lat + " lon=" + lon + " (continuing without weather data):", err);
  }

  return {
    timeZone,
    dawn: labeled(dawn),
    sunrise: labeled(times.sunrise),
    sunset: labeled(times.sunset),
    dusk: labeled(dusk),
    businessHoursStart: labeled(businessHoursStart),
    businessHoursEnd: labeled(businessHoursEnd),
    moon: {
      illumination: illum.fraction,
      waxing: illum.waxing,
      phaseName: moonPhaseName(illum.phase),
      rise: labeled(moonRise ? moonRise.t : null),
      set: labeled(moonSet ? moonSet.t : null)
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
  formatLongDate,
  noaaLocalDateParam,
  parseNoaaLocalTimestamp,
  fetchNoaaPredictions,
  findMoonAltitudeExtrema,
  computeSolunarPeriods,
  localMidnight,
  fetchTideTimelineData,
  interpolateTideCurveFromExtrema,
  tideRateOfChange,
  fishingScore,
  parseOpenMeteoTimestamp,
  degreesToCompass,
  nearestHourly,
  computePressure,
  computeRainWindows,
  computeWindRamp,
  computeWindowPeak,
  computeWindowAverage,
  fetchOpenMeteoWeather,
  fetchOpenMeteoMarine,
  fetchWeatherSignals,
  fetchTideCardData
};
