"use strict";

// Exercises lib/ocnjCalendar.js's PDF-text parser against sample text
// shaped like the real ocnj.us calendar's known quirks (ordinal suffixes
// split onto their own line by PDF extraction, "Every <weekday>" recurring
// blocks, an "Updated:" footer) -- not a live fetch of the real PDF, since
// this sandbox's network access doesn't reach ocnj.us (same situation as
// lib/beachflag.js's 30a.com scrape -- see that file's own header comment).

const assert = require("assert");
const { parseCalendar, normalizeText, findLastUpdated } = require("../lib/ocnjCalendar");

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

const SAMPLE_TEXT = `
Calendar of Events
JUNE 3
rd – Farmers Market. Fresh local produce at the Tabernacle lot.
JUNE 7th – Beach Volleyball Tournament. Pros and amateurs on 34th St. beach.
JULY 4th – Independence Day Celebration. Kite flying at 7pm, fireworks at 9pm.
JULY Every Monday
Sunset Yoga on the beach at 6:30am. Free! Bring your own mat.
Updated: 6/1/2026
`;

(async () => {
  await test("stitches a split ordinal suffix back onto its day number", () => {
    const normalized = normalizeText("JUNE 3\nrd – Farmers Market");
    assert.ok(normalized.includes("JUNE 3rd – Farmers Market"), normalized);
  });

  await test("finds the source's 'Updated:' footer date", () => {
    assert.strictEqual(findLastUpdated(SAMPLE_TEXT), "6/1/2026");
  });

  await test("parses single-date entries into ISO dates with title/description split on the first period", () => {
    const result = parseCalendar(SAMPLE_TEXT, 2026);
    const farmersMarket = result.singleDateEvents.find((e) => e.title.includes("Farmers Market"));
    assert.ok(farmersMarket, JSON.stringify(result.singleDateEvents));
    assert.strictEqual(farmersMarket.date, "2026-06-03");
    assert.ok(farmersMarket.description.includes("Fresh local produce"));
  });

  await test("parses a second single-date entry in the same month block", () => {
    const result = parseCalendar(SAMPLE_TEXT, 2026);
    const volleyball = result.singleDateEvents.find((e) => e.title.includes("Beach Volleyball"));
    assert.ok(volleyball);
    assert.strictEqual(volleyball.date, "2026-06-07");
  });

  await test("parses an entry in a later month block correctly (month blocks don't bleed into each other)", () => {
    const result = parseCalendar(SAMPLE_TEXT, 2026);
    const fourth = result.singleDateEvents.find((e) => e.title.includes("Independence Day"));
    assert.ok(fourth);
    assert.strictEqual(fourth.date, "2026-07-04");
  });

  await test("parses a recurring 'Every <weekday>' block separately from single-date events", () => {
    const result = parseCalendar(SAMPLE_TEXT, 2026);
    assert.strictEqual(result.recurringEvents.length, 1);
    assert.strictEqual(result.recurringEvents[0].weekday, "Monday");
    assert.ok(result.recurringEvents[0].rawItemsText.includes("Sunset Yoga"));
  });

  await test("an out-of-range day (e.g. rolled into the next month) is skipped, not crashed on", () => {
    const text = "FEBRUARY 30th – This day does not exist.\nUpdated: 1/1/2026";
    const result = parseCalendar(text, 2026);
    assert.strictEqual(result.singleDateEvents.length, 0);
  });

  await test("a month with no events at all yields an empty block without throwing", () => {
    const result = parseCalendar("Calendar of Events\nUpdated: 1/1/2026", 2026);
    assert.deepStrictEqual(result.singleDateEvents, []);
  });

  await test("source_fingerprint is stable for identical input and differs when the source text changes", () => {
    const a = parseCalendar(SAMPLE_TEXT, 2026);
    const b = parseCalendar(SAMPLE_TEXT, 2026);
    const c = parseCalendar(SAMPLE_TEXT + "\nextra text", 2026);
    assert.strictEqual(a.sourceFingerprint, b.sourceFingerprint);
    assert.notStrictEqual(a.sourceFingerprint, c.sourceFingerprint);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
