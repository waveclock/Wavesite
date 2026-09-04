"use strict";

// Exercises lib/ocnjMerge.js's dedup logic. The core fixture (ABBA
// dedups across sources, Fourth of July is PDF-only, Farmers Market is
// ICS-only) is the exact smoke test from the customer's own
// merge_sources.py (2 Sep 2026 handoff), ported field-for-field so this
// test proves the JS port behaves identically to the reference script.

const assert = require("assert");
const { mergeSources, titleSimilarity } = require("../lib/ocnjMerge");

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

const pdfEvents = [
  {
    date: "2026-07-05",
    title: "Direct from Sweden: The Music of ABBA Performing with the OC POPs",
    description: "Some of Sweden's most experienced and talented singers deliver ABBA hits."
  },
  {
    date: "2026-07-04",
    title: "Fourth of July Celebration Kite flying competition",
    description: "Kite flying at 7pm, fireworks display tops off the evening at 9pm."
  }
];

const icsEvents = [
  {
    uid: "1",
    date: "2026-07-05",
    title: "Direct from Sweden: The Music of ABBA Performing with the OC POPs",
    startTime: "7:30 PM",
    endTime: "9:30 PM",
    location: "Music Pier, 825 Boardwalk, Ocean City, NJ",
    description: "ABBA tribute.",
    isChamberEvent: false,
    sourceUrl: "https://oceancityvacation.com/events-calendar/direct-from-sweden/"
  },
  {
    uid: "2",
    date: "2026-07-08",
    title: "Farmers Market",
    startTime: "8:00 AM",
    endTime: "12:00 PM",
    location: "Ocean City Tabernacle, 6th & Asbury Ave.",
    description: "Weekly farmers market.",
    isChamberEvent: true,
    sourceUrl: null
  }
];

(async () => {
  await test("a title matching across both sources keeps the ICS record's clean time/location", () => {
    const merged = mergeSources(pdfEvents, icsEvents);
    const abba = merged.find((e) => e.date === "2026-07-05");
    assert.ok(abba);
    assert.strictEqual(abba.time, "7:30 PM");
    assert.strictEqual(abba.location, "Music Pier, 825 Boardwalk, Ocean City, NJ");
    assert.deepStrictEqual(abba.seenInSources, ["oceancityvacation.com", "ocnj.us"]);
  });

  await test("a matched event with a thin ICS description falls back to the PDF's longer one", () => {
    const merged = mergeSources(pdfEvents, icsEvents);
    const abba = merged.find((e) => e.date === "2026-07-05");
    // ICS's "ABBA tribute." is under MIN_USABLE_DESCRIPTION_LEN (20 chars).
    assert.ok(abba.description.includes("Sweden's most experienced"), abba.description);
  });

  await test("a PDF-only event (no ICS match) is kept, tagged with just its own source", () => {
    const merged = mergeSources(pdfEvents, icsEvents);
    const fourth = merged.find((e) => e.date === "2026-07-04");
    assert.ok(fourth);
    assert.strictEqual(fourth.time, null);
    assert.deepStrictEqual(fourth.seenInSources, ["ocnj.us"]);
  });

  await test("an ICS-only event (no PDF match) is kept as-is with is_chamber_event carried through", () => {
    const merged = mergeSources(pdfEvents, icsEvents);
    const farmersMarket = merged.find((e) => e.date === "2026-07-08");
    assert.ok(farmersMarket);
    assert.strictEqual(farmersMarket.isChamberEvent, true);
    assert.deepStrictEqual(farmersMarket.seenInSources, ["oceancityvacation.com"]);
  });

  await test("merged output is sorted by date", () => {
    const merged = mergeSources(pdfEvents, icsEvents);
    const dates = merged.map((e) => e.date);
    assert.deepStrictEqual(dates, [...dates].sort());
  });

  await test("empty inputs on both sides return an empty merge, not a crash", () => {
    assert.deepStrictEqual(mergeSources([], []), []);
  });

  await test("titleSimilarity scores a short clean title fully contained in a longer messy one as a strong match", () => {
    const score = titleSimilarity("Straight No Chaser", "Straight No Chaser The concert begins at 7:00 p");
    assert.ok(score >= 0.75, "expected >= 0.75, got " + score);
  });

  await test("titleSimilarity scores two unrelated titles low", () => {
    const score = titleSimilarity("Farmers Market", "Fireworks on the Boardwalk");
    assert.ok(score < 0.5, "expected < 0.5, got " + score);
  });

  await test("two PDF events on the same day both competing for one ICS match only consume one of them", () => {
    const pdf = [
      { date: "2026-08-01", title: "Summer Concert Series", description: "Live music on the boardwalk." },
      { date: "2026-08-01", title: "Junior Lifeguard Games", description: "Kids' competition at the beach patrol tent." }
    ];
    const ics = [
      { uid: "x", date: "2026-08-01", title: "Summer Concert Series", startTime: "6:00 PM", description: "Concert.", isChamberEvent: false }
    ];
    const merged = mergeSources(pdf, ics);
    assert.strictEqual(merged.length, 2);
    const unmatched = merged.find((e) => e.title === "Junior Lifeguard Games");
    assert.ok(unmatched);
    assert.deepStrictEqual(unmatched.seenInSources, ["ocnj.us"]);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
