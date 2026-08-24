"use strict";

// Exercises teamsnapProxyHandler directly (fake req/res, stubbed global
// fetch) -- no live network call needed. Mirrors newsProxy.test.js's
// approach: this proxy exists so team-schedule.html can show a team's
// real TeamSnap schedule, the same way newsProxy lets design's News tool
// show real headlines -- TeamSnap's feed almost never sends the CORS
// headers a browser fetch() needs.

const assert = require("assert");
const { teamsnapProxyHandler } = require("../index.js")._internal;

const SAMPLE_ICS = [
  "BEGIN:VCALENDAR",
  "X-WR-CALNAME:Riptide 12U Schedule",
  "BEGIN:VEVENT",
  "UID:111@teamsnap.com",
  "DTSTART:20260905T173000Z",
  "SUMMARY:Practice",
  "END:VEVENT",
  "END:VCALENDAR"
].join("\r\n");

const FEED_URL = "https://ical-cdn.teamsnap.com/team_schedule/bc5a413c-e630-470d-8537-0fd2d1d90720.ics";

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
  await test("rejects a request with no url", async () => {
    const req = fakeReq({});
    const res = fakeRes();
    await teamsnapProxyHandler(req, res);
    assert.strictEqual(res.statusCode, 400);
  });

  await test("rejects a non-teamsnap url without ever fetching it", async () => {
    const req = fakeReq({ url: "https://evil.example.com/x.ics" });
    const res = fakeRes();
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error("should never be called"); };
    try {
      await teamsnapProxyHandler(req, res);
    } finally {
      global.fetch = originalFetch;
    }
    assert.strictEqual(res.statusCode, 400);
  });

  await test("fetches a valid feed url and returns parsed calendarName + events", async () => {
    const req = fakeReq({ url: FEED_URL });
    const res = fakeRes();
    let requestedUrl = null;
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      requestedUrl = url;
      return { ok: true, status: 200, async text() { return SAMPLE_ICS; } };
    };
    try {
      await teamsnapProxyHandler(req, res);
    } finally {
      global.fetch = originalFetch;
    }
    assert.strictEqual(requestedUrl, FEED_URL);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.calendarName, "Riptide 12U Schedule");
    assert.strictEqual(res.body.events.length, 1);
    assert.strictEqual(res.body.events[0].summary, "Practice");
  });

  await test("a real feed-fetch failure returns 502, not a crash", async () => {
    const req = fakeReq({ url: FEED_URL });
    const res = fakeRes();
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error("network down"); };
    try {
      await teamsnapProxyHandler(req, res);
    } finally {
      global.fetch = originalFetch;
    }
    assert.strictEqual(res.statusCode, 502);
  });

  await test("an upstream non-ok response also returns 502", async () => {
    const req = fakeReq({ url: FEED_URL });
    const res = fakeRes();
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 404, async text() { return "not found"; } });
    try {
      await teamsnapProxyHandler(req, res);
    } finally {
      global.fetch = originalFetch;
    }
    assert.strictEqual(res.statusCode, 502);
  });

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
