"use strict";

// Exercises beachDayProxyHandler directly (fake req/res, stubbed global
// fetch) -- mirrors test/astroTimelineProxy.test.js exactly, same
// validation/error-shape conventions as every other live-preview proxy
// in index.js.

const assert = require("assert");
const { beachDayProxyHandler } = require("../index.js")._internal;

function fakeReq(query) {
  return { query };
}
function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
}

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

const WEATHER_RESPONSE = {
  hourly: {
    time: Array.from({ length: 24 }, (_, h) => "2026-07-15T" + String(h).padStart(2, "0") + ":00"),
    temperature_2m: Array.from({ length: 24 }, () => 78),
    relative_humidity_2m: Array.from({ length: 24 }, () => 60),
    uv_index: Array.from({ length: 24 }, () => 7),
    precipitation_probability: Array.from({ length: 24 }, () => 10),
    weather_code: Array.from({ length: 24 }, () => 1),
    wind_speed_10m: Array.from({ length: 24 }, () => 10),
    wind_direction_10m: Array.from({ length: 24 }, () => 225)
  },
  daily: { temperature_2m_max: [84], temperature_2m_min: [69] }
};
const MARINE_RESPONSE = {
  hourly: {
    time: Array.from({ length: 24 }, (_, h) => "2026-07-15T" + String(h).padStart(2, "0") + ":00"),
    wave_height: Array.from({ length: 24 }, () => 0.6),
    wave_period: Array.from({ length: 24 }, () => 8),
    wave_direction: Array.from({ length: 24 }, () => 90),
    sea_surface_temperature: Array.from({ length: 24 }, () => 22)
  }
};

const BULLETIN_TEXT = "NJZ024-241200-\nCoastal NJ\n...MODERATE RIP CURRENT RISK IN EFFECT THROUGH THIS EVENING...\nDetails here.\n$$\n";

function stubFetch() {
  return async (url) => {
    const u = String(url);
    if (u.includes("marine-api.open-meteo.com")) return { ok: true, json: async () => MARINE_RESPONSE };
    if (u.includes("api.open-meteo.com")) return { ok: true, json: async () => WEATHER_RESPONSE };
    if (u.includes("tgftp.nws.noaa.gov")) return { ok: true, text: async () => BULLETIN_TEXT };
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
}

(async () => {
  await test("rejects an out-of-range/missing lat or lon", async () => {
    const res = fakeRes();
    await beachDayProxyHandler(fakeReq({ lat: "999", lon: "-74.5", stationId: "8534720" }), res);
    assert.strictEqual(res.statusCode, 400);

    const res2 = fakeRes();
    await beachDayProxyHandler(fakeReq({ lon: "-74.5", stationId: "8534720" }), res2);
    assert.strictEqual(res2.statusCode, 400);
  });

  await test("rejects a non-numeric stationId", async () => {
    const res = fakeRes();
    await beachDayProxyHandler(fakeReq({ lat: "39.27", lon: "-74.57", stationId: "not-a-station" }), res);
    assert.strictEqual(res.statusCode, 400);
  });

  await test("a genuine fetch outage returns 502, not a crash", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error("network down"); };
    try {
      const res = fakeRes();
      await beachDayProxyHandler(fakeReq({ lat: "39.27", lon: "-74.57", stationId: "8534720" }), res);
      assert.strictEqual(res.statusCode, 502);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test("valid inputs return 200 with the assembled card payload", async () => {
    const originalFetch = global.fetch;
    global.fetch = stubFetch();
    try {
      const res = fakeRes();
      await beachDayProxyHandler(fakeReq({ lat: "39.27", lon: "-74.57", stationId: "8534720", townName: "ocean city" }), res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.town, "OCEAN CITY");
      assert.strictEqual(typeof res.body.weekday, "string");
      assert.strictEqual(res.body.subtitle, "1 PM conditions");
      assert.strictEqual(typeof res.body.sky_condition, "string");
      assert.strictEqual(typeof res.body.wave, "string");
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test("an invalid srfZone/coastFacingDirection is silently dropped, not passed through", async () => {
    const originalFetch = global.fetch;
    global.fetch = stubFetch();
    try {
      const res = fakeRes();
      await beachDayProxyHandler(fakeReq({ lat: "39.27", lon: "-74.57", stationId: "8534720", srfZone: "nope", coastFacingDirection: "sideways" }), res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.rip_risk, "--"); // no valid srfOffice/srfProductPrefix -> no bulletin fetch -> unknown
    } finally {
      global.fetch = originalFetch;
    }
  });

  // Regression for a real bug: srfOffice/srfProductPrefix are saved by
  // location/index.html in the SHAPE it actually produces -- lowercase,
  // "k"+3-letter CWA (e.g. "kphi") and a lowercase 6-char WMO collective
  // ID (e.g. "fzus51"), NOT 3 uppercase letters. The original validation
  // here rejected every real value, so rip_risk always came back "--" in
  // the live preview even for a device whose actual published screen
  // shows a real rip risk (it doesn't go through this proxy at all).
  await test("a real srfOffice/srfProductPrefix (lowercase, their real shape) is accepted and produces a real rip_risk", async () => {
    const originalFetch = global.fetch;
    global.fetch = stubFetch();
    try {
      const res = fakeRes();
      await beachDayProxyHandler(fakeReq({
        lat: "39.27", lon: "-74.57", stationId: "8534720",
        srfZone: "NJZ024", srfOffice: "kphi", srfProductPrefix: "fzus51", coastFacingDirection: "E"
      }), res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.rip_risk, "MID");
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test("srfOffice/srfProductPrefix are accepted case-insensitively (uppercase input still matches)", async () => {
    const originalFetch = global.fetch;
    global.fetch = stubFetch();
    try {
      const res = fakeRes();
      await beachDayProxyHandler(fakeReq({
        lat: "39.27", lon: "-74.57", stationId: "8534720",
        srfZone: "NJZ024", srfOffice: "KPHI", srfProductPrefix: "FZUS51", coastFacingDirection: "E"
      }), res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.rip_risk, "MID");
    } finally {
      global.fetch = originalFetch;
    }
  });

  // location/index.html saves the literal lowercase string "none" (not
  // null) for a device that explicitly skipped the forecast zone step --
  // this must degrade to "--", not attempt a bogus bulletin fetch.
  await test("the 'none' sentinel (lowercase, what location/index.html actually saves) yields '--', not a fetch attempt", async () => {
    const originalFetch = global.fetch;
    let bulletinFetched = false;
    global.fetch = async (url) => {
      if (String(url).includes("tgftp.nws.noaa.gov")) bulletinFetched = true;
      return stubFetch()(url);
    };
    try {
      const res = fakeRes();
      await beachDayProxyHandler(fakeReq({
        lat: "39.27", lon: "-74.57", stationId: "8534720",
        srfZone: "none", srfOffice: "none", srfProductPrefix: "none", coastFacingDirection: "none"
      }), res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.rip_risk, "--");
      assert.strictEqual(bulletinFetched, false);
    } finally {
      global.fetch = originalFetch;
    }
  });

  console.log(passed + " passed, " + failed + " failed");
  if (failed > 0) process.exit(1);
})();
