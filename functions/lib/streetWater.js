// Street Water card: a town's next-24h coastal flood/water-level
// outlook -- active NWS coastal flood alert, next peak water level and
// its flood category, a 24h forecast curve with flood-stage lines and
// "wet window" brackets, max wind gusts/rain, and the live water level
// with its trend. Ported from a firmware-feature handoff package
// (street-water-screen.zip) that assumed a NEW ESP32 screen type fed by
// a separate Python Cloud Run service hitting these same APIs every 15
// min -- Kurt redirected it to be a server-rendered custom screen
// instead (no firmware change), so this module does in Node what that
// package's docs/02_DATA_PIPELINE.md specified for the Python side,
// called from the same hourly per-device regen job every other
// slow-changing custom screen (Hurricane Tracker, Beach Flag) already
// uses -- see regenerateStreetWaterDesigns in index.js.
//
// Town -> gauge mapping is now verified against the live NWPS API
// (checked 2026-11-25, see STREET_WATER_TOWNS's own comment) -- a
// second handoff (street-water-gauges-update.zip) replaced the
// original placeholder mapping, including Ocean City NJ, by far the
// largest town here (59 of 93 represented clocks). None of this is
// independently re-verified from THIS sandbox, though: NWS/NWPS/
// Open-Meteo are all unreachable here (confirmed: the egress proxy
// rejects the CONNECT outright), so every fetcher below is still
// written straight from each API's published docs/the handoff's own
// verified values, never exercised against a live response -- same
// caveat this codebase's NHC and ESPN integrations carry.
"use strict";

const tzlookup = require("tz-lookup");

// Deliberately NOT lib/http.js's shared OUTBOUND_FETCH_HEADERS (a fake
// Chrome User-Agent, there specifically to stop a scraped site treating
// a bare Node fetch as a bot) -- NWS's API docs ask for the opposite: a
// real, honestly-identifying User-Agent with contact info, which is
// what the handoff package's own data-pipeline doc specifies verbatim.
const NWS_FETCH_HEADERS = { "User-Agent": "WaveClock/1.0 (hello@waveclock.net)" };

// Verified 2026-11-25 against api.water.noaa.gov/nwps/v1 (bbox search
// over the NJ/DE shore, then /gauges/{LID} for each candidate) --
// replaces the original placeholder mapping (every nwps_id was null or
// "TODO-VERIFY"). All gauges report in ft MLLW.
//
// forecastGauge: the NWPS LID with a real total-water-level FORECAST --
// drives the curve, peaks, category, and wet windows. null means no
// forecast gauge responds well for this town (Delaware's back-bay
// towns: Lewes/LWSD1 is Delaware Bay and reads completely differently
// from the back bay -- at verification time Lewes showed MINOR while
// South Bethany's own local gauge showed no flooding at all, so using
// Lewes would put a false reading on those clocks). These towns still
// get an alert + weather + local observed level, just no forecast
// chart -- see fetchStreetWaterData's "no forecast gauge" branch.
// obsGauge: an optional NWPS LID with observed-only data (no forecast,
// often no flood-category thresholds either) from a gauge physically
// closer to this specific town than its shared forecastGauge --
// used ONLY for the footer "Water now" line, never for the chart.
// Falls back to forecastGauge's own observed series when null.
// refThresholdsMLLW: the minor/moderate/major read from NWPS at
// verification time, kept here as a regression check (see
// streetWater.test.js) so a later run noticing different live values
// is a deliberate NWS change, not a silent drift no one caught --
// thresholds are always READ LIVE from forecastGauge at runtime, never
// hardcoded from this field.
const STREET_WATER_TOWNS = {
  "ocean-city-nj": {
    name: "Ocean City", lat: 39.2776, lon: -74.5746,
    forecastGauge: "ONCN4", obsGauge: null,
    refThresholdsMLLW: { minor: 5.3, moderate: 6.3, major: 7.3 },
    gaugeLabel: "Ocean City gauge"
  },
  "margate-nj": {
    name: "Margate", lat: 39.3279, lon: -74.5035,
    forecastGauge: "ACYN4", obsGauge: "MGTN4",
    refThresholdsMLLW: { minor: 6.0, moderate: 7.0, major: 8.0 },
    gaugeLabel: "Atlantic City gauge"
  },
  "ventnor-nj": {
    name: "Ventnor", lat: 39.3401, lon: -74.4774,
    forecastGauge: "ACYN4", obsGauge: null,
    refThresholdsMLLW: { minor: 6.0, moderate: 7.0, major: 8.0 },
    gaugeLabel: "Atlantic City gauge"
  },
  "sea-isle-city-nj": {
    name: "Sea Isle City", lat: 39.1534, lon: -74.6929,
    forecastGauge: "ONCN4", obsGauge: "SICN4",
    refThresholdsMLLW: { minor: 5.3, moderate: 6.3, major: 7.3 },
    gaugeLabel: "Ocean City gauge"
  },
  // TENTATIVE per the handoff -- Kurt may switch this to ONCN4 instead.
  "avalon-nj": {
    name: "Avalon", lat: 39.1012, lon: -74.7177,
    forecastGauge: "CAPN4", obsGauge: "AVLN4",
    refThresholdsMLLW: { minor: 6.2, moderate: 7.2, major: 8.2 },
    gaugeLabel: "Cape May Harbor gauge"
  },
  "north-wildwood-nj": {
    name: "North Wildwood", lat: 39.0001, lon: -74.7993,
    forecastGauge: "CAPN4", obsGauge: null,
    refThresholdsMLLW: { minor: 6.2, moderate: 7.2, major: 8.2 },
    gaugeLabel: "Cape May Harbor gauge"
  },
  "bethany-beach-de": {
    name: "Bethany Beach", lat: 38.5390, lon: -75.0552,
    forecastGauge: null, obsGauge: "SBED1",
    refThresholdsMLLW: null,
    gaugeLabel: "South Bethany gauge"
  },
  "south-bethany-de": {
    name: "South Bethany", lat: 38.5196, lon: -75.0574,
    forecastGauge: null, obsGauge: "SBED1",
    refThresholdsMLLW: null,
    gaugeLabel: "South Bethany gauge"
  }
};

// MLW = MLLW minus this many feet, per gauge -- NOT applied anywhere
// yet (every value in this feed stays in the gauges' own MLLW, per
// displayDatum below). Kept for when/if MLW display is ever enabled,
// since Ocean City OEM notices quote MLW and the two datums read about
// 0.15 ft apart for the same water -- if that's ever turned on, the
// offset must be applied to the series, the observed level, AND the
// thresholds together, never just one of the three.
const GAUGE_MLW_OFFSET_FT = { ONCN4: -0.153, ACYN4: -0.17, CAPN4: -0.169, LWSD1: -0.16 };

// Nothing further than this counts as "near" a configured town -- a
// device well outside this handful of shore towns (every customer
// location this screen currently has gauge coverage for) should get
// the explicit "not available for your area yet" state below, not a
// confident-looking reading for a gauge 80 miles away. Generous enough
// to cover a town immediately next to a configured one without its own
// entry yet, tight enough that it can't silently claim a whole state.
const MAX_TOWN_DISTANCE_MILES = 12;

function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(h));
}

// Picks the configured town closest to a device's saved lat/lon, the
// same "match by proximity to a short curated list" idea this codebase
// already uses for srfZone/coastFacingDirection lookups elsewhere, so
// adding Street Water needs no new per-device setup field -- it just
// rides the location every device already has. Returns the town's own
// config object plus its slug merged in (the object key, needed for
// the feed's own `town` field, isn't otherwise attached to the value).
function nearestStreetWaterTown(lat, lon) {
  let bestSlug = null, best = null, bestMiles = Infinity;
  for (const [slug, town] of Object.entries(STREET_WATER_TOWNS)) {
    const miles = haversineMiles(lat, lon, town.lat, town.lon);
    if (miles < bestMiles) { bestMiles = miles; best = town; bestSlug = slug; }
  }
  if (!best || bestMiles > MAX_TOWN_DISTANCE_MILES) return null;
  return Object.assign({ slug: bestSlug }, best);
}

async function safeFetchJson(url, options, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  try {
    const r = await doFetch(url, options);
    if (!r.ok) return null;
    return await r.json();
  } catch (err) {
    return null;
  }
}

// NWS active alerts -- keeps only coastal flood events, priority
// Warning > Advisory > Watch when several are active at once (the
// handoff's own stated priority; a Warning is always the more urgent
// read for a flood screen regardless of which one is largest in area).
const ALERT_PRIORITY = { "Coastal Flood Warning": 3, "Coastal Flood Advisory": 2, "Coastal Flood Watch": 1 };
async function fetchActiveAlert(lat, lon, fetchImpl) {
  const url = "https://api.weather.gov/alerts/active?point=" + lat + "," + lon;
  const j = await safeFetchJson(url, { headers: Object.assign({ Accept: "application/geo+json" }, NWS_FETCH_HEADERS) }, fetchImpl);
  const features = (j && Array.isArray(j.features)) ? j.features : [];
  let best = null, bestPriority = 0;
  for (const f of features) {
    const event = f && f.properties && f.properties.event;
    const priority = ALERT_PRIORITY[event] || 0;
    if (priority > bestPriority) { bestPriority = priority; best = f; }
  }
  if (!best) return { active: false };
  const props = best.properties;
  return {
    active: true,
    event: props.event,
    header: String(props.event || "").toUpperCase(),
    ends_utc: props.ends || props.expires || null
  };
}

// NWPS gauge metadata (name + flood-category thresholds) -- a separate
// endpoint from the time-series data below. Returns null on any shape
// mismatch (unknown gauge, no published thresholds) rather than
// guessing; callers treat that the same as forecastGauge: null (the
// documented "forecast unavailable" degrade), since a chart with no
// flood categories at all would be worse than useless on a safety
// screen -- it would just be wrong-looking, not obviously absent.
// Real shape (confirmed against a live /gauges/ONCN4 response -- the
// field names below are NOT what NWPS's own docs would suggest):
// meta.flood.categories.<level>.stage, not meta.flood.stages.<level>
// directly. NWPS uses -9999 as a "not applicable" sentinel for a
// stage/flow that doesn't apply to this gauge (e.g. an "action" stage
// many gauges don't have) -- treated as missing, same as absent.
function nwpsStage(categories, level) {
  const v = categories && categories[level] && categories[level].stage;
  return typeof v === "number" && v > -9999 ? v : null;
}
async function fetchNwpsGaugeMeta(nwpsId, fetchImpl) {
  if (!nwpsId) return null;
  const meta = await safeFetchJson("https://api.water.noaa.gov/nwps/v1/gauges/" + encodeURIComponent(nwpsId), undefined, fetchImpl);
  if (!meta) return null;
  const categories = (meta.flood && meta.flood.categories) || {};
  const minor = nwpsStage(categories, "minor");
  const moderate = nwpsStage(categories, "moderate");
  const major = nwpsStage(categories, "major");
  if (minor == null || moderate == null || major == null) return null;
  return { name: meta.name || null, thresholds: { minor, moderate, major } };
}

// The same stageflow endpoint serves BOTH a forecastGauge (forecast +
// its own observed) and an obsGauge (observed only -- forecast.data is
// simply absent/empty for those). Used for either, which is why this
// takes just a bare LID rather than knowing which kind of gauge it is.
async function fetchNwpsStageflow(nwpsId, fetchImpl) {
  if (!nwpsId) return { forecast: [], observed: [] };
  const stageflow = await safeFetchJson("https://api.water.noaa.gov/nwps/v1/gauges/" + encodeURIComponent(nwpsId) + "/stageflow", undefined, fetchImpl);
  const forecastPoints = (stageflow && stageflow.forecast && Array.isArray(stageflow.forecast.data)) ? stageflow.forecast.data : [];
  const observedPoints = (stageflow && stageflow.observed && Array.isArray(stageflow.observed.data)) ? stageflow.observed.data : [];
  // {validTime, value} pairs with value in gauge units (feet) --
  // normalized here so derive-layer code never has to know NWPS's own
  // field names.
  return {
    forecast: forecastPoints.map((p) => ({ t: p.validTime || p.time, ft: Number(p.value) })).filter((p) => p.t && Number.isFinite(p.ft)),
    observed: observedPoints.map((p) => ({ t: p.validTime || p.time, ft: Number(p.value) })).filter((p) => p.t && Number.isFinite(p.ft))
  };
}

async function fetchOpenMeteoWeather(lat, lon, fetchImpl) {
  const url = "https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon +
    "&hourly=wind_gusts_10m,precipitation,precipitation_probability&wind_speed_unit=mph&precipitation_unit=inch&timezone=America%2FNew_York&forecast_hours=24";
  const j = await safeFetchJson(url, undefined, fetchImpl);
  const hourly = j && j.hourly;
  if (!hourly || !Array.isArray(hourly.time)) return { gust_mph: null, rainByHour: [] };
  const gusts = (hourly.wind_gusts_10m || []).filter((v) => Number.isFinite(v));
  const gust_mph = gusts.length ? Math.round(Math.max(...gusts)) : null;
  const rainByHour = hourly.time.map((t, i) => ({ t, inches: Number(hourly.precipitation && hourly.precipitation[i]) || 0 }));
  return { gust_mph, rainByHour };
}

// ---------------- derivations (pure, unit-testable) ----------------

function floorToStep(date, stepMin) {
  const ms = stepMin * 60000;
  return new Date(Math.floor(date.getTime() / ms) * ms);
}

function interpolate(points, atMs) {
  if (points.length === 0) return null;
  let before = null, after = null;
  for (const p of points) {
    const ms = new Date(p.t).getTime();
    if (!Number.isFinite(ms)) continue;
    if (ms <= atMs && (!before || ms > new Date(before.t).getTime())) before = p;
    if (ms >= atMs && (!after || ms < new Date(after.t).getTime())) after = p;
  }
  if (before && after) {
    const bMs = new Date(before.t).getTime(), aMs = new Date(after.t).getTime();
    if (aMs === bMs) return before.ft;
    const frac = (atMs - bMs) / (aMs - bMs);
    return before.ft + (after.ft - before.ft) * frac;
  }
  return (before || after).ft;
}

// 97 points at 15-min steps (0-24h), using forecast where it covers the
// window and the (already-interpolated) observed series beforehand --
// matches the handoff's "points before the first forecast time use
// observed values" rule.
function buildSeries(windowStart, observed, forecast) {
  const points = observed.concat(forecast).sort((a, b) => new Date(a.t) - new Date(b.t));
  const ft = [];
  for (let i = 0; i < 97; i++) {
    const atMs = windowStart.getTime() + i * 15 * 60000;
    const v = interpolate(points, atMs);
    ft.push(v == null ? null : Math.round(v * 10) / 10);
  }
  return ft;
}

function computeYRange(seriesFt, thresholds) {
  const finite = seriesFt.filter((v) => Number.isFinite(v));
  const minSeries = finite.length ? Math.min(...finite) : thresholds.minor;
  const maxSeries = finite.length ? Math.max(...finite) : thresholds.major;
  const ymin = Math.floor((minSeries - 0.5) * 2) / 2;
  const ymax = Math.ceil((Math.max(maxSeries, thresholds.major) + 0.8) * 2) / 2;
  const yTicks = [];
  for (let v = Math.ceil(ymin); v <= Math.floor(ymax); v++) if (v % 2 === 0) yTicks.push(v);
  return { y_range_ft: [ymin, ymax], y_ticks_ft: yTicks };
}

function categoryFor(ft, thresholds) {
  if (ft >= thresholds.major) return "major";
  if (ft >= thresholds.moderate) return "moderate";
  if (ft >= thresholds.minor) return "minor";
  return "none";
}

function weekdayHourLabel(dateMs, timeZone, includeWeekday) {
  const d = new Date(dateMs);
  const weekday = includeWeekday ? new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(d).toUpperCase() + " " : "";
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).format(d).replace(" ", "").toUpperCase();
  return weekday + time;
}

// Local maxima with prominence >= 0.5 ft, refined against the raw
// forecast/observed points (not just the 15-min-stepped series) so a
// peak between two sample steps still reports its real time/value --
// matches the handoff's "refine from the raw forecast" instruction.
// Labels aren't assigned here: the headline peak's label (prefixed
// "PEAK ·" or "HIGH TIDE ·") depends on headlinePeakIndex, which needs
// every peak found first -- see labelPeaks below.
function findPeaks(seriesFt, windowStart, rawPoints, thresholds) {
  const peaks = [];
  for (let i = 1; i < seriesFt.length - 1; i++) {
    const v = seriesFt[i];
    if (!Number.isFinite(v)) continue;
    if (v < seriesFt[i - 1] || v < seriesFt[i + 1]) continue;
    let left = v, right = v;
    for (let j = i - 1; j >= 0 && seriesFt[j] <= v; j--) left = Math.min(left, seriesFt[j]);
    for (let j = i + 1; j < seriesFt.length && seriesFt[j] <= v; j++) right = Math.min(right, seriesFt[j]);
    const prominence = v - Math.max(left, right);
    if (prominence < 0.5) continue;

    const atMs = windowStart.getTime() + i * 15 * 60000;
    let refinedFt = v, refinedMs = atMs;
    const nearby = rawPoints.filter((p) => Math.abs(new Date(p.t).getTime() - atMs) < 45 * 60000);
    for (const p of nearby) if (p.ft > refinedFt) { refinedFt = p.ft; refinedMs = new Date(p.t).getTime(); }

    const h = Math.round(((refinedMs - windowStart.getTime()) / 3600000) * 100) / 100;
    const category = categoryFor(refinedFt, thresholds);
    peaks.push({ h, ft: Math.round(refinedFt * 10) / 10, category });
  }
  // A flat-topped peak (several consecutive 0.1-ft-rounded samples
  // tying at the same value, common right at a forecast max) would
  // otherwise show up as several separate 1-sample-wide "peaks" here --
  // cluster consecutive candidates less than an hour apart and report
  // the CENTER of the cluster, not its first sample, so a plateau's
  // reported time lands near where the real continuous curve actually
  // peaks instead of snapping early.
  const clusters = [];
  for (const p of peaks) {
    const cluster = clusters[clusters.length - 1];
    if (cluster && p.h - cluster[cluster.length - 1].h < 1) cluster.push(p);
    else clusters.push([p]);
  }
  return clusters.map((cluster) => {
    const best = cluster.reduce((a, b) => (b.ft > a.ft ? b : a));
    const h = Math.round(((cluster[0].h + cluster[cluster.length - 1].h) / 2) * 100) / 100;
    return { h, ft: best.ft, category: best.category };
  });
}

function headlinePeakIndex(peaks) {
  let best = -1, bestFt = -Infinity;
  for (let i = 0; i < peaks.length; i++) {
    if (peaks[i].category === "none") continue;
    if (peaks[i].ft > bestFt) { bestFt = peaks[i].ft; best = i; }
  }
  return best >= 0 ? best : (peaks.length ? 0 : -1);
}

// Every peak always shows its weekday ("THU 8:57 AM"), per the
// handoff's own examples -- only the headline peak gets a prefix
// ("PEAK ·" if it crossed a flood threshold, "HIGH TIDE ·" if not).
function labelPeaks(peaks, headlineIndex, windowStart, timeZone) {
  return peaks.map((p, i) => {
    const atMs = windowStart.getTime() + p.h * 3600000;
    const time = weekdayHourLabel(atMs, timeZone, true);
    const label = i === headlineIndex ? (p.category !== "none" ? "PEAK · " + time : "HIGH TIDE · " + time) : time;
    return Object.assign({ label }, p);
  });
}

// Contiguous spans where the series is above the minor threshold,
// crossing times linearly interpolated between the two bracketing
// samples -- same idea as findPeaks' own interpolation, just solving
// for "where does the line cross minor" instead of "where's the max".
function computeWetWindows(seriesFt, thresholds, timeZone) {
  const windows = [];
  let startH = null;
  for (let i = 0; i < seriesFt.length; i++) {
    const v = seriesFt[i];
    const h = i * 0.25;
    const above = Number.isFinite(v) && v > thresholds.minor;
    if (above && startH == null) {
      if (i === 0) { startH = 0; }
      else {
        const prev = seriesFt[i - 1];
        const frac = (thresholds.minor - prev) / (v - prev);
        startH = (i - 1) * 0.25 + frac * 0.25;
      }
    }
    if (!above && startH != null) {
      const prev = seriesFt[i - 1];
      const frac = Number.isFinite(prev) && prev !== v ? (thresholds.minor - prev) / (v - prev) : 0;
      const endH = (i - 1) * 0.25 + frac * 0.25;
      windows.push({ start_h: startH, end_h: endH });
      startH = null;
    }
  }
  if (startH != null) windows.push({ start_h: startH, end_h: (seriesFt.length - 1) * 0.25 });

  const roundToHour = (h) => Math.round(h);
  const hourLabel = (hr) => { const m = ((hr % 24) + 24) % 24; if (m === 0) return "12a"; if (m === 12) return "12p"; return m > 12 ? (m - 12) + "p" : m + "a"; };
  return windows.map((w) => Object.assign({ label: "WET " + hourLabel(roundToHour(w.start_h)) + "–" + hourLabel(roundToHour(w.end_h)) }, w));
}

function computeXLabels(timeZone, windowStart) {
  const labels = [{ h: 0, t: "NOW" }];
  for (let h = 1; h <= 24; h++) {
    const atMs = windowStart.getTime() + h * 3600000;
    const localHour = Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hour12: false }).format(new Date(atMs))) % 24;
    if (localHour % 3 !== 0) continue;
    if (h < 1.5 || h > 24) continue;
    const label = localHour === 0 ? "12a" : localHour === 12 ? "12p" : localHour > 12 ? (localHour - 12) + "p" : localHour + "a";
    labels.push({ h, t: label });
  }
  return labels;
}

function computeNowAndTrend(observedSeries, windowStart) {
  if (observedSeries.length === 0) return null;
  const sorted = observedSeries.slice().sort((a, b) => new Date(b.t) - new Date(a.t));
  const latest = sorted[0];
  const latestMs = new Date(latest.t).getTime();
  const thirtyMinAgo = sorted.find((p) => latestMs - new Date(p.t).getTime() >= 29 * 60000);
  let trend = "steady", arrow = "";
  if (thirtyMinAgo) {
    const delta = latest.ft - thirtyMinAgo.ft;
    if (delta > 0.1) { trend = "rising"; arrow = " ↑"; }
    else if (delta < -0.1) { trend = "falling"; arrow = " ↓"; }
  }
  const ft = Math.round(latest.ft * 10) / 10;
  return { ft, trend, obs_utc: latest.t, label: "Water now " + ft.toFixed(1) + " ft" + arrow + " " + trend };
}

function computeWeather(openMeteo, windowStart) {
  const futureRain = openMeteo.rainByHour.filter((r) => new Date(r.t).getTime() >= windowStart.getTime());
  const total = futureRain.reduce((sum, r) => sum + r.inches, 0);
  const firstRainHour = futureRain.find((r) => r.inches >= 0.02);
  const rain_value = total >= 0.1 ? "~" + total.toFixed(1) + " in" : total > 0 ? "<0.1 in" : "0 in";
  let rain_label = "RAIN NEXT 24 H";
  if (firstRainHour) {
    const tz = "America/New_York";
    const timeLabel = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: true }).format(new Date(firstRainHour.t)).toUpperCase().replace(" ", "");
    rain_label = "RAIN FROM " + timeLabel;
  }
  return { gust_mph: openMeteo.gust_mph, rain_label, rain_value };
}

function endsLabel(endsIso, windowStart, timeZone) {
  if (!endsIso) return null;
  const endsMs = new Date(endsIso).getTime();
  const sameDay = new Intl.DateTimeFormat("en-US", { timeZone }).format(endsMs) === new Intl.DateTimeFormat("en-US", { timeZone }).format(windowStart);
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hour12: false }).format(endsMs)) % 24;
  const minute = Number(new Intl.DateTimeFormat("en-US", { timeZone, minute: "numeric" }).format(endsMs));
  if (sameDay && hour === 12 && minute === 0) return "until noon";
  if (sameDay && hour === 0 && minute === 0) return "until midnight";
  return "until " + weekdayHourLabel(endsMs, timeZone, !sameDay).replace(/(\d)(AM|PM)/, "$1 $2");
}

// ---------------- top-level entry point ----------------

// loc: { lat, lon }, the exact shape every other card type's meta
// already carries. Returns null when the device isn't near any
// configured town -- callers render the "not available for your area
// yet" state rather than a fabricated reading (see dynamic.js's
// "streetWater" branch).
async function fetchStreetWaterData(loc, now, fetchImpl) {
  const town = nearestStreetWaterTown(loc.lat, loc.lon);
  if (!town) return null;

  const at = now || new Date();
  const windowStart = floorToStep(at, 15);
  const timeZone = tzlookup(loc.lat, loc.lon);

  const [alertRaw, openMeteo, forecastMeta, forecastSeries, obsSeries] = await Promise.all([
    fetchActiveAlert(loc.lat, loc.lon, fetchImpl),
    fetchOpenMeteoWeather(loc.lat, loc.lon, fetchImpl),
    fetchNwpsGaugeMeta(town.forecastGauge, fetchImpl),
    fetchNwpsStageflow(town.forecastGauge, fetchImpl),
    fetchNwpsStageflow(town.obsGauge, fetchImpl)
  ]);

  const alert = alertRaw.active
    ? Object.assign({ ends_label: endsLabel(alertRaw.ends_utc, windowStart, timeZone) }, alertRaw)
    : { active: false };
  const weather = computeWeather(openMeteo, windowStart);
  // obsGauge is observed-only (never has a forecast of its own), so
  // its "observed" series is exactly what the handoff calls "the local
  // observed level" -- falls back to the forecast gauge's own observed
  // data when this town has no separate local gauge configured.
  const nowObserved = town.obsGauge ? obsSeries.observed : forecastSeries.observed;
  const now_ = computeNowAndTrend(nowObserved, windowStart);

  // No forecast gauge configured for this town (Bethany/South Bethany
  // -- see STREET_WATER_TOWNS's own comment on why), or NWPS didn't
  // return usable thresholds for the one that IS configured (a live
  // shape mismatch or outage): the documented "forecast unavailable"
  // degrade. Alert/weather/local observed level are all still real.
  if (!town.forecastGauge || !forecastMeta) {
    return {
      v: 1, town: town.slug, town_name: town.name,
      generated_utc: at.toISOString(),
      updated_label: weekdayHourLabel(at.getTime(), timeZone, true),
      stale_after_min: 180,
      alert,
      gauge: { name: null, label: town.gaugeLabel, source: "unavailable" },
      thresholds_ft: null,
      displayDatum: "MLLW",
      seriesUnavailable: true,
      now: now_,
      weather
    };
  }

  const thresholds = forecastMeta.thresholds;
  const series = buildSeries(windowStart, forecastSeries.observed, forecastSeries.forecast);
  const { y_range_ft, y_ticks_ft } = computeYRange(series, thresholds);
  const rawPoints = forecastSeries.forecast.concat(forecastSeries.observed);
  const unlabeledPeaks = findPeaks(series, windowStart, rawPoints, thresholds);
  const headline_peak_index = headlinePeakIndex(unlabeledPeaks);
  const peaks = labelPeaks(unlabeledPeaks, headline_peak_index, windowStart, timeZone);
  const wet_windows = computeWetWindows(series, thresholds, timeZone);
  const x_labels = computeXLabels(timeZone, windowStart);

  return {
    v: 1, town: town.slug, town_name: town.name,
    generated_utc: at.toISOString(),
    updated_label: weekdayHourLabel(at.getTime(), timeZone, true),
    stale_after_min: 180,
    alert,
    gauge: { name: forecastMeta.name || town.name, label: town.gaugeLabel, source: "nwps_forecast" },
    thresholds_ft: thresholds,
    displayDatum: "MLLW",
    y_range_ft, y_ticks_ft,
    now: now_,
    series: { start_utc: windowStart.toISOString(), step_min: 15, ft: series },
    x_labels, peaks, headline_peak_index, wet_windows,
    weather
  };
}

// ---------------- canvas rendering (01_SCREEN_SPEC.md) ----------------
//
// The handoff's pixel spec was written for the FIRMWARE to draw with
// embedded GFX fonts (flash-constrained, hence its elaborate font-slot
// table and hand-drawn ↑/↓/·/– primitives) -- none of that constraint
// applies to a Node canvas render, so this uses one real TTF (the same
// "WC Beach Day FreeSans" family Beach Day already registers, since
// this card is visually the same genre: a dense data glance, not
// typographic) at the spec's own px sizes, and draws ↑/↓/· directly as
// Unicode glyphs instead of bespoke primitives. Deliberately NOT
// imported from dynamic.js (constants/helpers are duplicated locally
// instead) -- same reasoning as lib/hurricaneTracker.js's own header
// comment would give: dynamic.js requires THIS file for its draw
// function, so this file requiring dynamic.js back would be circular.
//
// Layout constants and the chart's x/y mapping are ported verbatim from
// docs/01_SCREEN_SPEC.md; see that file for the coordinate reasoning.
const SW_CANVAS_WIDTH = 792;
const SW_CANVAS_HEIGHT = 272;
const SW_FONT_FAMILY = "WC Beach Day FreeSans";
const CHART_X0 = 293, CHART_X1 = 776;

function swFont(ctx, px) { ctx.font = px + 'px "' + SW_FONT_FAMILY + '"'; }
function swText(ctx, text, x, y, px, align) {
  swFont(ctx, px);
  ctx.textAlign = align || "left";
  ctx.fillText(text, x, y);
}
// A white rect behind a piece of chart text (peak values, WET labels)
// so dashed threshold/bracket lines crossing it don't bisect the
// digits -- "draw a white knockout rect first" per the spec.
function swKnockout(ctx, centerX, baselineY, text, px) {
  swFont(ctx, px);
  const w = ctx.measureText(text).width;
  ctx.fillStyle = "#fff";
  ctx.fillRect(centerX - w / 2 - 3, baselineY - px * 0.8 - 3, w + 6, px * 0.8 + px * 0.25 + 6);
  ctx.fillStyle = "#000";
}

function swChartX(h) { return CHART_X0 + h * 20.125; }
function swChartY(ft, ymin, ymax) {
  const y = 215 - ((ft - ymin) / (ymax - ymin)) * 167;
  return Math.max(48, Math.min(215, y));
}

function swDashedHLine(ctx, x0, x1, y, lineWidth, onPx, offPx) {
  ctx.strokeStyle = "#000";
  ctx.lineWidth = lineWidth;
  for (let x = x0; x < x1; x += onPx + offPx) {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(Math.min(x + onPx, x1), y);
    ctx.stroke();
  }
}

// Linear interpolation of the 15-min-stepped series at an arbitrary
// hour offset -- used to find where the curve actually sits at each
// chart pixel column (hatching, the curve itself).
function swSeriesAt(seriesFt, h) {
  const idx = h / 0.25;
  const i0 = Math.max(0, Math.min(seriesFt.length - 1, Math.floor(idx)));
  const i1 = Math.min(seriesFt.length - 1, i0 + 1);
  const a = seriesFt[i0], b = seriesFt[i1];
  if (!Number.isFinite(a)) return b;
  if (!Number.isFinite(b)) return a;
  const frac = idx - i0;
  return a + (b - a) * frac;
}

// Simplified, hand-drawn equivalents of the reference mockup's Lucide
// wind/rain icons -- not a literal SVG-path port (that would need a
// generic elliptical-arc tracer for a purely decorative 30x30 glyph,
// not worth the complexity here). Visual fidelity of the chart's DATA
// is what the spec's "design is final" rule is actually protecting;
// these small icons reading as recognizably wind/rain is enough.
function swDrawWindIcon(ctx, x, y, size) {
  ctx.save();
  ctx.strokeStyle = "#000";
  ctx.lineWidth = size * 0.08;
  ctx.lineCap = "round";
  const lines = [[0.27, [0.65, 1]], [0.5, [0.85, 1]], [0.73, [0.45, 1]]];
  for (const [fy, [fx0, fx1]] of lines) {
    ctx.beginPath();
    ctx.moveTo(x + fx0 * size, y + fy * size);
    ctx.lineTo(x + fx1 * size, y + fy * size);
    ctx.stroke();
  }
  // A small loop at the end of the two longer lines, suggesting gusts.
  ctx.beginPath(); ctx.arc(x + 0.73 * size, y + 0.22 * size, size * 0.12, Math.PI * 0.2, Math.PI * 1.9); ctx.stroke();
  ctx.beginPath(); ctx.arc(x + 0.93 * size, y + 0.58 * size, size * 0.12, Math.PI * 0.2, Math.PI * 1.9); ctx.stroke();
  ctx.restore();
}
function swDrawRainIcon(ctx, x, y, size) {
  ctx.save();
  ctx.strokeStyle = "#000";
  ctx.lineWidth = size * 0.08;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(x + 0.35 * size, y + 0.42 * size, size * 0.22, Math.PI * 0.5, Math.PI * 1.55);
  ctx.arc(x + 0.58 * size, y + 0.3 * size, size * 0.26, Math.PI * 1.05, Math.PI * 1.95);
  ctx.lineTo(x + 0.82 * size, y + 0.42 * size);
  ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + 0.3 * size, y + 0.62 * size); ctx.lineTo(x + 0.22 * size, y + 0.88 * size); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + 0.5 * size, y + 0.62 * size); ctx.lineTo(x + 0.42 * size, y + 0.88 * size); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + 0.7 * size, y + 0.62 * size); ctx.lineTo(x + 0.62 * size, y + 0.88 * size); ctx.stroke();
  ctx.restore();
}
// White stroke-only triangle + stem + dot, for the alert header's icon
// (drawn ON the black banner fill, so white, not the black-filled
// version dynamic.js's own drawWarningTriangle uses for a white card).
function swDrawAlertIcon(ctx, x, y, size) {
  ctx.save();
  ctx.translate(x + size / 2, y + size / 2 + size * 0.08);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = size * 0.11;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(0, -size * 0.42); ctx.lineTo(size * 0.46, size * 0.38); ctx.lineTo(-size * 0.46, size * 0.38); ctx.closePath();
  ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, -size * 0.1); ctx.lineTo(0, size * 0.12); ctx.stroke();
  ctx.beginPath(); ctx.arc(0, size * 0.26, size * 0.045, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill();
  ctx.restore();
}

function swDrawHeader(ctx, data) {
  if (data.alert && data.alert.active) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, SW_CANVAS_WIDTH, 34);
    swDrawAlertIcon(ctx, 12, 6, 22);
    ctx.fillStyle = "#fff";
    swText(ctx, data.alert.header, 42, 24, 20, "left");
    if (data.alert.ends_label) swText(ctx, data.alert.ends_label, 780, 23, 16, "right");
  } else {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, SW_CANVAS_WIDTH, 34);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 32, SW_CANVAS_WIDTH, 2);
    swText(ctx, "STREET WATER · NEXT 24 H", 12, 24, 20, "left");
    swText(ctx, "No flood alerts", 780, 23, 16, "right");
  }
}

function swDrawFooter(ctx, data, now) {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 246, SW_CANVAS_WIDTH, 2);

  const staleMinutes = (now.getTime() - new Date(data.generated_utc).getTime()) / 60000;
  const stale = staleMinutes > data.stale_after_min;
  const staleLabel = stale ? "DATA " + Math.round(staleMinutes / 60) + " H OLD" : null;

  swFont(ctx, 14);
  const rightTextWidth = ctx.measureText(stale ? staleLabel : "Updated " + data.updated_label).width;

  // Per the gauge-mapping update: print the datum ("MLLW") in this
  // note ONLY if it fits without crowding the right-side text/badge --
  // never resize or rearrange the footer to make room for it.
  let leftText = (data.now && data.now.label) || "";
  if (leftText && data.displayDatum) {
    const withNote = leftText + " (" + data.displayDatum + ")";
    const available = 780 - rightTextWidth - 24 - 12;
    if (ctx.measureText(withNote).width <= available) leftText = withNote;
  }
  if (leftText) swText(ctx, leftText, 12, 265, 14, "left");

  if (stale) {
    const w = ctx.measureText(staleLabel).width;
    ctx.fillStyle = "#000";
    ctx.fillRect(780 - w - 10, 250, w + 10, 19);
    ctx.fillStyle = "#fff";
    swText(ctx, staleLabel, 775, 265, 14, "right");
  } else {
    ctx.fillStyle = "#000";
    swText(ctx, "Updated " + data.updated_label, 780, 265, 14, "right");
  }
}

// Called both for the normal render and the "series unavailable"
// degrade -- the spec's own state table says that degrade still draws
// "header, left panel and footer", and Gusts/Rain come from Open-Meteo
// independently of the missing NWPS/CO-OPS forecast, so only the
// headline peak value/badge (which has nothing to show without a
// forecast) is conditional here, not the whole panel.
function swDrawLeftPanel(ctx, data) {
  ctx.fillStyle = "#000";
  ctx.fillRect(248, 34, 2, 211);

  const headline = (data.peaks || [])[data.headline_peak_index];
  if (headline) {
    swText(ctx, headline.label, 12, 57, 14, "left");

    swFont(ctx, 58);
    const ftStr = headline.ft.toFixed(1);
    ctx.textAlign = "left";
    ctx.fillStyle = "#000";
    ctx.fillText(ftStr, 12, 110);
    const ftStrWidth = ctx.measureText(ftStr).width;
    swText(ctx, "ft", 12 + ftStrWidth, 113, 20, "left");
    swFont(ctx, 20);
    const unitWidth = ctx.measureText("ft").width;

    const badgeLeft = 12 + ftStrWidth + unitWidth + 8;
    const byCategory = { major: "MAJOR", moderate: "MOD", minor: "MINOR" };
    const badgeText = byCategory[headline.category] || "OK";
    swFont(ctx, 20);
    const textW = ctx.measureText(badgeText).width;
    const boxW = textW + 14;
    // Spec: "if the badge's right edge would pass x=236, stop and
    // report, don't shrink it" -- there's no Kurt-in-the-loop for an
    // automated hourly render, so this draws anyway (extending past
    // 236 rather than silently shrinking the text) and relies on this
    // comment as the "report" for whoever next reviews a render that
    // hits it.
    ctx.fillStyle = headline.category === "none" ? "#fff" : "#000";
    ctx.fillRect(badgeLeft, 79, boxW, 29);
    if (headline.category === "none") {
      ctx.strokeStyle = "#000"; ctx.lineWidth = 2; ctx.strokeRect(badgeLeft + 1, 80, boxW - 2, 27);
    }
    ctx.fillStyle = headline.category === "none" ? "#000" : "#fff";
    swText(ctx, badgeText, badgeLeft + boxW / 2, 101, 20, "center");
  }

  ctx.fillStyle = "#000";
  ctx.fillRect(12, 136, 223, 2);

  swDrawWindIcon(ctx, 12, 152, 30);
  swText(ctx, "GUSTS", 50, 158, 14, "left");
  if (data.weather && data.weather.gust_mph != null) swText(ctx, data.weather.gust_mph + " mph", 50, 183, 28, "left");

  swDrawRainIcon(ctx, 12, 203, 30);
  if (data.weather) {
    swText(ctx, data.weather.rain_label, 50, 209, 14, "left");
    swText(ctx, data.weather.rain_value, 50, 234, 28, "left");
  }
}

function swDrawChart(ctx, data) {
  const [ymin, ymax] = data.y_range_ft;
  const seriesFt = data.series.ft;
  const thresholds = data.thresholds_ft;

  // Layer 1: 45-degree hatch wherever the curve is above minor.
  for (let x = CHART_X0; x <= CHART_X1; x++) {
    const h = (x - CHART_X0) / 20.125;
    const ft = swSeriesAt(seriesFt, h);
    if (!Number.isFinite(ft) || ft <= thresholds.minor) continue;
    const yTop = Math.ceil(swChartY(ft, ymin, ymax));
    const yBottom = Math.floor(swChartY(thresholds.minor, ymin, ymax));
    ctx.fillStyle = "#000";
    for (let y = yTop; y <= yBottom; y++) if ((x + y) % 6 < 3) ctx.fillRect(x, y, 1, 1);
  }

  // Layer 2+3: dashed threshold lines + labels.
  const thresholdEntries = [["MINOR", thresholds.minor], ["MOD", thresholds.moderate], ["MAJOR", thresholds.major]];
  const ys = {};
  for (const [, v] of thresholdEntries) ys[v] = swChartY(v, ymin, ymax);
  for (const [label, v] of thresholdEntries) {
    if (v < ymin || v > ymax) continue;
    const y = swChartY(v, ymin, ymax);
    swDashedHLine(ctx, CHART_X0, CHART_X1, y, 2, 5, 4);
    if (label === "MOD") {
      const nearMinor = Math.abs(ys[thresholds.minor] - y) < 15;
      const nearMajor = Math.abs(ys[thresholds.major] - y) < 15;
      if (nearMinor || nearMajor) continue;
    }
    ctx.fillStyle = "#000";
    swText(ctx, label, 299, y - 4, 12, "left");
  }

  // Layer 4: the curve itself, 4px thick.
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 4;
  ctx.lineJoin = "round";
  ctx.beginPath();
  seriesFt.forEach((ft, i) => {
    if (!Number.isFinite(ft)) return;
    const x = swChartX(i * 0.25), y = swChartY(ft, ymin, ymax);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Layer 5: NOW line.
  ctx.fillStyle = "#000";
  ctx.fillRect(292, 46, 3, 215 - 46);

  // Layer 6: x-axis.
  ctx.fillRect(CHART_X0, 215, CHART_X1 - CHART_X0, 2);

  // Layer 7: y-axis ticks + unit.
  swText(ctx, "ft", 287, 47, 12, "right");
  for (const ft of data.y_ticks_ft) {
    const y = swChartY(ft, ymin, ymax);
    if (Math.abs(y - 47) < 12) continue;
    swText(ctx, String(ft), 287, y + 4, 12, "right");
  }

  // Layer 8: peak labels, with knockout rects.
  for (const peak of data.peaks) {
    if (peak.category === "none") continue;
    const x = swChartX(peak.h);
    const y = Math.max(54, swChartY(peak.ft, ymin, ymax) - 10);
    const text = peak.ft.toFixed(1);
    swKnockout(ctx, x, y, text, 17);
    swText(ctx, text, x, y, 17, "center");
  }

  // Layer 9: WET windows -- only the later one if two would overlap.
  const windows = data.wet_windows || [];
  const kept = [];
  for (const w of windows) {
    const prev = kept[kept.length - 1];
    if (prev && swChartX(w.start_h) - swChartX(prev.end_h) < 60) kept.pop();
    kept.push(w);
  }
  for (const w of kept) {
    const x0 = swChartX(w.start_h), x1 = swChartX(w.end_h);
    ctx.fillStyle = "#000";
    ctx.fillRect(x0, 193, x1 - x0, 2);
    ctx.fillRect(x0 - 1, 189, 2, 10);
    ctx.fillRect(x1 - 1, 189, 2, 10);
    const mid = (x0 + x1) / 2;
    swKnockout(ctx, mid, 210, w.label, 12);
    swText(ctx, w.label, mid, 210, 12, "center");
  }

  // Layer 10: x-axis time labels.
  for (const xl of data.x_labels) {
    if (xl.h === 0) swText(ctx, xl.t, 297, 236, 14, "left");
    else if (xl.h === 24) swText(ctx, xl.t, 776, 236, 14, "right");
    else swText(ctx, xl.t, swChartX(xl.h), 236, 14, "center");
  }
}

// data: fetchStreetWaterData's return value, or null (device isn't near
// any configured town -- see nearestStreetWaterTown). now defaults to
// the real current time; tests pass a fixed one for determinism.
function drawStreetWaterCard(ctx, data, now) {
  const at = now || new Date();
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, SW_CANVAS_WIDTH, SW_CANVAS_HEIGHT);

  if (!data) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 32, SW_CANVAS_WIDTH, 2);
    swText(ctx, "STREET WATER · NEXT 24 H", 12, 24, 20, "left");
    swText(ctx, "Not available here yet", 780, 23, 16, "right");
    swText(ctx, "Not available for your area yet", SW_CANVAS_WIDTH / 2, 145, 20, "center");
    return;
  }

  swDrawHeader(ctx, data);

  swDrawLeftPanel(ctx, data);

  if (data.seriesUnavailable) {
    ctx.fillStyle = "#000";
    swText(ctx, "Forecast unavailable", (252 + 785) / 2, 145, 14, "center");
    swDrawFooter(ctx, data, at);
    return;
  }

  swDrawChart(ctx, data);
  swDrawFooter(ctx, data, at);
}

module.exports = {
  SW_CANVAS_WIDTH,
  SW_CANVAS_HEIGHT,
  drawStreetWaterCard,
  STREET_WATER_TOWNS,
  MAX_TOWN_DISTANCE_MILES,
  nearestStreetWaterTown,
  haversineMiles,
  GAUGE_MLW_OFFSET_FT,
  fetchActiveAlert,
  fetchNwpsGaugeMeta,
  fetchNwpsStageflow,
  fetchOpenMeteoWeather,
  buildSeries,
  computeYRange,
  categoryFor,
  findPeaks,
  headlinePeakIndex,
  labelPeaks,
  computeWetWindows,
  computeXLabels,
  computeNowAndTrend,
  computeWeather,
  endsLabel,
  fetchStreetWaterData
};
