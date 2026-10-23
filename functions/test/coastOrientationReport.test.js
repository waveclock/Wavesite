"use strict";

// Exercises coastOrientationReportHandler directly (fake req/res, a fully
// in-memory fake bucket injected as bucketImpl) -- same approach as
// test/tideTagProxy.test.js's own makeFakeBucket, extended here with
// res.set()/res.send() since this handler renders HTML rather than JSON.

const assert = require("assert");
const { coastOrientationReportHandler } = require("../index.js")._internal;

const SECRET = "test-secret";
process.env.WAVECLOCK_MINT_SECRET = SECRET;

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
      }
    };
  }
  return {
    file: fileHandle,
    async getFiles(opts) {
      const prefix = (opts && opts.prefix) || "";
      const names = Array.from(store.keys()).filter((k) => k.startsWith(prefix));
      return [names.map(fileHandle)];
    }
  };
}

function fakeReq({ query = {} } = {}) {
  return { query };
}

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    send(payload) { this.body = payload; return this; },
    json(payload) { this.body = payload; return this; }
  };
}

function deviceStatusFile(location) {
  return JSON.stringify({ location, settings: {} });
}
function locationsFile(fields) {
  return JSON.stringify(fields);
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
  console.log("coastOrientationReport");

  await test("missing secret is refused with 403", async () => {
    const req = fakeReq({ query: {} });
    const res = fakeRes();
    await coastOrientationReportHandler(req, res, makeFakeBucket({}));
    assert.strictEqual(res.statusCode, 403);
  });

  await test("wrong secret is refused with 403", async () => {
    const req = fakeReq({ query: { secret: "nope" } });
    const res = fakeRes();
    await coastOrientationReportHandler(req, res, makeFakeBucket({}));
    assert.strictEqual(res.statusCode, 403);
  });

  await test("unconfigured secret refuses every request, even an empty one", async () => {
    const saved = process.env.WAVECLOCK_MINT_SECRET;
    delete process.env.WAVECLOCK_MINT_SECRET;
    try {
      const req = fakeReq({ query: { secret: "" } });
      const res = fakeRes();
      await coastOrientationReportHandler(req, res, makeFakeBucket({}));
      assert.strictEqual(res.statusCode, 403);
    } finally {
      process.env.WAVECLOCK_MINT_SECRET = saved;
    }
  });

  await test("no devices on file renders a 200 HTML page reporting zero", async () => {
    const req = fakeReq({ query: { secret: SECRET } });
    const res = fakeRes();
    await coastOrientationReportHandler(req, res, makeFakeBucket({}));
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.headers["Content-Type"].includes("text/html"));
    assert.ok(res.body.includes("0 device(s)"));
  });

  await test("device-status takes precedence over locations/ for the same device", async () => {
    const bucket = makeFakeBucket({
      "device-status/WC-AAA.json": deviceStatusFile({ cwfZone: "ANZ452", srfZone: "NJZ025", coastFacingDirection: "E" }),
      "locations/WC-AAA.json": locationsFile({ cwfZone: "ANZ452", srfZone: "NJZ025", coastFacingDirection: "SW" })
    });
    const req = fakeReq({ query: { secret: SECRET } });
    const res = fakeRes();
    await coastOrientationReportHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.includes("device-status"));
    assert.ok(res.body.includes(">E<"));
    assert.ok(!res.body.includes(">SW<"));
  });

  await test("falls back to locations/ when device-status has no cwfZone", async () => {
    const bucket = makeFakeBucket({
      "device-status/WC-BBB.json": deviceStatusFile({}),
      "locations/WC-BBB.json": locationsFile({ cwfZone: "ANZ452", srfZone: "NJZ024", coastFacingDirection: "SE" })
    });
    const req = fakeReq({ query: { secret: SECRET } });
    const res = fakeRes();
    await coastOrientationReportHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.includes("locations"));
    assert.ok(res.body.includes(">SE<"));
  });

  await test("falls back to locations/ when device-status/ is missing entirely", async () => {
    const bucket = makeFakeBucket({
      "locations/WC-CCC.json": locationsFile({ cwfZone: "ANZ452", srfZone: "NJZ024", coastFacingDirection: "SE" })
    });
    const req = fakeReq({ query: { secret: SECRET } });
    const res = fakeRes();
    await coastOrientationReportHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.includes("WC-CCC"));
  });

  await test("agreeing devices in the same marine zone are not flagged mixed", async () => {
    const bucket = makeFakeBucket({
      "device-status/WC-D1.json": deviceStatusFile({ cwfZone: "ANZ452", srfZone: "NJZ025", coastFacingDirection: "E" }),
      "device-status/WC-D2.json": deviceStatusFile({ cwfZone: "ANZ452", srfZone: "NJZ025", coastFacingDirection: "E" })
    });
    const req = fakeReq({ query: { secret: SECRET } });
    const res = fakeRes();
    await coastOrientationReportHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(!res.body.includes("mixed directions"));
  });

  await test("disagreeing devices in the same marine zone are flagged mixed", async () => {
    const bucket = makeFakeBucket({
      "device-status/WC-D1.json": deviceStatusFile({ cwfZone: "ANZ452", srfZone: "NJZ025", coastFacingDirection: "E" }),
      "device-status/WC-D2.json": deviceStatusFile({ cwfZone: "ANZ452", srfZone: "NJZ025", coastFacingDirection: "SW" })
    });
    const req = fakeReq({ query: { secret: SECRET } });
    const res = fakeRes();
    await coastOrientationReportHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.includes("mixed directions"));
  });

  // Guards specifically against the bug this report shipped with once
  // already: grouping by the land zone (srfZone) instead of the marine
  // zone (cwfZone) that KNOWN_ZONE_COAST_DIRECTIONS is actually keyed by.
  await test("groups by cwfZone, not srfZone -- two devices sharing a srfZone but in different cwfZones land in separate zone sections", async () => {
    const bucket = makeFakeBucket({
      "device-status/WC-E1.json": deviceStatusFile({ cwfZone: "ANZ452", srfZone: "NJZ025", coastFacingDirection: "E" }),
      "device-status/WC-E2.json": deviceStatusFile({ cwfZone: "ANZ453", srfZone: "NJZ025", coastFacingDirection: "SE" })
    });
    const req = fakeReq({ query: { secret: SECRET } });
    const res = fakeRes();
    await coastOrientationReportHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.includes("ANZ452"));
    assert.ok(res.body.includes("ANZ453"));
    assert.ok(!res.body.includes("mixed directions"), "different cwfZones must not be merged into one 'mixed' group");
  });

  await test("a device's srfZone is shown as context but is never used as a zone heading", async () => {
    const bucket = makeFakeBucket({
      "device-status/WC-F1.json": deviceStatusFile({ cwfZone: "ANZ452", srfZone: "NJZ025", coastFacingDirection: "E" })
    });
    const req = fakeReq({ query: { secret: SECRET } });
    const res = fakeRes();
    await coastOrientationReportHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.includes(">NJZ025<"), "srfZone should still appear somewhere, as context");
    assert.ok(res.body.includes("ANZ452"));
  });

  await test("a device missing cwfZone (but with srfZone) on both sources falls into the 'none on file' group", async () => {
    const bucket = makeFakeBucket({
      "device-status/WC-G1.json": deviceStatusFile({ srfZone: "NJZ025", coastFacingDirection: "E" })
    });
    const req = fakeReq({ query: { secret: SECRET } });
    const res = fakeRes();
    await coastOrientationReportHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.includes("(none on file)"));
  });

  await test("a malformed device filename (path-traversal shape) is skipped", async () => {
    const bucket = makeFakeBucket({
      "device-status/../../etc/passwd.json": deviceStatusFile({ cwfZone: "ANZ452", srfZone: "NJZ025", coastFacingDirection: "E" })
    });
    const req = fakeReq({ query: { secret: SECRET } });
    const res = fakeRes();
    await coastOrientationReportHandler(req, res, bucket);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.includes("0 device(s)"));
  });

  console.log(passed + " passed, " + failed + " failed");
  if (failed > 0) process.exit(1);
})();
