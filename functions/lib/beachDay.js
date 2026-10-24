"use strict";

// Beach Day: a 792x272, 1-bit, built-once-each-morning picture of what
// the beach will be like today -- NOT a live/current-conditions card.
// Every field below is pinned to a fixed reference hour (1 PM local) or
// a fixed window (11:00-17:00 local), on purpose: this screen is meant
// to be read once in the morning and trusted all day, so it must never
// drift as the day goes on the way a "right now" card would. See
// BEACH_DAY_SPEC.md (the handoff doc this was ported from) for the full
// rules this file implements; the reference Python renderer in that
// same handoff only draws -- all of this file's logic has no equivalent
// there.
//
// NOT live-tested against any of its three data sources from this
// development sandbox -- outbound network here is allowlisted, and
// api.open-meteo.com, marine-api.open-meteo.com, api.tidesandcurrents.
// noaa.gov, and tgftp.nws.noaa.gov are all unreachable from it (same
// documented sandbox-proxy limitation astro.js's own fetchNoaaPredictions
// was built under -- see that file's top-of-file comment). Every fetch
// here takes an injectable fetchImpl for exactly that reason; tests
// supply canned JSON/text shaped like each API's real documented
// response instead of hitting the network.
//
// Two deliberately conservative choices beyond the spec's literal text,
// both erring toward "--" rather than fabricating a number from missing
// data (the spec's own stated principle throughout):
// - wave_quality is "--" (not a guessed CHOPPY) when wave_period itself
//   is null -- the spec's classification formula has no defined behavior
//   for a missing period, and guessing the worst case isn't better than
//   admitting it's unknown.
// - the NOAA tide fetch failing outright (not just "no station data")
//   degrades to an empty tide line rather than failing the whole screen,
//   same "a secondary data source going down doesn't take the primary
//   card with it" principle fetchBeachFlagCardData already uses for its
//   own tide fetch in beachflag.js. Weather and marine, by contrast, ARE
//   load-bearing (nearly every field on this screen derives from one of
//   them) and are left to throw on a genuine fetch failure, so a bad run
//   gets retried rather than publishing a mostly-blank screen.

const tzlookup = require("tz-lookup");
const { OUTBOUND_FETCH_HEADERS } = require("./http");
const { localMidnight, fetchNoaaPredictions } = require("./astro");

const OPEN_METEO_WEATHER_BASE = "https://api.open-meteo.com/v1/forecast";
const OPEN_METEO_MARINE_BASE = "https://marine-api.open-meteo.com/v1/marine";
const SRF_BULLETIN_BASE = "https://tgftp.nws.noaa.gov/data/raw/fz/";

// ---------------------------------------------------------------------
// Local date/time helpers (Open-Meteo's timezone=auto already returns
// LOCAL hour strings like "2026-10-24T13:00" directly, so the only thing
// needed here is today's own local YYYY-MM-DD to build the exact string
// to look for -- never array position, per the spec's own warning).
// ---------------------------------------------------------------------

function localDateString(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return get("year") + "-" + get("month") + "-" + get("day");
}

function localHourMinute(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { hour: get("hour") % 24, minute: get("minute") }; // some ICU versions format midnight as "24:00"
}

// "12:42P" / "9:05A" -- no leading zero, no space, single-letter meridiem.
function formatTideTime(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hour: "numeric", minute: "2-digit", hour12: true
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return get("hour") + ":" + get("minute") + (get("dayPeriod") === "AM" ? "A" : "P");
}

// h % 12 (0 -> 12) + "am"/"pm" -- 14 -> "2pm", 12 -> "12pm", 11 -> "11am".
function hour12(h) {
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return h12 + (h < 12 ? "am" : "pm");
}

// ---------------------------------------------------------------------
// 4.1 Sky classification
// ---------------------------------------------------------------------

function classifySky(code, isDay) {
  if (code === 0 || code === 1) return isDay ? "Sunny" : "Clear";
  if (code === 2) return isDay ? "Partly Cloudy" : "Cloudy";
  if (code === 3 || code === 45 || code === 48) return "Cloudy";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "Snowy";
  if (code === 95 || code === 96 || code === 99) return "Thunderstorm";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 99)) return "Rainy";
  return "Cloudy";
}

const SKY_ICON_BY_WORD = {
  Sunny: "skyIconLarge_sunny",
  Clear: "skyIconLarge_clear",
  "Partly Cloudy": "skyIconLarge_partly_cloudy",
  Cloudy: "skyIconLarge_cloudy",
  Rainy: "skyIconLarge_rainy",
  Snowy: "skyIconLarge_snowy",
  Thunderstorm: "skyIconLarge_thunderstorm"
};

// ---------------------------------------------------------------------
// 4.2 Rain note (hours 11-17)
// ---------------------------------------------------------------------

// `hoursWindow` is {11: {precipitationIn, weatherCode}, ..., 17: {...}},
// each possibly missing a value (null) if that hour's own fetch lookup
// came up empty -- a missing hour simply never counts as a rain hour,
// same as a present-but-zero one.
function computeRainNote(hoursWindow) {
  const isRainHour = (h) => {
    const e = hoursWindow[h];
    if (!e) return false;
    const precipRain = e.precipitationIn != null && e.precipitationIn > 0.01;
    const codeRain = e.weatherCode != null && (() => {
      const word = classifySky(e.weatherCode, true);
      return word === "Rainy" || word === "Thunderstorm";
    })();
    return precipRain || codeRain;
  };

  let first = null;
  for (let h = 11; h <= 17; h++) {
    if (isRainHour(h)) { first = h; break; }
  }
  if (first == null) return null;

  // Continuous block starting at `first` only -- a later, separate rain
  // block is deliberately ignored per the spec.
  let last = first;
  for (let h = first + 1; h <= 17; h++) {
    if (isRainHour(h)) last = h; else break;
  }

  if (first === 11 && last === 17) return "Rain all day";
  if (first === 11) return "Rain ends " + hour12(last + 1);
  if (last === 17) return "Rain starts " + hour12(first);
  return "Rain " + hour12(first) + "-" + hour12(last + 1);
}

// ---------------------------------------------------------------------
// 4.3 Wave quality, fly risk, and the shared compass/offshore math
// ---------------------------------------------------------------------

const COMPASS8 = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const COMPASS8_DEG = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };

function degreesTo8Compass(deg) {
  if (deg == null) return null;
  const idx = Math.floor(((((deg % 360) + 360) % 360) + 22.5) / 45) % 8;
  return COMPASS8[idx];
}

// Returns a number in [0, 180], or the string "unknown" when either
// input is missing/unrecognized -- callers (waveQuality, flyRisk) both
// treat "unknown" as "skip this adjustment" rather than guessing 0.
function offshoreAngleDiff(windDirDeg, coastFacing) {
  if (windDirDeg == null || !coastFacing || !(coastFacing in COMPASS8_DEG)) return "unknown";
  const coastDeg = COMPASS8_DEG[coastFacing];
  const offshore = (coastDeg + 180) % 360;
  let diff = Math.abs(windDirDeg - offshore);
  if (diff > 180) diff = 360 - diff;
  return diff;
}

// null (not a guess) when wavePeriodS itself is missing -- see the
// top-of-file note on why this is more conservative than the spec's
// literal formula, which has no defined behavior for that case.
function waveQuality(wavePeriodS, diff) {
  if (wavePeriodS == null) return null;
  let quality = wavePeriodS >= 9 ? "CLEAN" : wavePeriodS >= 6 ? "FAIR" : "CHOPPY";
  if (diff !== "unknown" && diff != null) {
    if (diff <= 45) {
      quality = quality === "CHOPPY" ? "FAIR" : "CLEAN";
    } else if (diff >= 135) {
      quality = quality === "CLEAN" ? "FAIR" : "CHOPPY";
    }
  }
  return quality.charAt(0) + quality.slice(1).toLowerCase();
}

// Greenhead flies on NJ/DE marsh-backed beaches -- see BEACH_DAY_SPEC.md
// section 4.3 for the full rationale. `hour` and `month` are always the
// screen's own fixed reference point (13, and the LOCAL calendar month),
// never "right now" -- the spec only parameterizes them because the
// underlying device formula technically takes any hour/month, not
// because this screen ever varies them.
function flyRisk({ month, hour, windDirDiff, windSpeedMph, airTempF, humidityPct }) {
  if (month < 6 || month > 9) return "LOW";
  if (hour < 9 || hour > 18) return "LOW";

  let points = 0;
  if (windDirDiff !== "unknown" && windDirDiff != null) {
    if (windDirDiff <= 22) points += 5;
    else if (windDirDiff <= 67) points += 4;
    else if (windDirDiff >= 113) points -= 2;
  }
  if (windSpeedMph != null) {
    if (windSpeedMph < 5) points += 1;
    else if (windSpeedMph > 15) points -= 1;
  }
  if (airTempF != null) {
    if (airTempF >= 80) points += 1;
    else if (airTempF < 70) points -= 1;
  }
  if (humidityPct != null) {
    if (humidityPct >= 70) points += 1;
    else if (humidityPct < 50) points -= 1;
  }

  if (points >= 6) return "HIGH";
  if (points >= 2) return "MID";
  return "LOW";
}

// ---------------------------------------------------------------------
// 4.5 Rip current risk from the NWS Surf Zone Forecast bulletin
// ---------------------------------------------------------------------

function mapRipRiskWord(word) {
  const w = (word || "").toLowerCase();
  if (w === "low") return "LOW";
  if (w === "moderate") return "MID";
  if (w === "high") return "HIGH";
  return null;
}

// Different NWS offices format the "RIP CURRENT RISK" line differently
// -- sometimes the risk word leads a headline ("...MODERATE RIP CURRENT
// RISK IN EFFECT..."), sometimes it trails a dotted label line ("Rip
// Current Risk*...........Low"). This checks the word immediately
// BEFORE the phrase first, and only falls back to AFTER when the before
// word isn't a recognized risk word, per the spec.
function parseRipRisk(bulletinText, srfZone) {
  // Case-insensitive: location/index.html actually saves the literal
  // lowercase "none" when a customer explicitly skips the forecast zone
  // step (see effectiveSrfZone there) -- this accepts that real value as
  // well as the uppercase "NONE" this module's own tests/callers use.
  if (!bulletinText || !srfZone || String(srfZone).toUpperCase() === "NONE") return "--";

  const zoneIdx = bulletinText.indexOf(srfZone);
  if (zoneIdx === -1) return "--";

  const relEnd = bulletinText.slice(zoneIdx).indexOf("$$");
  const sectionEnd = relEnd === -1 ? bulletinText.length : zoneIdx + relEnd;
  const section = bulletinText.slice(zoneIdx, sectionEnd);

  const phrase = /RIP CURRENT RISK/i.exec(section);
  if (!phrase) return "--";
  const phraseStart = phrase.index;
  const phraseEnd = phraseStart + phrase[0].length;

  let i = phraseStart - 1;
  while (i >= 0 && (section[i] === " " || section[i] === ".")) i--;
  let j = i;
  while (j >= 0 && /[A-Za-z]/.test(section[j])) j--;
  const before = mapRipRiskWord(section.slice(j + 1, i + 1));
  if (before) return before;

  let k = phraseEnd;
  while (k < section.length && (section[k] === " " || section[k] === "." || section[k] === "*")) k++;
  let m = k;
  while (m < section.length && /[A-Za-z]/.test(section[m])) m++;
  return mapRipRiskWord(section.slice(k, m)) || "--";
}

// ---------------------------------------------------------------------
// 4.6 Tide line
// ---------------------------------------------------------------------

// `events` is fetchNoaaPredictions's own shape: [{t: Date, heightFt,
// isHigh}]. Returns {} (no tide_label/tide_time/tide_then at all) when
// there are no events today -- the caller leaves the tide area of the
// screen empty in that case, same as the reference renderer's own
// `if d.get("tide_label")` guard.
function computeTideLine(events, timeZone) {
  if (!events || !events.length) return {};

  const withLocal = events
    .map((e) => {
      const { hour, minute } = localHourMinute(e.t, timeZone);
      return Object.assign({}, e, { minutesOfDay: hour * 60 + minute, inWindow: hour >= 11 && hour <= 17 });
    })
    .sort((a, b) => a.t.getTime() - b.t.getTime());

  const windowed = withLocal.filter((e) => e.inWindow);
  let big, second = null;
  if (windowed.length) {
    big = windowed[0];
    if (windowed.length > 1) second = windowed[1];
  } else {
    const target = 14 * 60;
    big = withLocal.reduce((best, e) =>
      (Math.abs(e.minutesOfDay - target) < Math.abs(best.minutesOfDay - target) ? e : best), withLocal[0]);
  }

  const result = {
    tide_label: big.isHigh ? "High Tide" : "Low Tide",
    tide_time: formatTideTime(big.t, timeZone)
  };
  if (second) {
    result.tide_then = "then " + (second.isHigh ? "High" : "Low") + " " + formatTideTime(second.t, timeZone);
  }
  return result;
}

// ---------------------------------------------------------------------
// Data fetches
// ---------------------------------------------------------------------

// The single combined request BEACH_DAY_SPEC.md section 2.1 asks for
// (the device itself uses two smaller requests with the same
// parameters) -- flagged there as untested; kept as one call here since
// it's simpler, but if a real deploy ever shows this combined form
// behaving differently from the two-request form, split it back out.
async function fetchBeachDayWeather(lat, lon, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: "temperature_2m,wind_speed_10m,wind_direction_10m,precipitation,relative_humidity_2m,weather_code",
    daily: "temperature_2m_max,temperature_2m_min,uv_index_max",
    precipitation_unit: "inch",
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    timezone: "auto",
    forecast_days: "1"
  });
  const resp = await doFetch(OPEN_METEO_WEATHER_BASE + "?" + params.toString(), { headers: OUTBOUND_FETCH_HEADERS });
  const data = await resp.json();
  if (data && data.error) throw new Error(data.reason || "Open-Meteo weather returned an error");
  return data;
}

async function fetchBeachDayMarine(lat, lon, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: "wave_height,wave_period,wave_direction,sea_surface_temperature",
    length_unit: "imperial",
    temperature_unit: "fahrenheit",
    timezone: "auto",
    forecast_days: "1"
  });
  const resp = await doFetch(OPEN_METEO_MARINE_BASE + "?" + params.toString(), { headers: OUTBOUND_FETCH_HEADERS });
  const data = await resp.json();
  if (data && data.error) throw new Error(data.reason || "Open-Meteo marine returned an error");
  return data;
}

// e.g. srfProductPrefix="fzus51", srfOffice="kphi" -> ".../fz/fzus51.kphi.srf.phi.txt"
// (the 4th path segment is the office id with its leading letter dropped).
async function fetchRipRiskBulletin(srfOffice, srfProductPrefix, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const url = SRF_BULLETIN_BASE + srfProductPrefix + "." + srfOffice + ".srf." + srfOffice.slice(1) + ".txt";
  const resp = await doFetch(url, { headers: OUTBOUND_FETCH_HEADERS });
  if (!resp.ok) throw new Error("Surf zone bulletin fetch failed: " + resp.status);
  return await resp.text();
}

function hourlyValue(hourly, field, idx) {
  if (idx < 0 || !hourly || !hourly[field]) return null;
  const v = hourly[field][idx];
  return v == null ? null : v;
}

// ---------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------

// Returns everything BEACH_DAY_SPEC.md section 3's table computes --
// every field EXCEPT town/weekday/subtitle, which the caller already
// has (the device's own saved town nickname, today's weekday, and the
// fixed "1 PM conditions" note) and merges in itself, same division of
// labor fetchBeachFlagCardData already uses for townName in
// beachflag.js.
async function fetchBeachDayData({ lat, lon, stationId, srfZone, srfOffice, srfProductPrefix, coastFacingDirection }, now, fetchImpl) {
  const at = now || new Date();
  const timeZone = tzlookup(lat, lon);
  const todayStr = localDateString(at, timeZone);
  const dayStart = localMidnight(at, timeZone);
  const dayEnd = new Date(dayStart.getTime() + 24 * 3600000);

  const [weather, marine, tideEvents, ripText] = await Promise.all([
    fetchBeachDayWeather(lat, lon, fetchImpl),
    fetchBeachDayMarine(lat, lon, fetchImpl),
    fetchNoaaPredictions(stationId, dayStart, dayEnd, "hilo", timeZone, fetchImpl).catch(() => []),
    (srfZone && String(srfZone).toUpperCase() !== "NONE" && srfOffice && srfProductPrefix)
      ? fetchRipRiskBulletin(srfOffice, srfProductPrefix, fetchImpl).catch(() => null)
      : Promise.resolve(null)
  ]);

  const hourly = weather.hourly || {};
  const hourlyTimes = hourly.time || [];
  const hourKey = (h) => todayStr + "T" + String(h).padStart(2, "0") + ":00";
  const idx13 = hourlyTimes.indexOf(hourKey(13));

  const tempF = hourlyValue(hourly, "temperature_2m", idx13);
  const windMph13 = hourlyValue(hourly, "wind_speed_10m", idx13);
  const windDirDeg13 = hourlyValue(hourly, "wind_direction_10m", idx13);
  const humidityPct = hourlyValue(hourly, "relative_humidity_2m", idx13);
  const weatherCode = hourlyValue(hourly, "weather_code", idx13);

  const daily = weather.daily || {};
  const tempMax = daily.temperature_2m_max ? daily.temperature_2m_max[0] : null;
  const tempMin = daily.temperature_2m_min ? daily.temperature_2m_min[0] : null;
  const uvMax = daily.uv_index_max ? daily.uv_index_max[0] : null;

  const hoursWindow = {};
  const windSpeedsWindow = [];
  for (let h = 11; h <= 17; h++) {
    const idx = hourlyTimes.indexOf(hourKey(h));
    hoursWindow[h] = {
      precipitationIn: hourlyValue(hourly, "precipitation", idx),
      weatherCode: hourlyValue(hourly, "weather_code", idx)
    };
    const wv = hourlyValue(hourly, "wind_speed_10m", idx);
    if (wv != null) windSpeedsWindow.push(wv);
  }

  const marineHourly = marine.hourly || {};
  const marineTimes = marineHourly.time || [];
  const marineIdx13 = marineTimes.indexOf(hourKey(13));
  const waveHeightFt = hourlyValue(marineHourly, "wave_height", marineIdx13);
  const wavePeriodS = hourlyValue(marineHourly, "wave_period", marineIdx13);
  const waterTempF = hourlyValue(marineHourly, "sea_surface_temperature", marineIdx13);

  const skyCondition = weatherCode != null ? classifySky(Math.round(weatherCode), true) : "Cloudy";
  const rainNote = computeRainNote(hoursWindow);

  const windDirCompass = degreesTo8Compass(windDirDeg13);
  const diff = offshoreAngleDiff(windDirDeg13, coastFacingDirection);
  const quality = waveQuality(wavePeriodS, diff);
  const ripRisk = ripText ? parseRipRisk(ripText, srfZone) : "--";

  const localMonth = Number(new Intl.DateTimeFormat("en-US", { timeZone, month: "numeric" }).format(at));
  const fly = flyRisk({
    month: localMonth, hour: 13,
    windDirDiff: diff, windSpeedMph: windMph13, airTempF: tempF, humidityPct
  });

  const windMin = windSpeedsWindow.length ? Math.round(Math.min(...windSpeedsWindow)) : null;
  const windMax = windSpeedsWindow.length ? Math.round(Math.max(...windSpeedsWindow)) : null;

  const result = {
    sky_condition: skyCondition,
    rip_risk: ripRisk,
    wave: waveHeightFt != null ? Math.round(waveHeightFt) + "ft" : "--",
    wave_quality: quality || "--",
    water: waterTempF != null ? String(Math.round(waterTempF)) : "--",
    wind: (windMin != null && windMax != null) ? (windMin === windMax ? String(windMin) : windMin + "-" + windMax) : "--",
    wind_dir: windDirCompass,
    air: tempF != null ? String(Math.round(tempF)) : "--",
    air_high: tempMax != null ? Math.round(tempMax) : null,
    air_low: tempMin != null ? Math.round(tempMin) : null,
    uv: uvMax != null ? String(Math.round(uvMax)) : "--",
    humidity: humidityPct != null ? Math.round(humidityPct) + "%" : "--",
    fly_risk: fly
  };
  if (rainNote) result.rain_note = rainNote;
  Object.assign(result, computeTideLine(tideEvents, timeZone));
  return result;
}

module.exports = {
  localDateString,
  localHourMinute,
  formatTideTime,
  hour12,
  classifySky,
  SKY_ICON_BY_WORD,
  computeRainNote,
  COMPASS8,
  COMPASS8_DEG,
  degreesTo8Compass,
  offshoreAngleDiff,
  waveQuality,
  flyRisk,
  parseRipRisk,
  computeTideLine,
  fetchBeachDayWeather,
  fetchBeachDayMarine,
  fetchRipRiskBulletin,
  fetchBeachDayData
};
