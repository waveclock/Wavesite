// Parser for the City of Ocean City, NJ official events calendar PDF.
//
// Source: https://www.ocnj.us/media/Events/{year}CalendarOfEvents.pdf
// This is the town's own published calendar (not a scrape of a third-party
// listings site), updated by city staff and dated at the bottom of the doc.
//
// Ported line-for-line from the customer-provided parse_calendar.py (2 Sep
// 2026 handoff) -- see that file's own header comment for WHY a dedicated
// parser exists instead of a generic one: PDF text extraction breaks
// ordinal suffixes onto their own line because they were superscripted in
// the source layout, e.g. "JUNE 3\nrd -- Farmers Market..." -- any parser
// for this source has to stitch that back together before it can find
// date boundaries.
"use strict";

const crypto = require("crypto");

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];
const MONTH_PATTERN = MONTHS.map((m) => m.toUpperCase()).join("|");
const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// Stitch split ordinal suffixes back onto their day number.
// "JUNE 3\nrd --" -> "JUNE 3rd --"
function normalizeText(rawText) {
  return rawText.replace(/(\d+)\s*\n\s*(st|nd|rd|th)\b/gi, "$1$2");
}

// Hash of the raw source text -- compare run-to-run: if it hasn't changed,
// the parser's last result is still valid; if it has, that's the cue to
// re-check the parser still handles the new layout.
function sourceFingerprint(rawText) {
  return crypto.createHash("sha256").update(rawText, "utf8").digest("hex").slice(0, 16);
}

function findLastUpdated(text) {
  const m = text.match(/Updated:\s*([\d/]+)/);
  return m ? m[1] : null;
}

// Return list of {month, text} blocks in document order.
function splitIntoMonthBlocks(text) {
  const pattern = new RegExp("\\b(" + MONTH_PATTERN + ")\\b", "gi");
  const matches = [];
  let m;
  while ((m = pattern.exec(text)) !== null) {
    matches.push({ month: m[1][0].toUpperCase() + m[1].slice(1).toLowerCase(), index: m.index });
  }
  const blocks = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    blocks.push({ month: matches[i].month, text: text.slice(start, end) });
  }
  return blocks;
}

// Entries like "JUNE 7th -- Title... description..." up to the next date
// marker or end of block.
function parseSingleDateEntries(monthText, monthName, year) {
  const entryStart = new RegExp(
    "\\b" + monthName.toUpperCase() + "\\s+(\\d{1,2})(?:st|nd|rd|th)?" +
    "(?:\\s*,\\s*(\\d{1,2})(?:st|nd|rd|th)?)*" + // additional comma-joined days
    "(?:\\s*(?:&|and)\\s*(\\d{1,2})(?:st|nd|rd|th)?)?" + // '& 8th'
    "\\s*[\u2013-]\\s*",
    "gi"
  );
  const matches = [];
  let m;
  while ((m = entryStart.exec(monthText)) !== null) {
    matches.push({ groups: [m[1], m[2], m[3]], start: m.index, end: entryStart.lastIndex });
  }

  const events = [];
  const monthIndex = MONTHS.indexOf(monthName);
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].end;
    const end = i + 1 < matches.length ? matches[i + 1].start : monthText.length;
    let body = monthText.slice(start, end).trim();
    body = body.replace(/\s+/g, " ");
    if (!body) continue;

    const dotIdx = body.indexOf(".");
    const title = dotIdx === -1 ? body : body.slice(0, dotIdx);
    const description = dotIdx === -1 ? "" : body.slice(dotIdx + 1);

    const days = matches[i].groups.filter(Boolean);
    for (const dayStr of days) {
      const day = parseInt(dayStr, 10);
      const eventDate = new Date(Date.UTC(year, monthIndex, day));
      // Skip malformed / out-of-range days rather than crash -- a day that
      // rolled into the next month (e.g. Feb 30) fails this check.
      if (eventDate.getUTCMonth() !== monthIndex || eventDate.getUTCDate() !== day) continue;
      events.push({
        date: isoDate(eventDate),
        title: title.trim().slice(0, 120),
        description: description.trim().slice(0, 400),
        recurring: false
      });
    }
  }
  return events;
}

// Entries like "JULY Every Monday\n<items until next weekday header>".
function parseRecurringEntries(monthText, monthName, year) {
  const header = new RegExp("\\b" + monthName.toUpperCase() + "\\s+Every\\s+(" + WEEKDAY_NAMES.join("|") + ")\\b", "gi");
  const matches = [];
  let m;
  while ((m = header.exec(monthText)) !== null) {
    matches.push({ weekday: m[1], start: header.lastIndex });
  }

  const events = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].start;
    const end = i + 1 < matches.length ? matches[i + 1].start : monthText.length;
    const body = monthText.slice(start, end).replace(/\s+/g, " ").trim();
    const weekday = matches[i].weekday[0].toUpperCase() + matches[i].weekday.slice(1).toLowerCase();
    events.push({
      weekday,
      month: monthName,
      year,
      rawItemsText: body.slice(0, 600),
      recurring: true
    });
  }
  return events;
}

function isoDate(d) {
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
}

function parseCalendar(rawText, year) {
  const text = normalizeText(rawText);
  const lastUpdated = findLastUpdated(text);
  const fingerprint = sourceFingerprint(rawText);

  const allSingle = [];
  const allRecurring = [];
  for (const block of splitIntoMonthBlocks(text)) {
    allSingle.push(...parseSingleDateEntries(block.text, block.month, year));
    allRecurring.push(...parseRecurringEntries(block.text, block.month, year));
  }

  return {
    source: "https://www.ocnj.us/media/Events/" + year + "CalendarOfEvents.pdf",
    sourceLastUpdated: lastUpdated,
    sourceFingerprint: fingerprint,
    singleDateEvents: allSingle,
    recurringEvents: allRecurring,
    parsedEventCount: allSingle.length
  };
}

module.exports = { parseCalendar, normalizeText, sourceFingerprint, findLastUpdated };
