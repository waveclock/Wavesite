"use strict";

// Exercises imagenProxyHandler directly (fake req/res, injected art
// generator) -- no live Vertex AI call needed. Mirrors espnProxy.test.js/
// newsProxy.test.js's approach: this proxy exists so design's Beach
// Buddy tool can show the REAL Imagen illustration while previewing,
// the same CORS reasoning as every other proxy here. Unlike those,
// though, this one bills real money per call, so most of what's worth
// testing here is the closed pose allowlist -- see imagenProxyHandler's
// own comment in index.js for why an open free-text prompt would be a
// real cost/abuse problem, not just a style choice.

const assert = require("assert");
const { imagenProxyHandler } = require("../index.js")._internal;
const { IMAGEN_SCENE_HINTS } = require("../lib/imagen");

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
  await test("rejects a request with no pose", async () => {
    const req = fakeReq({});
    const res = fakeRes();
    await imagenProxyHandler(req, res, async () => { throw new Error("should never be called"); });
    assert.strictEqual(res.statusCode, 400);
  });

  await test("rejects a pose that isn't one of the known IMAGEN_SCENE_HINTS -- never an open free-text prompt relay", async () => {
    const req = fakeReq({ pose: "literally anything the customer typed into devtools" });
    const res = fakeRes();
    let called = false;
    await imagenProxyHandler(req, res, async () => { called = true; return Buffer.from(""); });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(called, false, "must never call the art generator for an unrecognized pose");
    assert.ok(res.body && res.body.error.includes(Object.keys(IMAGEN_SCENE_HINTS)[0]), "error message should list the allowed poses");
  });

  await test("rejects the object-prototype-pollution edge case (e.g. pose=constructor) even though a naive lookup would return truthy", async () => {
    const req = fakeReq({ pose: "constructor" });
    const res = fakeRes();
    await imagenProxyHandler(req, res, async () => { throw new Error("should never be called"); });
    assert.strictEqual(res.statusCode, 400);
  });

  await test("a valid pose calls the art generator with exactly that pose and returns the image bytes as image/png", async () => {
    const req = fakeReq({ pose: "surfing" });
    const res = fakeRes();
    const fakeBytes = Buffer.from("pretend png bytes", "utf8");
    let calledWithMood = null;
    await imagenProxyHandler(req, res, async (mood) => {
      calledWithMood = mood;
      return fakeBytes;
    });
    assert.deepStrictEqual(calledWithMood, { pose: "surfing" });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers["Content-Type"], "image/png");
    assert.ok(Buffer.isBuffer(res.body) && res.body.equals(fakeBytes));
  });

  await test("every pose moodForBeachData can actually pick is accepted", async () => {
    for (const pose of Object.keys(IMAGEN_SCENE_HINTS)) {
      const req = fakeReq({ pose });
      const res = fakeRes();
      await imagenProxyHandler(req, res, async () => Buffer.from("x"));
      assert.strictEqual(res.statusCode, 200, pose + " was unexpectedly rejected");
    }
  });

  await test("a real generation failure (safety filter, Vertex AI outage) returns 502, not a crash", async () => {
    const req = fakeReq({ pose: "windy" });
    const res = fakeRes();
    await imagenProxyHandler(req, res, async () => { throw new Error("Imagen unreachable"); });
    assert.strictEqual(res.statusCode, 502);
  });

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
