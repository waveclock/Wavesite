// Second source: oceancityvacation.com -- the Ocean City Regional Chamber of
// Commerce / tourism site. Unlike the town's PDF, this site runs on "The
// Events Calendar" WordPress plugin, which publishes a real iCalendar (.ics)
// feed -- no text extraction, no regex date-boundary hunting, just parsing a
// well-defined, decades-old calendar format (via node-ical).
//
// WHY THIS SOURCE IS WORTH ADDING: the town's own PDF (ocnjCalendar.js)
// mostly covers city-run events. This site adds Chamber of Commerce and
// box-office events (concerts, theatre, etc.) with exact times and venues
// -- the two sources overlap but each has things the other doesn't.
//
// QUIRK OF THIS FEED: it's only exposed one week at a time
// (oceancityvacation.com/events/week/{date}/?ical=1) -- there's no single
// "get everything" endpoint, so this fetcher loops week by week over the
// date range wanted. Ported from the customer-provided
// source_oceancityvacation.py (2 Sep 2026 handoff).
"use strict";

const ical = require("node-ical");

const BASE_URL = "https://oceancityvacation.com/events/week/{date}/?ical=1";
const USER_AGENT = "WaveClockEventsBot/1.0 (contact: hello@waveclock.net)";
const EVENT_TIME_ZONE = "America/New_York";

function isoDateUTC(d) {
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
}

// This feed is keyed by week (Sunday-start), so step forward 7 days at a
// time from the most recent Sunday on/before `start`.
function weekStartDates(start, weeks) {
  const dates = [];
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  for (let i = 0; i < weeks; i++) {
    dates.push(new Date(d));
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return dates;
}

async function fetchWeekIcs(monday, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const url = BASE_URL.replace("{date}", isoDateUTC(monday));
  const resp = await doFetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!resp.ok) throw new Error("ICS fetch failed: " + resp.status);
  return resp.text();
}

// Formats a Date's wall-clock time in Ocean City's own timezone, e.g.
// "7:30 PM" -- matches the Python source's "%-I:%M %p" strftime.
function formatClockTime(date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: EVENT_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).format(date);
}

// Extracts the calendar date (YYYY-MM-DD) as seen in Ocean City's own
// timezone, not UTC -- an 11 PM Eastern event must not roll to the next
// UTC day.
function localCalendarDate(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: EVENT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return get("year") + "-" + get("month") + "-" + get("day");
}

function parseIcsEvents(icsText) {
  const parsed = ical.sync.parseICS(icsText);
  const events = [];
  for (const key of Object.keys(parsed)) {
    const component = parsed[key];
    if (component.type !== "VEVENT") continue;

    const dtstart = component.start;
    const dtend = component.end;
    const isDateOnly = component.datetype === "date";
    const categories = component.categories || [];

    events.push({
      uid: String(component.uid),
      title: String(component.summary || ""),
      // A date-only VALUE (an all-day event) is already the correct
      // calendar date as parsed -- treating it as a timestamp needing
      // Eastern-timezone conversion can roll it back a day (midnight UTC
      // is still the evening before in America/New_York).
      date: dtstart ? (isDateOnly ? isoDateUTC(dtstart) : localCalendarDate(dtstart)) : null,
      startTime: dtstart && !isDateOnly ? formatClockTime(dtstart) : null,
      endTime: dtend && !isDateOnly ? formatClockTime(dtend) : null,
      location: component.location ? String(component.location) : null,
      description: component.description ? String(component.description).slice(0, 400) : "",
      isChamberEvent: categories.includes("Chamber Event"),
      sourceUrl: component.url ? String(component.url) : null
    });
  }
  return events;
}

// Fetch `weeks` weeks of events starting from `start`, deduped by UID (the
// feed re-lists recurring events like Farmers Market every week, each with
// a distinct UID per occurrence -- that's correct, not a dupe).
async function fetchRange(start, weeks, fetchImpl) {
  const seenUids = new Set();
  const allEvents = [];
  const errors = [];

  for (const monday of weekStartDates(start, weeks == null ? 4 : weeks)) {
    try {
      const icsText = await fetchWeekIcs(monday, fetchImpl);
      for (const e of parseIcsEvents(icsText)) {
        if (!seenUids.has(e.uid)) {
          seenUids.add(e.uid);
          allEvents.push(e);
        }
      }
    } catch (err) {
      // One bad week shouldn't kill the whole fetch -- log it and keep
      // going with the weeks that did work.
      errors.push("week of " + isoDateUTC(monday) + ": " + err.message);
    }
  }

  return {
    source: "oceancityvacation.com",
    fetchedWeeks: weeks == null ? 4 : weeks,
    eventCount: allEvents.length,
    events: allEvents,
    errors
  };
}

module.exports = { fetchRange, parseIcsEvents, weekStartDates, EVENT_TIME_ZONE };
