"use strict";

// Exercises espnProxyHandler directly (fake req/res, stubbed global
// fetch) -- no live network call, no Functions Framework needed. This is
// the fix for the confirmed-live bug where design-v2's Team tool couldn't
// call ESPN directly from the browser (CORS): the proxy makes the same
// request server-to-server instead.

const assert = require("assert");
const { espnProxyHandler, ALLOWED_LEAGUES } = require("../index.js")._internal;

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

(async () => {
  await test("ALLOWED_LEAGUES matches the 5 leagues design-v2 offers", () => {
    assert.deepStrictEqual(
      Array.from(ALLOWED_LEAGUES).sort(),
      ["baseball/mlb", "basketball/nba", "football/college-football", "football/nfl", "hockey/nhl"]
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

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
