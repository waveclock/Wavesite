"use strict";

// Exercises lib/ocnjIcs.js against literal iCalendar text (the same format
// oceancityvacation.com's "The Events Calendar" WordPress plugin
// publishes) -- not a live fetch, since this sandbox's network access
// doesn't reach oceancityvacation.com (same situation as every other
// scraped/proxied source in this codebase).

const assert = require("assert");
const { fetchRange, parseIcsEvents, weekStartDates } = require("../lib/ocnjIcs");

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

function icsCalendar(events) {
  const body = events.map((e) => [
    "BEGIN:VEVENT",
    "UID:" + e.uid,
    "SUMMARY:" + e.summary,
    "DTSTART:" + e.dtstart,
    e.dtend ? "DTEND:" + e.dtend : null,
    e.location ? "LOCATION:" + e.location : null,
    e.description ? "DESCRIPTION:" + e.description : null,
    e.categories ? "CATEGORIES:" + e.categories : null,
    e.url ? "URL:" + e.url : null,
    "END:VEVENT"
  ].filter(Boolean).join("\r\n")).join("\r\n");
  return "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//test//EN\r\n" + body + "\r\nEND:VCALENDAR\r\n";
}

(async () => {
  await test("parses a timed VEVENT into the expected shape", () => {
    const ics = icsCalendar([{
      uid: "1@oceancityvacation.com",
      summary: "Direct from Sweden: The Music of ABBA",
      dtstart: "20260705T193000",
      dtend: "20260705T213000",
      location: "Music Pier\\, 825 Boardwalk\\, Ocean City\\, NJ",
      description: "ABBA tribute.",
      categories: "Chamber Event",
      url: "https://oceancityvacation.com/events-calendar/direct-from-sweden/"
    }]);
    const events = parseIcsEvents(ics);
    assert.strictEqual(events.length, 1);
    const e = events[0];
    assert.strictEqual(e.uid, "1@oceancityvacation.com");
    assert.strictEqual(e.title, "Direct from Sweden: The Music of ABBA");
    assert.strictEqual(e.date, "2026-07-05");
    assert.strictEqual(e.isChamberEvent, true);
    assert.ok(e.startTime, "expected a formatted start time, got " + e.startTime);
    assert.ok(e.location.includes("Music Pier"));
  });

  await test("a non-Chamber event's isChamberEvent is false", () => {
    const ics = icsCalendar([{
      uid: "2@oceancityvacation.com",
      summary: "Farmers Market",
      dtstart: "20260708T080000",
      categories: "Community"
    }]);
    const events = parseIcsEvents(ics);
    assert.strictEqual(events[0].isChamberEvent, false);
  });

  await test("an all-day event (VALUE=DATE) gets a null start/end time, not a garbage one", () => {
    const ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//test//EN\r\n" +
      "BEGIN:VEVENT\r\nUID:3@oceancityvacation.com\r\nSUMMARY:Beach Cleanup Day\r\n" +
      "DTSTART;VALUE=DATE:20260710\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    const events = parseIcsEvents(ics);
    assert.strictEqual(events[0].date, "2026-07-10");
    assert.strictEqual(events[0].startTime, null);
  });

  await test("a missing description/location comes back null/empty, not undefined or a crash", () => {
    const ics = icsCalendar([{ uid: "4@oceancityvacation.com", summary: "Mystery Event", dtstart: "20260701T100000" }]);
    const events = parseIcsEvents(ics);
    assert.strictEqual(events[0].location, null);
    assert.strictEqual(events[0].description, "");
  });

  await test("fetchRange dedupes by UID within a single fetched week and reports errors per-week without failing the whole range", async () => {
    let call = 0;
    const fetchImpl = async () => {
      call++;
      if (call === 2) throw new Error("simulated network failure");
      // Each week's occurrence of the recurring event gets its own UID
      // (call-numbered) -- that's the real feed's behavior and must NOT
      // be deduped away. The in-week duplicate (same UID twice in one
      // response) must be.
      const uid = "week" + call + "@oceancityvacation.com";
      return {
        ok: true,
        text: async () => icsCalendar([
          { uid, summary: "Farmers Market", dtstart: "20260706T080000" },
          { uid, summary: "Farmers Market", dtstart: "20260706T080000" }
        ])
      };
    };
    const result = await fetchRange(new Date("2026-07-01T00:00:00Z"), 3, fetchImpl);
    assert.strictEqual(result.eventCount, 2, "2 successful weeks x 1 deduped event each");
    assert.strictEqual(result.errors.length, 1);
    assert.ok(result.errors[0].includes("simulated network failure"));
  });

  await test("weekStartDates always lands on a Sunday and steps forward exactly 7 days at a time", () => {
    const weeks = weekStartDates(new Date("2026-07-08T12:00:00Z"), 3); // a Wednesday
    assert.strictEqual(weeks.length, 3);
    for (const d of weeks) assert.strictEqual(d.getUTCDay(), 0, d.toISOString());
    assert.strictEqual((weeks[1] - weeks[0]) / (24 * 3600 * 1000), 7);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
