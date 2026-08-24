"use strict";

// Exercises espnProxyHandler directly (fake req/res, stubbed global
// fetch) -- no live network call, no Functions Framework needed. This is
// the fix for the confirmed-live bug where design's Team tool couldn't
// call ESPN directly from the browser (CORS): the proxy makes the same
// request server-to-server instead.

const assert = require("assert");
const { espnProxyHandler, ALLOWED_LEAGUES } = require("../index.js")._internal;
const { OUTBOUND_FETCH_HEADERS } = require("../lib/dynamic");

function fakeReq(query) {
  return { query };
}

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    send(payload) { this.body = payload; return this; }
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

(async () => {
  await test("ALLOWED_LEAGUES matches the leagues design offers", () => {
    assert.deepStrictEqual(
      Array.from(ALLOWED_LEAGUES).sort(),
      ["baseball/mlb", "basketball/nba", "basketball/womens-college-basketball", "football/college-football", "football/nfl", "hockey/nhl"]
    );
  });

  await test("rejects an unknown sport/league (not just a passthrough relay)", async () => {
    const req = fakeReq({ sport: "football", league: "xfl", kind: "teams" });
    const res = fakeRes();
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error("should never be called"); };
    try {
      await espnProxyHandler(req, res);
    } finally {
      global.fetch = originalFetch;
    }
    assert.strictEqual(res.statusCode, 400);
  });

  await test("rejects a missing sport/league entirely", async () => {
    const req = fakeReq({ kind: "teams" });
    const res = fakeRes();
    await espnProxyHandler(req, res);
    assert.strictEqual(res.statusCode, 400);
  });

  await test("teams: forwards to ESPN's teams URL and returns its JSON as-is", async () => {
    const req = fakeReq({ sport: "football", league: "nfl", kind: "teams" });
    const res = fakeRes();
    let requestedUrl = null;
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      requestedUrl = url;
      return { status: 200, async json() { return { sports: [{ leagues: [{ teams: [] }] }] }; } };
    };
    try {
      await espnProxyHandler(req, res);
    } finally {
      global.fetch = originalFetch;
    }
    assert.ok(requestedUrl.includes("/football/nfl/teams"), "expected the NFL teams endpoint, got: " + requestedUrl);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { sports: [{ leagues: [{ teams: [] }] }] });
  });

  await test("teams: does NOT send a custom User-Agent -- this endpoint is currently working live without one, left alone while fixing the still-broken RSS fetch", async () => {
    const req = fakeReq({ sport: "football", league: "nfl", kind: "teams" });
    const res = fakeRes();
    let capturedOptions = null;
    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
      capturedOptions = options;
      return { status: 200, async json() { return { sports: [] }; } };
    };
    try {
      await espnProxyHandler(req, res);
    } finally {
      global.fetch = originalFetch;
    }
    assert.strictEqual(capturedOptions, undefined);
  });

  await test("schedule: requires a teamId", async () => {
    const req = fakeReq({ sport: "football", league: "nfl", kind: "schedule" });
    const res = fakeRes();
    await espnProxyHandler(req, res);
    assert.strictEqual(res.statusCode, 400);
  });

  await test("schedule: forwards to ESPN's team-schedule URL with the right teamId", async () => {
    const req = fakeReq({ sport: "football", league: "nfl", kind: "schedule", teamId: "21" });
    const res = fakeRes();
    let requestedUrl = null;
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      requestedUrl = url;
      return { status: 200, async json() { return { events: [] }; } };
    };
    try {
      await espnProxyHandler(req, res);
    } finally {
      global.fetch = originalFetch;
    }
    assert.ok(requestedUrl.includes("/football/nfl/teams/21/schedule"), "got: " + requestedUrl);
    assert.strictEqual(res.statusCode, 200);
  });

  await test("schedule: explicitly requests seasontype=2 (regular season), confirmed live: without it ESPN defaults to Preseason, which is empty for college football and reads as \"no upcoming games\"", async () => {
    const req = fakeReq({ sport: "football", league: "college-football", kind: "schedule", teamId: "213" });
    const res = fakeRes();
    let requestedUrl = null;
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      requestedUrl = url;
      return { status: 200, async json() { return { events: [] }; } };
    };
    try {
      await espnProxyHandler(req, res);
    } finally {
      global.fetch = originalFetch;
    }
    assert.ok(requestedUrl.includes("seasontype=2"), "got: " + requestedUrl);
  });

  await test("rejects an unknown kind", async () => {
    const req = fakeReq({ sport: "football", league: "nfl", kind: "standings" });
    const res = fakeRes();
    await espnProxyHandler(req, res);
    assert.strictEqual(res.statusCode, 400);
  });

  await test("a real ESPN outage returns 502, not a crash", async () => {
    const req = fakeReq({ sport: "football", league: "nfl", kind: "teams" });
    const res = fakeRes();
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error("network down"); };
    try {
      await espnProxyHandler(req, res);
    } finally {
      global.fetch = originalFetch;
    }
    assert.strictEqual(res.statusCode, 502);
  });

  await test("passes through ESPN's own error status (e.g. a bad teamId -> 404)", async () => {
    const req = fakeReq({ sport: "football", league: "nfl", kind: "schedule", teamId: "999999" });
    const res = fakeRes();
    const originalFetch = global.fetch;
    global.fetch = async () => ({ status: 404, async json() { return { error: "not found" }; } });
    try {
      await espnProxyHandler(req, res);
    } finally {
      global.fetch = originalFetch;
    }
    assert.strictEqual(res.statusCode, 404);
  });

  console.log("logo kind (Game Day card logos, live-preview only)");
  await test("logo: forwards a real ESPN CDN URL and streams the image bytes with its content-type", async () => {
    const req = fakeReq({ kind: "logo", url: "https://a.espncdn.com/i/teamlogos/nfl/500/phi.png" });
    const res = fakeRes();
    const fakeBytes = new Uint8Array([1, 2, 3, 4]).buffer;
    let requestedUrl = null;
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      requestedUrl = url;
      return { ok: true, status: 200, headers: { get: () => "image/png" }, async arrayBuffer() { return fakeBytes; } };
    };
    try {
      await espnProxyHandler(req, res);
    } finally {
      global.fetch = originalFetch;
    }
    assert.strictEqual(requestedUrl, "https://a.espncdn.com/i/teamlogos/nfl/500/phi.png");
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers["Content-Type"], "image/png");
    assert.deepStrictEqual(Array.from(res.body), [1, 2, 3, 4]);
  });
  await test("logo: sends a browser-like User-Agent too", async () => {
    const req = fakeReq({ kind: "logo", url: "https://a.espncdn.com/i/teamlogos/nfl/500/phi.png" });
    const res = fakeRes();
    let capturedOptions = null;
    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
      capturedOptions = options;
      return { ok: true, status: 200, headers: { get: () => "image/png" }, async arrayBuffer() { return new ArrayBuffer(0); } };
    };
    try {
      await espnProxyHandler(req, res);
    } finally {
      global.fetch = originalFetch;
    }
    assert.strictEqual(capturedOptions.headers, OUTBOUND_FETCH_HEADERS);
  });
  await test("logo: rejects a non-ESPN-CDN URL (not an open image relay)", async () => {
    const req = fakeReq({ kind: "logo", url: "https://evil.example.com/tracker.png" });
    const res = fakeRes();
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error("should never be called"); };
    try {
      await espnProxyHandler(req, res);
    } finally {
      global.fetch = originalFetch;
    }
    assert.strictEqual(res.statusCode, 400);
  });
  await test("logo: rejects a plain-http (non-https) URL even on the right hostname", async () => {
    const req = fakeReq({ kind: "logo", url: "http://a.espncdn.com/i/teamlogos/nfl/500/phi.png" });
    const res = fakeRes();
    await espnProxyHandler(req, res);
    assert.strictEqual(res.statusCode, 400);
  });
  await test("logo: rejects a missing url", async () => {
    const req = fakeReq({ kind: "logo" });
    const res = fakeRes();
    await espnProxyHandler(req, res);
    assert.strictEqual(res.statusCode, 400);
  });
  await test("logo: a real CDN outage returns 502, not a crash", async () => {
    const req = fakeReq({ kind: "logo", url: "https://a.espncdn.com/i/teamlogos/nfl/500/phi.png" });
    const res = fakeRes();
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error("network down"); };
    try {
      await espnProxyHandler(req, res);
    } finally {
      global.fetch = originalFetch;
    }
    assert.strictEqual(res.statusCode, 502);
  });

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
