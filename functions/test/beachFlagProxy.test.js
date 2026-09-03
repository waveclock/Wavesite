"use strict";

// Exercises beachFlagProxyHandler directly (fake req/res, stubbed global
// fetch) -- same pattern as test/astroProxy.test.js.

const assert = require("assert");
const { beachFlagProxyHandler } = require("../index.js")._internal;

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

const SAMPLE_FLAG_HTML = "<html><body><h2>YELLOW: MEDIUM HAZARD</h2><p>Last Refreshed: 09/02/2026 6:05 pm CDT</p></body></html>";

function stubFetchByHost(handlers) {
  return async (url) => {
    const u = new URL(url);
    const handler = handlers[u.hostname];
    if (!handler) throw new Error("unexpected host in test: " + u.hostname);
    return handler(u);
  };
}

(async () => {
  await test("no lat/lon/stationId at all is fine -- they're optional, unlike astroProxy", async () => {
    const originalFetch = global.fetch;
    global.fetch = stubFetchByHost({ "30a.com": async () => ({ ok: true, status: 200, text: async () => SAMPLE_FLAG_HTML }) });
    try {
      const res = fakeRes();
      await beachFlagProxyHandler(fakeReq({}), res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.flags[0].color, "YELLOW");
      assert.strictEqual(res.body.waterTempF, null);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test("rejects an out-of-range lat when coordinates are provided", async () => {
    const res = fakeRes();
    await beachFlagProxyHandler(fakeReq({ lat: "999", lon: "-86.15", stationId: "8729210" }), res);
    assert.strictEqual(res.statusCode, 400);
  });

  await test("rejects a non-numeric stationId when coordinates are provided", async () => {
    const res = fakeRes();
    await beachFlagProxyHandler(fakeReq({ lat: "30.35", lon: "-86.15", stationId: "not-a-station" }), res);
    assert.strictEqual(res.statusCode, 400);
  });

  await test("a 30a.com outage returns 502, not a crash", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error("network down"); };
    try {
      const res = fakeRes();
      await beachFlagProxyHandler(fakeReq({}), res);
      assert.strictEqual(res.statusCode, 502);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test("valid coordinates return 200 with flag status plus the bonus surf/water stats", async () => {
    const originalFetch = global.fetch;
    global.fetch = stubFetchByHost({
      "30a.com": async () => ({ ok: true, status: 200, text: async () => SAMPLE_FLAG_HTML }),
      "api.tidesandcurrents.noaa.gov": async (u) => {
        const interval = u.searchParams.get("interval");
        const noaa = {
          h: [{ t: "2026-07-15 12:00", v: "2.00" }],
          hilo: [{ t: "2026-07-15 07:14", v: "0.60", type: "L" }, { t: "2026-07-15 13:22", v: "4.40", type: "H" }]
        };
        return { json: async () => ({ predictions: noaa[interval] || [] }) };
      },
      "api.open-meteo.com": async () => ({ json: async () => ({ hourly: { time: [] } }) }),
      "marine-api.open-meteo.com": async () => ({ json: async () => ({ hourly: { time: [] } }) })
    });
    try {
      const res = fakeRes();
      await beachFlagProxyHandler(fakeReq({ lat: "30.35", lon: "-86.15", stationId: "8729210" }), res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.flags[0].color, "YELLOW");
    } finally {
      global.fetch = originalFetch;
    }
  });

  console.log(passed + " passed, " + failed + " failed");
  if (failed > 0) process.exit(1);
})();
