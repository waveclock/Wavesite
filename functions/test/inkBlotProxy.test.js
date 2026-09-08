"use strict";

// Exercises inkBlotProxyHandler directly (fake req/res, injected art
// generator) -- no live Vertex AI call needed. Mirrors imagenProxy.test.js's
// approach: this proxy also bills real money per call, so most of what's
// worth testing here is that the request shape stays closed -- only a
// user's own photo bytes ever reach Gemini, never a free-text prompt from
// the request body (see inkBlotProxyHandler's own comment in index.js).

const assert = require("assert");
const { inkBlotProxyHandler } = require("../index.js")._internal;

function fakeReq({ method = "POST", body = {} } = {}) {
  return { method, body };
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
  await test("rejects a non-POST request", async () => {
    const req = fakeReq({ method: "GET" });
    const res = fakeRes();
    await inkBlotProxyHandler(req, res, async () => { throw new Error("should never be called"); });
    assert.strictEqual(res.statusCode, 405);
  });

  await test("rejects a request with no image", async () => {
    const req = fakeReq({ body: { mimeType: "image/png" } });
    const res = fakeRes();
    await inkBlotProxyHandler(req, res, async () => { throw new Error("should never be called"); });
    assert.strictEqual(res.statusCode, 400);
  });

  await test("rejects a request with no mimeType", async () => {
    const req = fakeReq({ body: { image: Buffer.from("x").toString("base64") } });
    const res = fakeRes();
    await inkBlotProxyHandler(req, res, async () => { throw new Error("should never be called"); });
    assert.strictEqual(res.statusCode, 400);
  });

  await test("rejects a mimeType outside the small photo allowlist -- never an arbitrary passthrough", async () => {
    const req = fakeReq({ body: { image: Buffer.from("x").toString("base64"), mimeType: "text/html" } });
    const res = fakeRes();
    let called = false;
    await inkBlotProxyHandler(req, res, async () => { called = true; return Buffer.from(""); });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(called, false, "must never call the art generator for a disallowed mimeType");
  });

  await test("rejects an image over the size limit instead of quietly billing for it", async () => {
    const huge = Buffer.alloc(5 * 1024 * 1024, 1).toString("base64"); // 5MB, over the 4MB decoded cap
    const req = fakeReq({ body: { image: huge, mimeType: "image/png" } });
    const res = fakeRes();
    let called = false;
    await inkBlotProxyHandler(req, res, async () => { called = true; return Buffer.from(""); });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(called, false, "must never call the art generator for an oversized image");
  });

  await test("a valid request calls the art generator with the decoded image bytes and mimeType, and returns image/png", async () => {
    const sourcePng = Buffer.from("pretend png bytes", "utf8");
    const req = fakeReq({ body: { image: sourcePng.toString("base64"), mimeType: "image/png" } });
    const res = fakeRes();
    const fakeResultBytes = Buffer.from("pretend ink blot png bytes", "utf8");
    let capturedArgs = null;
    await inkBlotProxyHandler(req, res, async (imageBuffer, mimeType) => {
      capturedArgs = { imageBuffer, mimeType };
      return fakeResultBytes;
    });
    assert.ok(capturedArgs.imageBuffer.equals(sourcePng));
    assert.strictEqual(capturedArgs.mimeType, "image/png");
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers["Content-Type"], "image/png");
    assert.ok(Buffer.isBuffer(res.body) && res.body.equals(fakeResultBytes));
  });

  await test("a real generation failure (safety filter, Vertex AI outage) returns 502, not a crash", async () => {
    const req = fakeReq({ body: { image: Buffer.from("x").toString("base64"), mimeType: "image/jpeg" } });
    const res = fakeRes();
    await inkBlotProxyHandler(req, res, async () => { throw new Error("Gemini unreachable"); });
    assert.strictEqual(res.statusCode, 502);
  });

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
