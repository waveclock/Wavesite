"use strict";

// Exercises lib/liveMusic.js with a stubbed fetch (no live call to the
// customer's Beach API) -- built directly against the exact example
// payload in the handoff doc (2 Sep 2026), not a guess at the shape, but
// still never verified against the live service: this sandbox's network
// access doesn't reach beach-api-741108980745.us-east1.run.app (same
// situation as lib/beachflag.js's 30a.com scrape -- see that file's own
// header comment).

const assert = require("assert");
const { createCanvas } = require("canvas");
const { MUSIC_API_BASE, fetchMusicEventsCardData, drawMusicCard } = require("../lib/liveMusic");
const dynamic = require("../lib/dynamic");
dynamic.ensureFontsRegistered();

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

// Verbatim from the handoff doc's /v1/device example (examples/device.json),
// trimmed to the fields this card actually reads.
const SAMPLE_DEVICE_PAYLOAD = {
  gen: "2026-09-02T21:32:10-05:00",
  date: "2026-09-02",
  dow: "WED",
  flag: { c: "yellow purple", p: "yellow", h: "MEDIUM HAZARD", m: "Yellow / Purple: MEDIUM HAZARD - Moderate Surf and/or Moderate Currents Marine Pests Present.", t: "9:32P" },
  music: [
    { s: "5:30P", e: "9:00P", r: "5:30-9:00P", v: "Red Bar", a: "The Red Bar Jazz Band" }
  ],
  music_total: 11,
  stale: { flag: false, music: false }
};

function mockDeviceFetch(payload) {
  return async (url) => {
    const u = new URL(url);
    if (u.hostname !== new URL(MUSIC_API_BASE).hostname) throw new Error("unexpected host in test: " + u.hostname);
    if (u.pathname !== "/v1/device") throw new Error("unexpected path in test: " + u.pathname);
    return { ok: true, status: 200, json: async () => payload };
  };
}

function whiteCanvas(w, h) {
  const c = createCanvas(w, h);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  return c;
}

function hasInkInRegion(canvas, x, y, w, h) {
  const data = canvas.getContext("2d").getImageData(x, y, w, h).data;
  for (let i = 0; i < data.length; i += 4) { if (data[i] < 200) return true; }
  return false;
}

(async () => {
  console.log("fetchMusicEventsCardData");
  await test("parses the real /v1/device response shape end-to-end, ignoring its flag field entirely", async () => {
    const data = await fetchMusicEventsCardData(mockDeviceFetch(SAMPLE_DEVICE_PAYLOAD));
    assert.strictEqual(data.events.length, 1);
    assert.deepStrictEqual(data.events[0], { range: "5:30-9:00P", venue: "Red Bar", act: "The Red Bar Jazz Band" });
    assert.strictEqual(data.totalToday, 11);
    assert.strictEqual(data.stale, false);
    assert.strictEqual(data.generatedAtLabel, "9:32 PM");
    assert.ok(!("flag" in data), "expected the response's own flag field to be dropped -- Beach Flags has its own independent source");
  });
  await test("an empty music[] array is a real day-off state, not an error", async () => {
    const data = await fetchMusicEventsCardData(mockDeviceFetch(Object.assign({}, SAMPLE_DEVICE_PAYLOAD, { music: [], music_total: 0 })));
    assert.strictEqual(data.events.length, 0);
    assert.strictEqual(data.totalToday, 0);
  });
  await test("stale.music true is surfaced on the card data", async () => {
    const data = await fetchMusicEventsCardData(mockDeviceFetch(Object.assign({}, SAMPLE_DEVICE_PAYLOAD, { stale: { flag: false, music: true } })));
    assert.strictEqual(data.stale, true);
  });
  await test("a non-ok response throws -- never silently publish blank content on a real failure", async () => {
    await assert.rejects(() => fetchMusicEventsCardData(async () => ({ ok: false, status: 503 })));
  });
  await test("a response missing the music[] array throws rather than crashing on .map", async () => {
    await assert.rejects(() => fetchMusicEventsCardData(mockDeviceFetch({ gen: SAMPLE_DEVICE_PAYLOAD.gen })));
  });
  await test("a null/missing venue or act on one event doesn't break the others", async () => {
    const payload = Object.assign({}, SAMPLE_DEVICE_PAYLOAD, {
      music: [
        { s: "5:30P", e: "9:00P", r: "5:30-9:00P", v: null, a: "Acoustic Set" },
        { s: "6:00P", e: null, r: "6:00P", v: "Bud & Alleys", a: "Sunset Sessions" }
      ]
    });
    const data = await fetchMusicEventsCardData(mockDeviceFetch(payload));
    assert.strictEqual(data.events[0].venue, null);
    assert.strictEqual(data.events[1].act, "Sunset Sessions");
  });

  console.log("drawMusicCard");
  await test("draws the banner and each event row without throwing", () => {
    const c = whiteCanvas(792, 272);
    drawMusicCard(c.getContext("2d"), {
      events: [
        { range: "5:30-9:00P", venue: "Red Bar", act: "The Red Bar Jazz Band" },
        { range: "6:00-8:00P", venue: "Bud & Alleys", act: "Sunset Sessions Duo" }
      ],
      totalToday: 2,
      stale: false,
      generatedAtLabel: "9:32 PM"
    });
    assert.ok(hasInkInRegion(c, 0, 0, 792, 48), "expected the black banner to be drawn");
    assert.ok(hasInkInRegion(c, 40, 74, 700, 20), "expected the first event row to have ink");
    assert.ok(hasInkInRegion(c, 40, 114, 700, 20), "expected the second event row to have ink");
  });
  await test("zero events falls back to a plain 'no live music' message instead of a blank body", () => {
    const c = whiteCanvas(792, 272);
    drawMusicCard(c.getContext("2d"), { events: [], totalToday: 0, stale: false, generatedAtLabel: "9:32 PM" });
    assert.ok(hasInkInRegion(c, 0, 0, 792, 48), "expected the banner to still draw");
    assert.ok(hasInkInRegion(c, 150, 130, 500, 30), "expected the fallback message to have ink");
  });
  await test("more events than fit shows a '+N more today' line instead of overflowing rows", () => {
    const c = whiteCanvas(792, 272);
    drawMusicCard(c.getContext("2d"), {
      events: [
        { range: "5:30-9:00P", venue: "Red Bar", act: "Act One" },
        { range: "6:00-8:00P", venue: "Venue Two", act: "Act Two" },
        { range: "7:00-9:00P", venue: "Venue Three", act: "Act Three" },
        { range: "8:00-10:00P", venue: "Venue Four", act: "Act Four" }
      ],
      totalToday: 11,
      stale: false,
      generatedAtLabel: "9:32 PM"
    });
    // The 5th row slot (below the 4 drawn events) should carry the
    // "+N more" line, not be blank.
    assert.ok(hasInkInRegion(c, 40, 190, 300, 20), "expected a '+N more today' line below the last shown row");
  });
  await test("a venue/act pair too long to fit is truncated, not drawn past the card's edge", () => {
    const c = whiteCanvas(792, 272);
    drawMusicCard(c.getContext("2d"), {
      events: [{
        range: "5:30-9:00P",
        venue: "AJ's Grayton Beach Oyster House",
        act: "The Extremely Long Named Rock and Roll Cover Band Extravaganza"
      }],
      totalToday: 1,
      stale: false,
      generatedAtLabel: "9:32 PM"
    });
    assert.ok(!hasInkInRegion(c, 785, 74, 7, 20), "expected the row text to stop short of the card's right edge");
  });
  await test("a stale reading appends a '(may be delayed)' hint next to the timestamp", () => {
    const c = whiteCanvas(792, 272);
    drawMusicCard(c.getContext("2d"), {
      events: [{ range: "5:30-9:00P", venue: "Red Bar", act: "Jazz Trio" }],
      totalToday: 1,
      stale: true,
      generatedAtLabel: "9:32 PM"
    });
    assert.ok(hasInkInRegion(c, 550, 255, 220, 15), "expected the stale-hint timestamp line to have ink");
  });

  console.log("\n" + passed + " passed, " + failed + " failed");
  if (failed > 0) process.exit(1);
})();
