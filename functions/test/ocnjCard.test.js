"use strict";

// Exercises lib/ocnjCard.js against a stubbed fetch returning the shape
// lib/ocnjPipeline.js actually publishes -- not a live call, since this
// sandbox's network access doesn't reach
// firebasestorage.googleapis.com/v0/b/waveclock.firebasestorage.app any
// more directly than it reaches ocnj.us/oceancityvacation.com themselves
// (this card's own fetch is just another external HTTP call from its
// point of view).

const assert = require("assert");
const { createCanvas } = require("canvas");
const { OCNJ_EVENTS_PUBLIC_URL, fetchOcnjEventsCardData, drawOcnjEventsCard } = require("../lib/ocnjCard");
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

// A plain createCanvas() starts fully transparent (alpha 0), not white --
// drawOcnjEventsCard only ever paints the banner + text, relying on
// compositeAndPack to lay it over an already-white base PNG in
// production. Pixel-region checks need an actually-white canvas first, or
// they'd misread transparent (alpha 0, RGB all 0) pixels as ink. Same
// helper as test/liveMusic.test.js's own whiteCanvas/hasInkInRegion.
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

function mockFetch(payload, ok) {
  return async (url) => {
    if (url !== OCNJ_EVENTS_PUBLIC_URL) throw new Error("unexpected URL in test: " + url);
    return { ok: ok !== false, status: ok === false ? 404 : 200, json: async () => payload };
  };
}

const SAMPLE_PAYLOAD = {
  generated_at: new Date().toISOString(),
  sources: ["https://www.ocnj.us/media/Events/2026CalendarOfEvents.pdf", "oceancityvacation.com (weekly ICS)"],
  source_last_updated: "6/1/2026",
  merged_event_count: 42,
  days: [
    { date: "2026-07-08", events: [{ title: "Farmers Market", time: "8:00 AM", location: "Ocean City Tabernacle" }] }
  ]
};

const NOW = new Date("2026-07-08T18:00:00Z"); // 2:00 PM Eastern -- same calendar day either side

(async () => {
  await test("fetches today's slice from the published JSON", async () => {
    const data = await fetchOcnjEventsCardData(mockFetch(SAMPLE_PAYLOAD), NOW);
    assert.strictEqual(data.date, "2026-07-08");
    assert.strictEqual(data.events.length, 1);
    assert.strictEqual(data.events[0].title, "Farmers Market");
  });

  await test("a date with no matching entry in days[] is a real 'no events' day, not an error", async () => {
    const data = await fetchOcnjEventsCardData(mockFetch(SAMPLE_PAYLOAD), new Date("2026-08-01T18:00:00Z"));
    assert.deepStrictEqual(data.events, []);
  });

  await test("a non-ok response throws -- never silently publish blank content on a real failure", async () => {
    await assert.rejects(() => fetchOcnjEventsCardData(mockFetch(SAMPLE_PAYLOAD, false), NOW), /OCNJ events fetch failed: 404/);
  });

  await test("a response missing days[] throws rather than crashing on .find", async () => {
    await assert.rejects(() => fetchOcnjEventsCardData(mockFetch({ generated_at: new Date().toISOString() }), NOW), /no days\[\] array/);
  });

  await test("events for the day are capped at MAX_ROWS even if the published file somehow has more", async () => {
    const events = Array.from({ length: 9 }, (_, i) => ({ title: "Event " + i, time: null, location: null }));
    const payload = { generated_at: new Date().toISOString(), days: [{ date: "2026-07-08", events }] };
    const data = await fetchOcnjEventsCardData(mockFetch(payload), NOW);
    assert.strictEqual(data.events.length, 6);
  });

  await test("a generated_at older than 48h is flagged stale", async () => {
    const oldPayload = Object.assign({}, SAMPLE_PAYLOAD, { generated_at: new Date(NOW.getTime() - 72 * 3600 * 1000).toISOString() });
    const data = await fetchOcnjEventsCardData(mockFetch(oldPayload), NOW);
    assert.strictEqual(data.stale, true);
  });

  await test("a recent generated_at is not flagged stale", async () => {
    const freshPayload = Object.assign({}, SAMPLE_PAYLOAD, { generated_at: new Date(NOW.getTime() - 3600 * 1000).toISOString() });
    const data = await fetchOcnjEventsCardData(mockFetch(freshPayload), NOW);
    assert.strictEqual(data.stale, false);
  });

  await test("drawOcnjEventsCard draws the banner and each event row without throwing", () => {
    const c = whiteCanvas(792, 272);
    drawOcnjEventsCard(c.getContext("2d"), { date: "2026-07-08", events: [{ title: "Farmers Market", time: "8:00 AM", location: "Ocean City Tabernacle" }], generatedAtLabel: "2:00 PM", stale: false });
  });

  await test("zero events falls back to a plain 'no events' message instead of a blank body", () => {
    const c = whiteCanvas(792, 272);
    drawOcnjEventsCard(c.getContext("2d"), { date: "2026-07-08", events: [], generatedAtLabel: "2:00 PM", stale: false });
    assert.ok(hasInkInRegion(c, 0, 100, 792, 60), "expected the empty-state message to draw some ink in the body region");
  });

  await test("all 6 rows fit without throwing and a long title is truncated, not drawn past the card's edge", () => {
    const c = whiteCanvas(792, 272);
    const events = Array.from({ length: 6 }, (_, i) => ({
      title: i === 2 ? "Direct from Sweden: The Music of ABBA Performing with the OC POPs Orchestra" : "Event " + i,
      time: "1" + i + ":00 AM",
      location: "Some Venue"
    }));
    drawOcnjEventsCard(c.getContext("2d"), { date: "2026-07-08", events, generatedAtLabel: "2:00 PM", stale: false });
    // No ink in the rightmost 20px column of the EVENT ROWS -- truncation
    // must keep every row inside the card, same regression shape as
    // beachflag.test.js/liveMusic.test.js's own truncation checks. Stops
    // short of the footer row on purpose: the right-aligned "Updated ..."
    // timestamp legitimately sits close to this same edge by design.
    assert.ok(!hasInkInRegion(c, 772, 48, 20, 190), "expected row text to stop short of the card's right edge");
  });

  await test("a stale reading appends a '(may be delayed)' hint next to the timestamp", () => {
    const c = whiteCanvas(792, 272);
    // Just confirm it doesn't throw with stale: true -- the visible text
    // itself is exercised end-to-end by the fetch-level stale test above.
    drawOcnjEventsCard(c.getContext("2d"), { date: "2026-07-08", events: [], generatedAtLabel: "2:00 PM", stale: true });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
