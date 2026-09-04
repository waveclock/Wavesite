"use strict";

// Exercises lib/ocnjPipeline.js's orchestration -- source fetch failures,
// the MIN_EXPECTED_EVENTS cache-fallback gate, and Storage output -- all
// against a fully in-memory fake bucket and stubbed fetch/PDF/LLM calls.
// No live network calls (same reasoning as every other proxy test in this
// codebase).

const assert = require("assert");
const { runOcnjEventsPipeline, OUTPUT_PATH, CACHE_PATH, MIN_EXPECTED_EVENTS } = require("../lib/ocnjPipeline");

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

// Same minimal fake bucket shape as test/orchestration.test.js.
function makeFakeBucket(initialFiles) {
  const store = new Map(Object.entries(initialFiles || {}));
  function fileHandle(path) {
    return {
      path,
      async download() {
        if (!store.has(path)) {
          const err = new Error("not found");
          err.code = 404;
          throw err;
        }
        return [store.get(path)];
      },
      async save(buffer) {
        store.set(path, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
      }
    };
  }
  return { file: fileHandle, _store: store };
}

function readJson(bucket, path) {
  return JSON.parse(bucket._store.get(path).toString("utf8"));
}

// MIN_EXPECTED_EVENTS (15) worth of distinct-date PDF events, so the
// "happy path" tests clear the gate without also needing a real ICS feed.
function manyPdfEvents(text) {
  const lines = [];
  for (let day = 1; day <= 20; day++) {
    lines.push("JUNE " + day + " – Event Number " + day + ". Some description text here.");
  }
  return "Calendar of Events\n" + lines.join("\n") + "\nUpdated: 6/1/2026\n" + (text || "");
}

function icsWithNoEvents() {
  return "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//test//EN\r\nEND:VCALENDAR\r\n";
}

const CURATED_STUB = { content: [{ text: JSON.stringify({ days: [{ date: "2026-06-01", events: [{ title: "Event Number 1", time: null, location: null }] }] }) }] };

(async () => {
  await test("a healthy run publishes output to Storage and seeds the cache", async () => {
    const bucket = makeFakeBucket();
    const result = await runOcnjEventsPipeline({
      bucket,
      now: new Date("2026-06-01T00:00:00Z"),
      fetchPdfTextImpl: async () => manyPdfEvents(),
      fetchImpl: async () => ({ ok: true, text: async () => icsWithNoEvents() }),
      curateCallImpl: async () => CURATED_STUB
    });
    assert.strictEqual(result.status, "ok");
    const output = readJson(bucket, OUTPUT_PATH);
    assert.strictEqual(output.merged_event_count, 20);
    assert.strictEqual(output.days[0].events[0].title, "Event Number 1");
    const cache = readJson(bucket, CACHE_PATH);
    assert.deepStrictEqual(cache, output);
  });

  await test("one source failing (PDF down) still succeeds on the ICS-only path if enough events remain", async () => {
    const icsEvents = Array.from({ length: MIN_EXPECTED_EVENTS }, (_, i) => ({
      uid: "e" + i, summary: "Show " + i, dtstart: "2026070" + (i % 9 + 1) + "T190000"
    }));
    const body = icsEvents.map((e) => [
      "BEGIN:VEVENT", "UID:" + e.uid, "SUMMARY:" + e.summary, "DTSTART:" + e.dtstart, "END:VEVENT"
    ].join("\r\n")).join("\r\n");
    const ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//test//EN\r\n" + body + "\r\nEND:VCALENDAR\r\n";

    const bucket = makeFakeBucket();
    const result = await runOcnjEventsPipeline({
      bucket,
      now: new Date("2026-07-01T00:00:00Z"),
      fetchPdfTextImpl: async () => { throw new Error("ocnj.us unreachable"); },
      fetchImpl: async (url) => (String(url).includes("week") ? { ok: true, text: async () => ics } : { ok: true, text: async () => ics }),
      curateCallImpl: async () => CURATED_STUB
    });
    assert.strictEqual(result.status, "ok");
  });

  await test("both sources failing falls back to the last cached output rather than publishing near-nothing", async () => {
    const cachedOutput = { generated_at: "2026-05-30T09:00:00.000Z", sources: [], source_last_updated: null, merged_event_count: 22, days: [] };
    const bucket = makeFakeBucket({ [CACHE_PATH]: Buffer.from(JSON.stringify(cachedOutput)) });
    const result = await runOcnjEventsPipeline({
      bucket,
      now: new Date("2026-06-01T00:00:00Z"),
      fetchPdfTextImpl: async () => { throw new Error("ocnj.us unreachable"); },
      fetchImpl: async () => { throw new Error("oceancityvacation.com unreachable"); }
    });
    assert.strictEqual(result.status, "fallback");
    const output = readJson(bucket, OUTPUT_PATH);
    assert.strictEqual(output.merged_event_count, 22);
  });

  await test("both sources failing with NO cache at all is a real, reported error -- not a silent blank publish", async () => {
    const bucket = makeFakeBucket();
    const result = await runOcnjEventsPipeline({
      bucket,
      now: new Date("2026-06-01T00:00:00Z"),
      fetchPdfTextImpl: async () => { throw new Error("ocnj.us unreachable"); },
      fetchImpl: async () => { throw new Error("oceancityvacation.com unreachable"); }
    });
    assert.strictEqual(result.status, "error");
    assert.ok(!bucket._store.has(OUTPUT_PATH), "must not have written a blank/partial output file");
  });

  await test("a malformed LLM response falls back to cache rather than publishing garbage", async () => {
    const cachedOutput = { generated_at: "2026-05-30T09:00:00.000Z", sources: [], source_last_updated: null, merged_event_count: 22, days: [] };
    const bucket = makeFakeBucket({ [CACHE_PATH]: Buffer.from(JSON.stringify(cachedOutput)) });
    const result = await runOcnjEventsPipeline({
      bucket,
      now: new Date("2026-06-01T00:00:00Z"),
      fetchPdfTextImpl: async () => manyPdfEvents(),
      fetchImpl: async () => ({ ok: true, text: async () => icsWithNoEvents() }),
      curateCallImpl: async () => ({ content: [{ text: "not json" }] })
    });
    assert.strictEqual(result.status, "fallback");
    assert.ok(result.reason.includes("LLM curation failed"));
  });

  await test("output's sources array names the exact PDF URL for the run's year and the ICS source label", async () => {
    const bucket = makeFakeBucket();
    await runOcnjEventsPipeline({
      bucket,
      now: new Date("2026-06-01T00:00:00Z"),
      fetchPdfTextImpl: async () => manyPdfEvents(),
      fetchImpl: async () => ({ ok: true, text: async () => icsWithNoEvents() }),
      curateCallImpl: async () => CURATED_STUB
    });
    const output = readJson(bucket, OUTPUT_PATH);
    assert.deepStrictEqual(output.sources, [
      "https://www.ocnj.us/media/Events/2026CalendarOfEvents.pdf",
      "oceancityvacation.com (weekly ICS)"
    ]);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
