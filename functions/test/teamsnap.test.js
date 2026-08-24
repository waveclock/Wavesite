"use strict";

// Unit tests for the dependency-free ICS parser in lib/teamsnap.js --
// no network involved, just feeding it sample feed text.

const assert = require("assert");
const {
  isTeamsnapIcsUrl,
  unfoldLines,
  parseIcsEvents,
  parseIcsCalendarName
} = require("../lib/teamsnap");

// A folded DESCRIPTION line (continuation starting with a single space,
// per RFC 5545) to exercise unfoldLines; a "Z" DTSTART; a TZID DTSTART
// during EDT (America/New_York, UTC-4 in September); and an all-day
// VALUE=DATE event.
const SAMPLE_ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//TeamSnap//Calendaring//EN",
  "X-WR-CALNAME:Riptide 12U Schedule",
  "BEGIN:VEVENT",
  "UID:111@teamsnap.com",
  "DTSTAMP:20260101T000000Z",
  "DTSTART:20260905T173000Z",
  "DTEND:20260905T190000Z",
  "SUMMARY:Practice",
  "LOCATION:Bayview Fields",
  "DESCRIPTION:Bring water\\, cleats\\, and a positive attitude! Coach will",
  "  send a reminder the night before.",
  "STATUS:CONFIRMED",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:222@teamsnap.com",
  "DTSTAMP:20260101T000000Z",
  "DTSTART;TZID=America/New_York:20260912T140000",
  "DTEND;TZID=America/New_York:20260912T153000",
  "SUMMARY:Game vs. Wildwood Sharks",
  "LOCATION:Ocean City Rec Complex\\, 800 Haven Ave\\, Ocean City\\, NJ",
  "STATUS:CONFIRMED",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:333@teamsnap.com",
  "DTSTART;VALUE=DATE:20260920",
  "SUMMARY:Team Photo Day",
  "END:VEVENT",
  "END:VCALENDAR"
].join("\r\n");

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok - " + name);
  } catch (err) {
    failed++;
    console.log("  FAIL - " + name);
    console.log("    " + err.message);
  }
}

test("isTeamsnapIcsUrl accepts a real ical-cdn.teamsnap.com feed", () => {
  assert.strictEqual(
    isTeamsnapIcsUrl("https://ical-cdn.teamsnap.com/team_schedule/bc5a413c-e630-470d-8537-0fd2d1d90720.ics"),
    true
  );
});

test("isTeamsnapIcsUrl rejects a non-teamsnap host", () => {
  assert.strictEqual(isTeamsnapIcsUrl("https://evil.example.com/x.ics"), false);
});

test("isTeamsnapIcsUrl rejects http (non-https)", () => {
  assert.strictEqual(isTeamsnapIcsUrl("http://ical-cdn.teamsnap.com/team_schedule/x.ics"), false);
});

test("isTeamsnapIcsUrl rejects a teamsnap URL that isn't a .ics feed", () => {
  assert.strictEqual(isTeamsnapIcsUrl("https://ical-cdn.teamsnap.com/team_schedule/x.json"), false);
});

test("isTeamsnapIcsUrl rejects a malformed URL", () => {
  assert.strictEqual(isTeamsnapIcsUrl("not a url"), false);
});

test("unfoldLines rejoins a continuation line into the line before it", () => {
  // The continuation line's leading character is purely a fold marker
  // and is dropped, not content -- so a real space in the original text
  // at the fold point has to appear on ONE side of the break already
  // (here, trailing on the first physical line) for it to survive
  // unfolding.
  const lines = unfoldLines("SUMMARY:Practice\r\nDESCRIPTION:Bring water and \r\n cleats.\r\nEND:VEVENT");
  assert.deepStrictEqual(lines, ["SUMMARY:Practice", "DESCRIPTION:Bring water and cleats.", "END:VEVENT"]);
});

test("parseIcsCalendarName reads X-WR-CALNAME", () => {
  assert.strictEqual(parseIcsCalendarName(SAMPLE_ICS), "Riptide 12U Schedule");
});

test("parseIcsCalendarName returns null when the feed doesn't set one", () => {
  assert.strictEqual(parseIcsCalendarName("BEGIN:VCALENDAR\r\nEND:VCALENDAR"), null);
});

test("parseIcsEvents parses all three events, sorted by start time", () => {
  const events = parseIcsEvents(SAMPLE_ICS);
  assert.strictEqual(events.length, 3);
  assert.deepStrictEqual(events.map((e) => e.uid), ["111@teamsnap.com", "222@teamsnap.com", "333@teamsnap.com"]);
});

test("a plain Z-suffixed DTSTART is parsed as that exact UTC instant", () => {
  const events = parseIcsEvents(SAMPLE_ICS);
  const practice = events.find((e) => e.uid === "111@teamsnap.com");
  assert.strictEqual(practice.start, "2026-09-05T17:30:00.000Z");
  assert.strictEqual(practice.end, "2026-09-05T19:00:00.000Z");
  assert.strictEqual(practice.allDay, false);
});

test("a folded DESCRIPTION line is unfolded and un-escaped", () => {
  const events = parseIcsEvents(SAMPLE_ICS);
  const practice = events.find((e) => e.uid === "111@teamsnap.com");
  assert.strictEqual(practice.description, "Bring water, cleats, and a positive attitude! Coach will send a reminder the night before.");
});

test("a TZID DTSTART is converted to the correct UTC instant (EDT, UTC-4)", () => {
  const events = parseIcsEvents(SAMPLE_ICS);
  const game = events.find((e) => e.uid === "222@teamsnap.com");
  assert.strictEqual(game.start, "2026-09-12T18:00:00.000Z");
  assert.strictEqual(game.summary, "Game vs. Wildwood Sharks");
  assert.strictEqual(game.location, "Ocean City Rec Complex, 800 Haven Ave, Ocean City, NJ");
});

test("a VALUE=DATE event is parsed as an all-day event with no time-of-day", () => {
  const events = parseIcsEvents(SAMPLE_ICS);
  const photoDay = events.find((e) => e.uid === "333@teamsnap.com");
  assert.strictEqual(photoDay.allDay, true);
  assert.strictEqual(photoDay.start, "2026-09-20T00:00:00.000Z");
  assert.strictEqual(photoDay.end, null);
});

test("an event with no DTSTART at all is skipped rather than crashing", () => {
  const events = parseIcsEvents("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:no-start\r\nSUMMARY:Broken\r\nEND:VEVENT\r\nEND:VCALENDAR");
  assert.strictEqual(events.length, 0);
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
