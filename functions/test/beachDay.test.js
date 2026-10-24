"use strict";

// Exercises lib/beachDay.js directly with a stubbed fetch (no live
// Open-Meteo/NOAA/NWS call) -- see the header comment in lib/beachDay.js
// for why none of its three data sources could be live-verified from
// this development sandbox.

const assert = require("assert");
const {
  localDateString,
  localHourMinute,
  formatTideTime,
  hour12,
  classifySky,
  computeRainNote,
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
} = require("../lib/beachDay");

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

const TZ = "America/New_York";
const TODAY = "2026-10-24";
// 2026-10-24 18:00Z is 14:00 local (EDT, UTC-4) -- comfortably inside
// TODAY in America/New_York regardless of which hour a given test cares
// about, so every fixture below can just use TODAY without worrying
// about a local-date rollover.
const NOW = new Date("2026-10-24T18:00:00Z");

function hourlyTimes() {
  const times = [];
  for (let h = 0; h < 24; h++) times.push(TODAY + "T" + String(h).padStart(2, "0") + ":00");
  return times;
}

// `overrides` maps hour (0-23) -> value; every other hour is null.
function hourlySeries(overrides) {
  const arr = new Array(24).fill(null);
  for (const [h, v] of Object.entries(overrides || {})) arr[Number(h)] = v;
  return arr;
}

function weatherFixture({ temp, windSpeed, windDir, precip, humidity, code, tempMax, tempMin, uvMax } = {}) {
  return {
    hourly: {
      time: hourlyTimes(),
      temperature_2m: hourlySeries(temp),
      wind_speed_10m: hourlySeries(windSpeed),
      wind_direction_10m: hourlySeries(windDir),
      precipitation: hourlySeries(precip),
      relative_humidity_2m: hourlySeries(humidity),
      weather_code: hourlySeries(code)
    },
    daily: {
      temperature_2m_max: [tempMax != null ? tempMax : null],
      temperature_2m_min: [tempMin != null ? tempMin : null],
      uv_index_max: [uvMax != null ? uvMax : null]
    }
  };
}

function marineFixture({ waveHeight, wavePeriod, waterTemp } = {}) {
  return {
    hourly: {
      time: hourlyTimes(),
      wave_height: hourlySeries(waveHeight),
      wave_period: hourlySeries(wavePeriod),
      wave_direction: hourlySeries({}),
      sea_surface_temperature: hourlySeries(waterTemp)
    }
  };
}

function jsonResp(body) {
  return { ok: true, json: async () => body };
}
function textResp(body) {
  return { ok: true, text: async () => body };
}

// Branches a single fetchImpl by host, for the end-to-end
// fetchBeachDayData tests, which call all four sources through one
// shared fetchImpl just like the real code does.
function dispatchFetch({ weather, marine, noaaPredictions, ripBulletin, onCall } = {}) {
  return async (url, opts) => {
    if (onCall) onCall(url, opts);
    const u = new URL(url);
    if (u.hostname === "api.open-meteo.com") return jsonResp(weather);
    if (u.hostname === "marine-api.open-meteo.com") return jsonResp(marine);
    if (u.hostname === "api.tidesandcurrents.noaa.gov") return jsonResp({ predictions: noaaPredictions || [] });
    if (u.hostname === "tgftp.nws.noaa.gov") {
      if (ripBulletin instanceof Error) throw ripBulletin;
      return textResp(ripBulletin == null ? "" : ripBulletin);
    }
    throw new Error("unexpected URL in test: " + url);
  };
}

(async () => {
  console.log("localDateString / localHourMinute / formatTideTime / hour12");
  await test("localDateString reads the date in the given IANA zone, not UTC", async () => {
    // 2026-10-24T02:00Z is still 2026-10-23 22:00 in America/New_York.
    assert.strictEqual(localDateString(new Date("2026-10-24T02:00:00Z"), TZ), "2026-10-23");
  });
  await test("localHourMinute extracts 24h hour/minute in the given zone", async () => {
    assert.deepStrictEqual(localHourMinute(new Date("2026-10-24T17:05:00Z"), TZ), { hour: 13, minute: 5 });
  });
  await test("formatTideTime: no leading zero, no space, single-letter meridiem", async () => {
    assert.strictEqual(formatTideTime(new Date("2026-10-24T16:42:00Z"), TZ), "12:42P"); // noon-ish EDT
    assert.strictEqual(formatTideTime(new Date("2026-10-24T13:05:00Z"), TZ), "9:05A");
  });
  await test("hour12 formats 24h hours into the spec's compact am/pm form", async () => {
    assert.strictEqual(hour12(14), "2pm");
    assert.strictEqual(hour12(12), "12pm");
    assert.strictEqual(hour12(11), "11am");
    assert.strictEqual(hour12(0), "12am");
  });

  console.log("classifySky (4.1)");
  await test("code 0/1 -> Sunny by day, Clear by night", async () => {
    assert.strictEqual(classifySky(0, true), "Sunny");
    assert.strictEqual(classifySky(1, true), "Sunny");
    assert.strictEqual(classifySky(1, false), "Clear");
  });
  await test("code 2 -> Partly Cloudy by day, Cloudy by night", async () => {
    assert.strictEqual(classifySky(2, true), "Partly Cloudy");
    assert.strictEqual(classifySky(2, false), "Cloudy");
  });
  await test("code 3/45/48 -> Cloudy", async () => {
    assert.strictEqual(classifySky(3, true), "Cloudy");
    assert.strictEqual(classifySky(45, true), "Cloudy");
    assert.strictEqual(classifySky(48, true), "Cloudy");
  });
  await test("code 71-77/85/86 -> Snowy", async () => {
    assert.strictEqual(classifySky(71, true), "Snowy");
    assert.strictEqual(classifySky(77, true), "Snowy");
    assert.strictEqual(classifySky(85, true), "Snowy");
    assert.strictEqual(classifySky(86, true), "Snowy");
  });
  await test("code 95/96/99 -> Thunderstorm, checked BEFORE the 80-99 Rainy catch-all", async () => {
    assert.strictEqual(classifySky(95, true), "Thunderstorm");
    assert.strictEqual(classifySky(96, true), "Thunderstorm");
    assert.strictEqual(classifySky(99, true), "Thunderstorm");
  });
  await test("code 51-67 or leftover 80-99 -> Rainy", async () => {
    assert.strictEqual(classifySky(61, true), "Rainy");
    assert.strictEqual(classifySky(80, true), "Rainy");
    assert.strictEqual(classifySky(82, true), "Rainy");
  });
  await test("an unrecognized code falls to the Cloudy catch-all", async () => {
    assert.strictEqual(classifySky(100, true), "Cloudy");
  });

  console.log("computeRainNote (4.2)");
  await test("no rain hours -> null (no note)", async () => {
    const hrs = {};
    for (let h = 11; h <= 17; h++) hrs[h] = { precipitationIn: 0, weatherCode: 1 };
    assert.strictEqual(computeRainNote(hrs), null);
  });
  await test("rain the whole window -> 'Rain all day'", async () => {
    const hrs = {};
    for (let h = 11; h <= 17; h++) hrs[h] = { precipitationIn: 0.05, weatherCode: null };
    assert.strictEqual(computeRainNote(hrs), "Rain all day");
  });
  await test("rain from the start, ending partway -> 'Rain ends Xpm'", async () => {
    const hrs = {};
    for (let h = 11; h <= 17; h++) hrs[h] = { precipitationIn: h <= 13 ? 0.05 : 0, weatherCode: null };
    assert.strictEqual(computeRainNote(hrs), "Rain ends 2pm");
  });
  await test("rain starting partway, continuing to the end -> 'Rain starts Xpm'", async () => {
    const hrs = {};
    for (let h = 11; h <= 17; h++) hrs[h] = { precipitationIn: h >= 15 ? 0.05 : 0, weatherCode: null };
    assert.strictEqual(computeRainNote(hrs), "Rain starts 3pm");
  });
  await test("rain in the middle only -> 'Rain X-Ypm'", async () => {
    const hrs = {};
    for (let h = 11; h <= 17; h++) hrs[h] = { precipitationIn: (h === 13 || h === 14) ? 0.05 : 0, weatherCode: null };
    assert.strictEqual(computeRainNote(hrs), "Rain 1pm-3pm");
  });
  await test("a later, separate rain block is ignored -- only the first block counts", async () => {
    const hrs = {};
    hrs[11] = { precipitationIn: 0.05, weatherCode: null };
    hrs[12] = { precipitationIn: 0, weatherCode: null };
    hrs[13] = { precipitationIn: 0, weatherCode: null };
    hrs[14] = { precipitationIn: 0, weatherCode: null };
    hrs[15] = { precipitationIn: 0.05, weatherCode: null }; // second block, deliberately ignored
    hrs[16] = { precipitationIn: 0, weatherCode: null };
    hrs[17] = { precipitationIn: 0, weatherCode: null };
    assert.strictEqual(computeRainNote(hrs), "Rain ends 12pm");
  });
  await test("a Rainy/Thunderstorm weather_code counts as rain even with zero measured precipitation", async () => {
    const hrs = {};
    for (let h = 11; h <= 17; h++) hrs[h] = { precipitationIn: 0, weatherCode: h === 12 ? 61 : 1 };
    assert.strictEqual(computeRainNote(hrs), "Rain 12pm-1pm");
  });
  await test("precipitation at or below the 0.01in threshold does not count as rain", async () => {
    const hrs = {};
    for (let h = 11; h <= 17; h++) hrs[h] = { precipitationIn: 0.01, weatherCode: 1 };
    assert.strictEqual(computeRainNote(hrs), null);
  });

  console.log("degreesTo8Compass / offshoreAngleDiff (4.3/4.4)");
  await test("degreesTo8Compass maps all 8 points, including the wrap at 360/0", async () => {
    assert.strictEqual(degreesTo8Compass(0), "N");
    assert.strictEqual(degreesTo8Compass(45), "NE");
    assert.strictEqual(degreesTo8Compass(90), "E");
    assert.strictEqual(degreesTo8Compass(135), "SE");
    assert.strictEqual(degreesTo8Compass(180), "S");
    assert.strictEqual(degreesTo8Compass(225), "SW");
    assert.strictEqual(degreesTo8Compass(270), "W");
    assert.strictEqual(degreesTo8Compass(315), "NW");
    assert.strictEqual(degreesTo8Compass(359), "N");
    assert.strictEqual(degreesTo8Compass(null), null);
  });
  await test("offshoreAngleDiff is 'unknown' when wind direction or coast direction is missing/unrecognized", async () => {
    assert.strictEqual(offshoreAngleDiff(null, "E"), "unknown");
    assert.strictEqual(offshoreAngleDiff(90, null), "unknown");
    assert.strictEqual(offshoreAngleDiff(90, "NONE"), "unknown");
  });
  await test("offshoreAngleDiff: wind blowing straight off an E-facing coast (due west wind) is 0", async () => {
    // offshore for E-facing coast = (90+180)%360 = 270 (wind FROM the west)
    assert.strictEqual(offshoreAngleDiff(270, "E"), 0);
  });
  await test("offshoreAngleDiff: wind blowing straight onto an E-facing coast (due east wind) is 180", async () => {
    assert.strictEqual(offshoreAngleDiff(90, "E"), 180);
  });
  await test("offshoreAngleDiff wraps correctly past 180 raw degrees", async () => {
    // coast SE -> offshore 315; |10-315| = 305 raw -> wraps to 360-305 = 55
    assert.strictEqual(offshoreAngleDiff(10, "SE"), 55);
  });

  console.log("waveQuality (4.3)");
  await test("baseline classification by period alone, no direction adjustment", async () => {
    assert.strictEqual(waveQuality(10, "unknown"), "Clean");
    assert.strictEqual(waveQuality(7, "unknown"), "Fair");
    assert.strictEqual(waveQuality(4, "unknown"), "Choppy");
  });
  await test("offshore wind (diff<=45) upgrades: Choppy->Fair, Fair/Clean->Clean", async () => {
    assert.strictEqual(waveQuality(4, 20), "Fair");
    assert.strictEqual(waveQuality(7, 20), "Clean");
    assert.strictEqual(waveQuality(10, 20), "Clean");
  });
  await test("onshore wind (diff>=135) downgrades: Clean->Fair, Fair/Choppy->Choppy", async () => {
    assert.strictEqual(waveQuality(10, 160), "Fair");
    assert.strictEqual(waveQuality(7, 160), "Choppy");
    assert.strictEqual(waveQuality(4, 160), "Choppy");
  });
  await test("cross-shore wind (45 < diff < 135) leaves the baseline unchanged", async () => {
    assert.strictEqual(waveQuality(7, 90), "Fair");
  });
  await test("a missing wave period is null, not a guessed Choppy", async () => {
    assert.strictEqual(waveQuality(null, "unknown"), null);
  });

  console.log("flyRisk (4.3)");
  await test("outside June-September -> LOW regardless of points", async () => {
    assert.strictEqual(flyRisk({ month: 5, hour: 13, windDirDiff: 10, windSpeedMph: 2, airTempF: 85, humidityPct: 80 }), "LOW");
    assert.strictEqual(flyRisk({ month: 10, hour: 13, windDirDiff: 10, windSpeedMph: 2, airTempF: 85, humidityPct: 80 }), "LOW");
  });
  await test("outside hour 9-18 -> LOW regardless of points", async () => {
    assert.strictEqual(flyRisk({ month: 7, hour: 20, windDirDiff: 10, windSpeedMph: 2, airTempF: 85, humidityPct: 80 }), "LOW");
  });
  await test("points >= 6 -> HIGH", async () => {
    // diff<=22 (+5), wind<5 (+1), temp>=80 (+1), humidity>=70 (+1) = 8
    assert.strictEqual(flyRisk({ month: 7, hour: 13, windDirDiff: 10, windSpeedMph: 3, airTempF: 85, humidityPct: 80 }), "HIGH");
  });
  await test("points >= 2 -> MID", async () => {
    // diff 23..67 (+4), everything else neutral = 4
    assert.strictEqual(flyRisk({ month: 7, hour: 13, windDirDiff: 40, windSpeedMph: 10, airTempF: 75, humidityPct: 60 }), "MID");
  });
  await test("points < 2 -> LOW", async () => {
    // diff>=113 (-2), wind>15 (-1), temp<70 (-1), humidity<50 (-1) = -5
    assert.strictEqual(flyRisk({ month: 7, hour: 13, windDirDiff: 150, windSpeedMph: 20, airTempF: 65, humidityPct: 30 }), "LOW");
  });
  await test("unknown wind direction diff contributes zero points, not a crash", async () => {
    assert.strictEqual(flyRisk({ month: 7, hour: 13, windDirDiff: "unknown", windSpeedMph: null, airTempF: null, humidityPct: null }), "LOW");
  });

  console.log("parseRipRisk (4.5)");
  const bulletinBefore =
    "NJZ024-241200-\n" +
    "Coastal NJ\n" +
    "...MODERATE RIP CURRENT RISK IN EFFECT THROUGH THIS EVENING...\n" +
    "Details here.\n$$\n" +
    "NJZ025-241200-\nOther zone text\n$$\n";
  const bulletinAfter =
    "NJZ025-241200-\n" +
    "Coastal NJ\n" +
    "Rip Current Risk*...........Low\n" +
    "$$\n";
  await test("word immediately BEFORE the phrase, as in a headline", async () => {
    assert.strictEqual(parseRipRisk(bulletinBefore, "NJZ024"), "MID");
  });
  await test("word AFTER the phrase (dots/asterisk), when the word before isn't recognized", async () => {
    assert.strictEqual(parseRipRisk(bulletinAfter, "NJZ025"), "LOW");
  });
  await test("High/Low map to HIGH/LOW", async () => {
    const b = "NJZ024-\n...HIGH RIP CURRENT RISK IN EFFECT...\n$$\n";
    assert.strictEqual(parseRipRisk(b, "NJZ024"), "HIGH");
    const b2 = "NJZ024-\nRip Current Risk*...........High\n$$\n";
    assert.strictEqual(parseRipRisk(b2, "NJZ024"), "HIGH");
  });
  await test("zone id not found in the bulletin -> '--'", async () => {
    assert.strictEqual(parseRipRisk(bulletinBefore, "FLZ050"), "--");
  });
  await test("zone found but no RIP CURRENT RISK phrase in its section -> '--'", async () => {
    const b = "NJZ024-\nNo mention of risk here.\n$$\n";
    assert.strictEqual(parseRipRisk(b, "NJZ024"), "--");
  });
  await test("a phrase belonging to a LATER zone's section is not matched against an earlier zone", async () => {
    // NJZ024's own section ends at the first $$, before the RISK phrase
    // that belongs to NJZ025's section.
    const b = "NJZ024-\nNothing here.\n$$\nNJZ025-\n...HIGH RIP CURRENT RISK IN EFFECT...\n$$\n";
    assert.strictEqual(parseRipRisk(b, "NJZ024"), "--");
    assert.strictEqual(parseRipRisk(b, "NJZ025"), "HIGH");
  });
  await test("an unrecognized word in both directions -> '--'", async () => {
    const b = "NJZ024-\n...SEVERE RIP CURRENT RISK SOMETHING...\n$$\n";
    assert.strictEqual(parseRipRisk(b, "NJZ024"), "--");
  });
  await test("srfZone 'NONE' or missing bulletin -> '--'", async () => {
    assert.strictEqual(parseRipRisk(bulletinBefore, "NONE"), "--");
    assert.strictEqual(parseRipRisk(null, "NJZ024"), "--");
  });

  console.log("computeTideLine (4.6)");
  await test("no events today -> empty (tide area left blank)", async () => {
    assert.deepStrictEqual(computeTideLine([], TZ), {});
  });
  await test("one event inside the window, no second -> big label/time only", async () => {
    const events = [{ t: new Date("2026-10-24T16:42:00Z"), isHigh: true }]; // 12:42 EDT
    assert.deepStrictEqual(computeTideLine(events, TZ), { tide_label: "High Tide", tide_time: "12:42P" });
  });
  await test("two events inside the window -> big + 'then' line", async () => {
    const events = [
      { t: new Date("2026-10-24T16:42:00Z"), isHigh: true },  // 12:42 EDT
      { t: new Date("2026-10-24T20:35:00Z"), isHigh: false }  // 16:35 EDT
    ];
    assert.deepStrictEqual(computeTideLine(events, TZ), {
      tide_label: "High Tide", tide_time: "12:42P", tide_then: "then Low 4:35P"
    });
  });
  await test("no events inside the window -> closest to 14:00, no 'then' line", async () => {
    const events = [
      { t: new Date("2026-10-24T13:00:00Z"), isHigh: true },  // 09:00 EDT -- outside window
      { t: new Date("2026-10-24T22:00:00Z"), isHigh: false }  // 18:00 EDT -- outside window, closer to 14:00
    ];
    const result = computeTideLine(events, TZ);
    assert.strictEqual(result.tide_label, "Low Tide");
    assert.strictEqual(result.tide_then, undefined);
  });

  console.log("fetchBeachDayWeather / fetchBeachDayMarine / fetchRipRiskBulletin");
  await test("fetchBeachDayWeather returns the parsed JSON body", async () => {
    const body = weatherFixture({ temp: { 13: 81 } });
    const data = await fetchBeachDayWeather(39.27, -74.57, async () => jsonResp(body));
    assert.strictEqual(data.hourly.temperature_2m[13], 81);
  });
  await test("fetchBeachDayWeather throws on an Open-Meteo-reported error", async () => {
    await assert.rejects(
      () => fetchBeachDayWeather(999, -74.57, async () => jsonResp({ error: true, reason: "Latitude must be in range of -90 to 90°" })),
      /Latitude must be in range/
    );
  });
  await test("fetchBeachDayMarine returns the parsed JSON body", async () => {
    const body = marineFixture({ waveHeight: { 13: 2.3 } });
    const data = await fetchBeachDayMarine(39.27, -74.57, async () => jsonResp(body));
    assert.strictEqual(data.hourly.wave_height[13], 2.3);
  });
  await test("fetchRipRiskBulletin builds the URL from srfProductPrefix/srfOffice, dropping the office's first letter", async () => {
    let capturedUrl = null;
    await fetchRipRiskBulletin("kphi", "fzus51", async (url) => { capturedUrl = url; return textResp("..."); });
    assert.strictEqual(capturedUrl, "https://tgftp.nws.noaa.gov/data/raw/fz/fzus51.kphi.srf.phi.txt");
  });
  await test("fetchRipRiskBulletin throws on a non-ok response", async () => {
    await assert.rejects(() => fetchRipRiskBulletin("kphi", "fzus51", async () => ({ ok: false, status: 404, text: async () => "" })), /404/);
  });

  console.log("fetchBeachDayData (end to end)");
  const happyWeather = weatherFixture({
    temp: { 13: 81 },
    windSpeed: { 11: 10, 12: 12, 13: 14, 14: 13, 15: 11, 16: 8, 17: 9 },
    windDir: { 13: 225 }, // SW
    precip: { 15: 0.05 },
    humidity: { 13: 62 },
    code: { 13: 2, 15: 61 }, // Partly Cloudy at 13:00; rainy at 15:00
    tempMax: 84, tempMin: 69, uvMax: 8
  });
  const happyMarine = marineFixture({ waveHeight: { 13: 2.3 }, wavePeriod: { 13: 7 }, waterTemp: { 13: 72.4 } });
  const happyTide = [
    { t: "2026-10-24 12:42", v: "4.21", type: "H" },
    { t: "2026-10-24 23:10", v: "4.50", type: "H" }
  ];
  const happyRip = "NJZ024-241200-\nCoastal NJ\n...MODERATE RIP CURRENT RISK IN EFFECT...\n$$\n";

  await test("happy path assembles every field per the spec's rules, with coastFacingDirection left unknown so wave_quality reflects the period alone", async () => {
    const fetchImpl = dispatchFetch({ weather: happyWeather, marine: happyMarine, noaaPredictions: happyTide, ripBulletin: happyRip });
    const data = await fetchBeachDayData({
      lat: 39.2776, lon: -74.5746, stationId: "8534720",
      srfZone: "NJZ024", srfOffice: "kphi", srfProductPrefix: "fzus51",
      coastFacingDirection: "NONE"
    }, NOW, fetchImpl);

    assert.strictEqual(data.sky_condition, "Partly Cloudy");
    assert.strictEqual(data.rain_note, "Rain 3pm-4pm"); // rain only at hour 15 in this fixture
    assert.strictEqual(data.rip_risk, "MID");
    assert.strictEqual(data.wave, "2ft");
    assert.strictEqual(data.wave_quality, "Fair");
    assert.strictEqual(data.water, "72");
    assert.strictEqual(data.wind, "8-14");
    assert.strictEqual(data.wind_dir, "SW");
    assert.strictEqual(data.air, "81");
    assert.strictEqual(data.air_high, 84);
    assert.strictEqual(data.air_low, 69);
    assert.strictEqual(data.uv, "8");
    assert.strictEqual(data.humidity, "62%");
    assert.strictEqual(data.fly_risk, "LOW"); // October -> outside the June-Sept season gate
    assert.strictEqual(data.tide_label, "High Tide");
    assert.strictEqual(data.tide_time, "12:42P");
    assert.strictEqual(data.tide_then, undefined); // only one event inside the 11-17 window
  });

  await test("a NOAA tide fetch failure degrades to no tide line, not a thrown error", async () => {
    const fetchImpl = async (url) => {
      const u = new URL(url);
      if (u.hostname === "api.tidesandcurrents.noaa.gov") throw new Error("network down");
      if (u.hostname === "api.open-meteo.com") return jsonResp(happyWeather);
      if (u.hostname === "marine-api.open-meteo.com") return jsonResp(happyMarine);
      if (u.hostname === "tgftp.nws.noaa.gov") return textResp(happyRip);
      throw new Error("unexpected URL: " + url);
    };
    const data = await fetchBeachDayData({
      lat: 39.2776, lon: -74.5746, stationId: "8534720",
      srfZone: "NJZ024", srfOffice: "kphi", srfProductPrefix: "fzus51", coastFacingDirection: "NONE"
    }, NOW, fetchImpl);
    assert.strictEqual(data.tide_label, undefined);
    assert.strictEqual(data.air, "81"); // the rest of the screen is unaffected
  });

  await test("a rip bulletin fetch failure degrades to '--', not a thrown error", async () => {
    const fetchImpl = dispatchFetch({ weather: happyWeather, marine: happyMarine, noaaPredictions: happyTide, ripBulletin: new Error("network down") });
    const data = await fetchBeachDayData({
      lat: 39.2776, lon: -74.5746, stationId: "8534720",
      srfZone: "NJZ024", srfOffice: "kphi", srfProductPrefix: "fzus51", coastFacingDirection: "NONE"
    }, NOW, fetchImpl);
    assert.strictEqual(data.rip_risk, "--");
  });

  await test("srfZone 'NONE' skips the bulletin fetch entirely", async () => {
    let ripFetchCalled = false;
    const fetchImpl = async (url) => {
      const u = new URL(url);
      if (u.hostname === "tgftp.nws.noaa.gov") { ripFetchCalled = true; return textResp(happyRip); }
      if (u.hostname === "api.open-meteo.com") return jsonResp(happyWeather);
      if (u.hostname === "marine-api.open-meteo.com") return jsonResp(happyMarine);
      if (u.hostname === "api.tidesandcurrents.noaa.gov") return jsonResp({ predictions: happyTide });
      throw new Error("unexpected URL: " + url);
    };
    const data = await fetchBeachDayData({
      lat: 39.2776, lon: -74.5746, stationId: "8534720",
      srfZone: "NONE", srfOffice: null, srfProductPrefix: null, coastFacingDirection: "NONE"
    }, NOW, fetchImpl);
    assert.strictEqual(ripFetchCalled, false);
    assert.strictEqual(data.rip_risk, "--");
  });

  await test("a weather fetch failure throws -- it is load-bearing, not a nice-to-have", async () => {
    const fetchImpl = dispatchFetch({ weather: { error: true, reason: "boom" }, marine: happyMarine, noaaPredictions: happyTide, ripBulletin: happyRip });
    await assert.rejects(() => fetchBeachDayData({
      lat: 39.2776, lon: -74.5746, stationId: "8534720",
      srfZone: "NJZ024", srfOffice: "kphi", srfProductPrefix: "fzus51", coastFacingDirection: "NONE"
    }, NOW, fetchImpl), /boom/);
  });

  await test("a marine fetch failure throws -- it is load-bearing, not a nice-to-have", async () => {
    const fetchImpl = dispatchFetch({ weather: happyWeather, marine: { error: true, reason: "boom" }, noaaPredictions: happyTide, ripBulletin: happyRip });
    await assert.rejects(() => fetchBeachDayData({
      lat: 39.2776, lon: -74.5746, stationId: "8534720",
      srfZone: "NJZ024", srfOffice: "kphi", srfProductPrefix: "fzus51", coastFacingDirection: "NONE"
    }, NOW, fetchImpl), /boom/);
  });

  await test("missing values throughout are reported as '--', never a substituted hour or zero", async () => {
    const blankWeather = weatherFixture({});
    const blankMarine = marineFixture({});
    const fetchImpl = dispatchFetch({ weather: blankWeather, marine: blankMarine, noaaPredictions: [], ripBulletin: "" });
    const data = await fetchBeachDayData({
      lat: 39.2776, lon: -74.5746, stationId: "8534720",
      srfZone: "NJZ024", srfOffice: "kphi", srfProductPrefix: "fzus51", coastFacingDirection: "NONE"
    }, NOW, fetchImpl);
    assert.strictEqual(data.wave, "--");
    assert.strictEqual(data.wave_quality, "--");
    assert.strictEqual(data.water, "--");
    assert.strictEqual(data.wind, "--");
    assert.strictEqual(data.wind_dir, null);
    assert.strictEqual(data.air, "--");
    assert.strictEqual(data.air_high, null);
    assert.strictEqual(data.air_low, null);
    assert.strictEqual(data.uv, "--");
    assert.strictEqual(data.humidity, "--");
    assert.strictEqual(data.rip_risk, "--");
    assert.strictEqual(data.sky_condition, "Cloudy"); // the spec's own "anything else" fallback
    assert.strictEqual(data.rain_note, undefined);
    assert.strictEqual(data.tide_label, undefined);
  });

  console.log(passed + " passed, " + failed + " failed");
  if (failed > 0) process.exit(1);
})();
