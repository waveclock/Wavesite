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

// Simulates the real API actually respecting music_limit (returning at
// most that many items from the front of fullMusic) -- unlike
// mockDeviceFetch, which always hands back a fixed payload regardless of
// what was asked for. Also records the requested music_limit on
// `seenLimits` so a test can assert page 1 really asked for double.
function mockDeviceFetchCapped(fullMusic, totalToday, seenLimits) {
  return async (url) => {
    const u = new URL(url);
    if (u.hostname !== new URL(MUSIC_API_BASE).hostname) throw new Error("unexpected host in test: " + u.hostname);
    const limit = parseInt(u.searchParams.get("music_limit"), 10);
    if (seenLimits) seenLimits.push(limit);
    return {
      ok: true,
      status: 200,
      json: async () => Object.assign({}, SAMPLE_DEVICE_PAYLOAD, { music: fullMusic.slice(0, limit), music_total: totalToday })
    };
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

// The banner is white text on a black fill -- hasInkInRegion (dark
// pixels) can't tell the banner's own text apart from its background.
// This looks for the white glyphs instead, for the one test that needs
// to confirm exactly how far the banner title's text extends.
function hasWhiteInRegion(canvas, x, y, w, h) {
  const data = canvas.getContext("2d").getImageData(x, y, w, h).data;
  for (let i = 0; i < data.length; i += 4) { if (data[i] > 200) return true; }
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

  console.log("fetchMusicEventsCardData (page 1, \"Live Music (More Shows)\")");
  const TWELVE_EVENTS = Array.from({ length: 12 }, (_, i) => ({
    s: (i + 1) + ":00P", e: null, r: (i + 1) + ":00P", v: "Venue " + (i + 1), a: "Act " + (i + 1)
  }));
  await test("page defaults to 0 (page 0) and requests exactly MAX_ROWS from the API", async () => {
    const seenLimits = [];
    const data = await fetchMusicEventsCardData(mockDeviceFetchCapped(TWELVE_EVENTS, 12, seenLimits));
    assert.strictEqual(data.page, 0);
    assert.deepStrictEqual(seenLimits, [6]);
    assert.strictEqual(data.events.length, 6);
    assert.strictEqual(data.events[0].act, "Act 1");
  });
  await test("page 1 requests double the limit and returns events 7-12, not a repeat of 1-6", async () => {
    const seenLimits = [];
    const data = await fetchMusicEventsCardData(mockDeviceFetchCapped(TWELVE_EVENTS, 12, seenLimits), 1);
    assert.strictEqual(data.page, 1);
    assert.deepStrictEqual(seenLimits, [12]);
    assert.strictEqual(data.events.length, 6);
    assert.strictEqual(data.events[0].act, "Act 7");
    assert.strictEqual(data.events[5].act, "Act 12");
  });
  await test("page 1 with fewer than 7 events total comes back empty, not an out-of-range error", async () => {
    const data = await fetchMusicEventsCardData(mockDeviceFetchCapped(TWELVE_EVENTS.slice(0, 4), 4), 1);
    assert.strictEqual(data.page, 1);
    assert.strictEqual(data.events.length, 0);
    assert.strictEqual(data.totalToday, 4);
  });
  await test("totalToday on page 1 still reflects the grand total, so overflow math stays correct across pages", async () => {
    const data = await fetchMusicEventsCardData(mockDeviceFetchCapped(TWELVE_EVENTS, 15), 1);
    assert.strictEqual(data.totalToday, 15);
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
    assert.ok(hasInkInRegion(c, 40, 60, 700, 19), "expected the first event row to have ink");
    assert.ok(hasInkInRegion(c, 40, 94, 700, 16), "expected the second event row to have ink");
  });
  await test("zero events falls back to a plain 'no live music' message instead of a blank body", () => {
    const c = whiteCanvas(792, 272);
    drawMusicCard(c.getContext("2d"), { events: [], totalToday: 0, stale: false, generatedAtLabel: "9:32 PM" });
    assert.ok(hasInkInRegion(c, 0, 0, 792, 48), "expected the banner to still draw");
    assert.ok(hasInkInRegion(c, 150, 130, 500, 30), "expected the fallback message to have ink");
  });
  await test("page 1 banner reads 'MORE LIVE MUSIC TODAY', distinguishing it from page 0's own title", () => {
    const c0 = whiteCanvas(792, 272);
    drawMusicCard(c0.getContext("2d"), {
      page: 0,
      events: [{ range: "4:00-6:00P", venue: "The Bay", act: "Island Time Duo" }],
      totalToday: 1,
      stale: false,
      generatedAtLabel: "9:32 PM"
    });
    const c1 = whiteCanvas(792, 272);
    drawMusicCard(c1.getContext("2d"), {
      page: 1,
      events: [{ range: "4:00-6:00P", venue: "The Bay", act: "Island Time Duo" }],
      totalToday: 1,
      stale: false,
      generatedAtLabel: "9:32 PM"
    });
    // Measured off real renders: "LIVE MUSIC TODAY" (page 0)'s white text
    // never reaches past x=546, but "MORE LIVE MUSIC TODAY" (page 1) --
    // longer, so shrink-to-fit sizes it smaller, but it's still wide
    // enough to reach x=594. This band only lights up on page 1, so it
    // catches forgetting to key the banner text off data.page at all.
    assert.ok(!hasWhiteInRegion(c0, 550, 10, 44, 30), "expected page 0's shorter title to stop short of x=594");
    assert.ok(hasWhiteInRegion(c1, 550, 10, 44, 30), "expected page 1's longer title to reach x=594");
  });
  await test("page 1 with zero events on this page gets its own message, not the page-0 'no live music' wording", () => {
    const c = whiteCanvas(792, 272);
    drawMusicCard(c.getContext("2d"), { page: 1, events: [], totalToday: 6, stale: false, generatedAtLabel: "9:32 PM" });
    assert.ok(hasInkInRegion(c, 150, 130, 500, 30), "expected a fallback message to have ink");
  });
  await test("overflow shares the bottom footer row with the timestamp -- it does NOT cost one of the 6 event rows", () => {
    const c = whiteCanvas(792, 272);
    const sixEvents = [
      { range: "5:30-9:00P", venue: "Red Bar", act: "Act One" },
      { range: "6:00-8:00P", venue: "Venue Two", act: "Act Two" },
      { range: "7:00-9:00P", venue: "Venue Three", act: "Act Three" },
      { range: "8:00-10:00P", venue: "Venue Four", act: "Act Four" },
      { range: "6:30-9:30P", venue: "Venue Five", act: "Act Five" },
      { range: "7:30-10:30P", venue: "Venue Six", act: "Act Six" }
    ];
    drawMusicCard(c.getContext("2d"), { events: sixEvents, totalToday: 11, stale: false, generatedAtLabel: "9:32 PM" });
    // All 6 real events still get their own row -- the "+N more" line
    // doesn't displace one.
    assert.ok(hasInkInRegion(c, 40, 60, 700, 19), "expected the 1st event row to have ink");
    assert.ok(hasInkInRegion(c, 40, 230, 700, 19), "expected the 6th event row to still have ink");
    // The "+N more today" line shares the bottom footer row with the
    // "Updated ..." timestamp (left-aligned vs. its right-aligned) rather
    // than taking a 7th row slot -- measured off a real render: it sits
    // at x=40..~130, well clear of the timestamp's own x=550+.
    assert.ok(hasInkInRegion(c, 40, 250, 100, 16), "expected a '+N more today' line on the bottom footer row");
    assert.ok(!hasInkInRegion(c, 220, 250, 300, 16), "expected clear space between the '+N more' line and the timestamp");
  });
  await test("exactly 6 events fill every row with no '+N more' line", () => {
    const c = whiteCanvas(792, 272);
    const sixEvents = [
      { range: "5:30-9:00P", venue: "Red Bar", act: "The Red Bar Jazz Band" },
      { range: "6:00-8:00P", venue: "Bud & Alleys", act: "Sunset Sessions Duo" },
      { range: "7:00-10:00P", venue: "The Perfect Pig", act: "Kentucky Man" },
      { range: "8:00-11:00P", venue: "AJ's Grayton Beach", act: "Modern Eldorados" },
      { range: "6:30-9:30P", venue: "Shunk Gulley", act: "Coastal Cowboys" },
      { range: "7:30-10:30P", venue: "Bishops Bar", act: "Sandy Feet Trio" }
    ];
    drawMusicCard(c.getContext("2d"), { events: sixEvents, totalToday: 6, stale: false, generatedAtLabel: "9:32 PM" });
    // The 6th (last) row -- measured off a real render: its own ink runs
    // y=230..249, and the "Updated ..." timestamp's ink doesn't start
    // until y=253, so y=250..252 is genuine clear space between them.
    assert.ok(hasInkInRegion(c, 40, 230, 700, 19), "expected the 6th event row to have ink");
    const gapRow = c.getContext("2d").getImageData(40, 250, 700, 3).data;
    let allWhite = true;
    for (let i = 0; i < gapRow.length; i += 4) { if (gapRow[i] < 200) allWhite = false; }
    assert.ok(allWhite, "expected clear space between the 6th row and the 'Updated ...' timestamp");
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
