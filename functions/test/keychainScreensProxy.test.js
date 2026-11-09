"use strict";

// Exercises keychainScreensProxyHandler directly (fake req/res, a fully
// in-memory fake bucket injected as bucketImpl) -- same approach as
// test/tideTagProxy.test.js's own makeFakeBucket.

const assert = require("assert");
const { keychainScreensProxyHandler } = require("../index.js")._internal;

const T1 = "AAAAAAAAAABBBBBBBBBB"; // 20 chars, valid tagId shape
const UNMINTED = "CCCCCCCCCCDDDDDDDDDD"; // well-formed, never minted

// Includes getFiles (mirrors test/tideTagProxy.test.js's own fake) --
// fetchDeviceTagLinkSelfHealing falls through to a tide-tags/ scan
// whenever a deviceId has no direct device-tag-links/ record yet
// (unlinked, or the legacy-pairing self-heal case), so any deviceId GET
// test needs this even when it's never meant to find anything.
function makeFakeBucket(initialFiles) {
  const store = new Map(Object.entries(initialFiles || {}));
  function fileHandle(path) {
    return {
      path,
      name: path,
      async download() {
        if (!store.has(path)) {
          const err = new Error("not found");
          err.code = 404;
          throw err;
        }
        return [Buffer.from(store.get(path), "utf8")];
      },
      async save(data) { store.set(path, data); }
    };
  }
  return {
    file: fileHandle,
    async getFiles(opts) {
      const prefix = (opts && opts.prefix) || "";
      const names = Array.from(store.keys()).filter((k) => k.startsWith(prefix));
      return [names.map(fileHandle)];
    },
    _store: store
  };
}

function mintedBucket(tagId, initialFiles) {
  return makeFakeBucket(Object.assign({ ["tide-tag-allowlist/" + tagId + ".json"]: JSON.stringify({ mintedAt: "x" }) }, initialFiles));
}

function fakeReq({ method = "GET", query = {}, body = {} } = {}) {
  return { method, query, body };
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
  await test("GET with a malformed tagId is rejected", async () => {
    const res = fakeRes();
    await keychainScreensProxyHandler(fakeReq({ query: { tagId: "short" } }), res, makeFakeBucket());
    assert.strictEqual(res.statusCode, 400);
  });

  await test("GET with nothing saved yet returns an empty array, not a 404", async () => {
    const res = fakeRes();
    await keychainScreensProxyHandler(fakeReq({ query: { tagId: T1 } }), res, mintedBucket(T1));
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { screens: [] });
  });

  await test("PUT with a malformed tagId is rejected before even checking the body", async () => {
    const res = fakeRes();
    await keychainScreensProxyHandler(fakeReq({ method: "PUT", body: { tagId: "short", screens: [] } }), res, makeFakeBucket());
    assert.strictEqual(res.statusCode, 400);
  });

  await test("PUT with an invalid screens entry is rejected with a 400 and a reason", async () => {
    const res = fakeRes();
    await keychainScreensProxyHandler(fakeReq({ method: "PUT", body: { tagId: T1, screens: [{ type: "songList", kind: "playlist", id: "not a link" }] } }), res, mintedBucket(T1));
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.error);
  });

  await test("PUT against a tagId that was never minted is rejected even if well-formed", async () => {
    const res = fakeRes();
    const body = { tagId: UNMINTED, screens: [{ type: "songList", kind: "playlist", id: "PLabc123def456" }] };
    await keychainScreensProxyHandler(fakeReq({ method: "PUT", body }), res, makeFakeBucket());
    assert.strictEqual(res.statusCode, 403);
  });

  await test("a valid playlist PUT saves and echoes back the sanitized screens", async () => {
    const res = fakeRes();
    const bucket = mintedBucket(T1);
    const body = { tagId: T1, screens: [{ type: "songList", kind: "playlist", id: "PLabc123def456" }] };
    await keychainScreensProxyHandler(fakeReq({ method: "PUT", body }), res, bucket);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { screens: [{ type: "songList", kind: "playlist", id: "PLabc123def456" }] });
  });

  await test("a valid single-video PUT (the feature this adds) saves and echoes back the sanitized screens", async () => {
    const res = fakeRes();
    const bucket = mintedBucket(T1);
    const body = { tagId: T1, screens: [{ type: "songList", kind: "video", id: "djV11Xbc914" }] };
    await keychainScreensProxyHandler(fakeReq({ method: "PUT", body }), res, bucket);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { screens: [{ type: "songList", kind: "video", id: "djV11Xbc914" }] });
  });

  await test("a kind/id mismatch is rejected with a 400, not silently coerced", async () => {
    const res = fakeRes();
    const body = { tagId: T1, screens: [{ type: "songList", kind: "video", id: "PLabc123def456" }] };
    await keychainScreensProxyHandler(fakeReq({ method: "PUT", body }), res, mintedBucket(T1));
    assert.strictEqual(res.statusCode, 400);
  });

  await test("a valid liveVideo PUT saves and echoes back the sanitized screens", async () => {
    const res = fakeRes();
    const bucket = mintedBucket(T1);
    const body = { tagId: T1, screens: [{ type: "liveVideo", id: "abc12345678" }] };
    await keychainScreensProxyHandler(fakeReq({ method: "PUT", body }), res, bucket);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { screens: [{ type: "liveVideo", id: "abc12345678" }] });
  });

  await test("a liveVideo with a playlist-shaped id is rejected with a 400", async () => {
    const res = fakeRes();
    const body = { tagId: T1, screens: [{ type: "liveVideo", id: "PLabc123def456" }] };
    await keychainScreensProxyHandler(fakeReq({ method: "PUT", body }), res, mintedBucket(T1));
    assert.strictEqual(res.statusCode, 400);
  });

  await test("songList and liveVideo coexist in one PUT -- both saved, neither displaces the other", async () => {
    const res = fakeRes();
    const bucket = mintedBucket(T1);
    const body = { tagId: T1, screens: [{ type: "songList", kind: "video", id: "djV11Xbc914" }, { type: "liveVideo", id: "abc12345678" }] };
    await keychainScreensProxyHandler(fakeReq({ method: "PUT", body }), res, bucket);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { screens: [{ type: "songList", kind: "video", id: "djV11Xbc914" }, { type: "liveVideo", id: "abc12345678" }] });
  });

  await test("a GET after a successful PUT reads back exactly what was saved", async () => {
    const bucket = mintedBucket(T1);
    const putRes = fakeRes();
    await keychainScreensProxyHandler(fakeReq({ method: "PUT", body: { tagId: T1, screens: [{ type: "songList", kind: "playlist", id: "PLabc123def456" }] } }), putRes, bucket);
    assert.strictEqual(putRes.statusCode, 200);

    const getRes = fakeRes();
    await keychainScreensProxyHandler(fakeReq({ query: { tagId: T1 } }), getRes, bucket);
    assert.strictEqual(getRes.statusCode, 200);
    assert.deepStrictEqual(getRes.body, { screens: [{ type: "songList", kind: "playlist", id: "PLabc123def456" }] });
  });

  await test("a PUT replaces the whole array -- adding a second valid screen type drops nothing else that's still valid", async () => {
    // Only one real type exists today, so this exercises the replace
    // semantics with two PUTs of the SAME type -- the second call's
    // array is what ends up saved, not merged with the first.
    const bucket = mintedBucket(T1);
    const res1 = fakeRes();
    await keychainScreensProxyHandler(fakeReq({ method: "PUT", body: { tagId: T1, screens: [{ type: "songList", kind: "playlist", id: "PLabc123def456" }] } }), res1, bucket);
    const res2 = fakeRes();
    await keychainScreensProxyHandler(fakeReq({ method: "PUT", body: { tagId: T1, screens: [{ type: "songList", kind: "video", id: "djV11Xbc914" }] } }), res2, bucket);
    assert.deepStrictEqual(res2.body, { screens: [{ type: "songList", kind: "video", id: "djV11Xbc914" }] });
  });

  await test("GET with no tagId and no deviceId at all is rejected", async () => {
    const res = fakeRes();
    await keychainScreensProxyHandler(fakeReq({ query: {} }), res, makeFakeBucket());
    assert.strictEqual(res.statusCode, 400);
  });

  await test("GET with a malformed deviceId is rejected", async () => {
    const res = fakeRes();
    await keychainScreensProxyHandler(fakeReq({ query: { deviceId: "bad id with spaces" } }), res, makeFakeBucket());
    assert.strictEqual(res.statusCode, 400);
  });

  // 404.html's device-scoped PREVIEW (see previewDeviceId's own comment
  // there) has no real tagId at all -- it passes deviceId instead, and
  // the server resolves the link server-side. The resolved tagId must
  // never appear in the response (same rule deviceLinkStatusHandler
  // already enforces, see DEVICE_TAG_LINKS_PREFIX's own comment in
  // lib/tideTag.js).
  await test("GET by deviceId (linked) returns that tag's screens, with no tagId in the response", async () => {
    const bucket = mintedBucket(T1, {
      "device-tag-links/WC-1.json": JSON.stringify({ tagId: T1, linkedAt: "x" }),
      ["keychain-screens/" + T1 + ".json"]: JSON.stringify({ screens: [{ type: "songList", kind: "video", id: "djV11Xbc914" }] })
    });
    const res = fakeRes();
    await keychainScreensProxyHandler(fakeReq({ query: { deviceId: "WC-1" } }), res, bucket);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { screens: [{ type: "songList", kind: "video", id: "djV11Xbc914" }] });
    assert.ok(!("tagId" in res.body), "response must never include the resolved tagId");
  });

  await test("GET by deviceId (nothing linked) returns an empty array, not an error", async () => {
    const res = fakeRes();
    await keychainScreensProxyHandler(fakeReq({ query: { deviceId: "WC-unlinked" } }), res, makeFakeBucket());
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { screens: [] });
  });

  await test("tagId takes precedence when both tagId and deviceId are somehow both present", async () => {
    const bucket = mintedBucket(T1, {
      ["keychain-screens/" + T1 + ".json"]: JSON.stringify({ screens: [{ type: "songList", kind: "video", id: "djV11Xbc914" }] })
    });
    const res = fakeRes();
    await keychainScreensProxyHandler(fakeReq({ query: { tagId: T1, deviceId: "WC-1" } }), res, bucket);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { screens: [{ type: "songList", kind: "video", id: "djV11Xbc914" }] });
  });

  await test("an unsupported method is rejected", async () => {
    const res = fakeRes();
    await keychainScreensProxyHandler(fakeReq({ method: "DELETE" }), res, mintedBucket(T1));
    assert.strictEqual(res.statusCode, 405);
  });

  console.log(passed + " passed, " + failed + " failed");
  if (failed > 0) process.exit(1);
})();
