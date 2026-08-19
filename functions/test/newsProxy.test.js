"use strict";

// Exercises newsProxyHandler directly (fake req/res, stubbed global
// fetch) -- no live network call needed. Mirrors espnProxy.test.js's
// approach: this proxy exists so design-v2's News tool can show real
// headlines in its live preview, the same way espnProxy lets the Team
// tool show a real schedule/logos -- an arbitrary RSS feed almost never
// sends the CORS headers a browser fetch() needs.

const assert = require("assert");
const { newsProxyHandler } = require("../index.js")._internal;

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

const SAMPLE_RSS = `<rss><channel>
<item><title><![CDATA[Boardwalk reconstruction to begin after Labor Day]]></title></item>
<item><title>Council approves new beach tag pricing</title></item>
</channel></rss>`;

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
  await test("rejects a request with neither location nor feedUrl", async () => {
    const req = fakeReq({});
    const res = fakeRes();
    await newsProxyHandler(req, res);
    assert.strictEqual(res.statusCode, 400);
  });

  await test("location: builds the Google News search URL and returns parsed headlines", async () => {
    const req = fakeReq({ location: "Ocean City, NJ" });
    const res = fakeRes();
    let requestedUrl = null;
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      requestedUrl = url;
      return { ok: true, status: 200, async text() { return SAMPLE_RSS; } };
    };
    try {
      await newsProxyHandler(req, res);
    } finally {
      global.fetch = originalFetch;
    }
    assert.ok(String(requestedUrl).startsWith("https://news.google.com/rss/search?q=Ocean"), "got: " + requestedUrl);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, {
      headlines: [
        "Boardwalk reconstruction to begin after Labor Day",
        "Council approves new beach tag pricing"
      ]
    });
  });

  await test("feedUrl: forwards a safe custom feed URL directly", async () => {
    const req = fakeReq({ feedUrl: "https://example.com/local-news.xml" });
    const res = fakeRes();
    let requestedUrl = null;
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      requestedUrl = url;
      return { ok: true, status: 200, async text() { return SAMPLE_RSS; } };
    };
    try {
      await newsProxyHandler(req, res);
    } finally {
      global.fetch = originalFetch;
    }
    assert.strictEqual(requestedUrl, "https://example.com/local-news.xml");
    assert.strictEqual(res.statusCode, 200);
  });

  await test("feedUrl: rejects an unsafe URL (SSRF attempt) with 400, never fetching it", async () => {
    const req = fakeReq({ feedUrl: "http://169.254.169.254/computeMetadata/v1/" });
    const res = fakeRes();
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error("should never be called"); };
    try {
      await newsProxyHandler(req, res);
    } finally {
      global.fetch = originalFetch;
    }
    assert.strictEqual(res.statusCode, 400);
  });

  await test("feedUrl: rejects a non-http(s) URL", async () => {
    const req = fakeReq({ feedUrl: "file:///etc/passwd" });
    const res = fakeRes();
    await newsProxyHandler(req, res);
    assert.strictEqual(res.statusCode, 400);
  });

  await test("a real feed-fetch failure returns 502, not a crash", async () => {
    const req = fakeReq({ location: "Nowhere" });
    const res = fakeRes();
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error("network down"); };
    try {
      await newsProxyHandler(req, res);
    } finally {
      global.fetch = originalFetch;
    }
    assert.strictEqual(res.statusCode, 502);
  });

  await test("an empty (reachable, no headlines) feed returns an empty headlines array, not an error", async () => {
    const req = fakeReq({ location: "Nowhere" });
    const res = fakeRes();
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: true, status: 200, async text() { return "<rss><channel></channel></rss>"; } });
    try {
      await newsProxyHandler(req, res);
    } finally {
      global.fetch = originalFetch;
    }
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { headlines: [] });
  });

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
