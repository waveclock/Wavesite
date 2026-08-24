"use strict";

// Dependency-free iCalendar (RFC 5545) VEVENT parser, scoped to exactly
// what TeamSnap's exported schedule feeds use -- no ICS-parsing
// dependency exists in functions/package.json (see parseRssHeadlines in
// dynamic.js for the same reasoning about RSS), and TeamSnap's feed
// shape is simple and stable enough not to need a general-purpose
// library.

const { OUTBOUND_FETCH_HEADERS } = require("./http");

// Only forwards to TeamSnap's own https .ics feeds, never an arbitrary
// URL a caller asks for -- same boundary espnProxy uses for its fixed
// CDN hostname, so this can't be used as an open relay to other sites.
function isTeamsnapIcsUrl(urlString) {
  let u;
  try {
    u = new URL(urlString);
  } catch (err) {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (!u.hostname.toLowerCase().endsWith(".teamsnap.com")) return false;
  if (!u.pathname.toLowerCase().endsWith(".ics")) return false;
  return true;
}

// RFC 5545 line "unfolding": a line break followed by a single space or
// tab is a continuation of the previous line, not a new content line.
// Real-world feeds vary on line endings, so this handles CRLF and bare
// LF alike, and drops blank lines.
function unfoldLines(icsText) {
  return icsText.replace(/\r\n/g, "\n").split("\n").reduce((lines, line) => {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length) {
      lines[lines.length - 1] += line.slice(1);
    } else if (line.length) {
      lines.push(line);
    }
    return lines;
  }, []);
}

// Just enough of RFC 5545's TEXT escaping to round-trip what TeamSnap
// actually sends in SUMMARY/LOCATION/DESCRIPTION -- backslash-escaped
// commas, semicolons, newlines, and backslashes.
function decodeIcsText(text) {
  return text
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

// Splits "NAME;PARAM=X;PARAM2=Y:value" into { name, params, value } --
// content lines can carry any number of ;PARAM=... segments before the
// first colon.
function parseContentLine(line) {
  const colonIdx = line.indexOf(":");
  if (colonIdx === -1) return null;
  const head = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const parts = head.split(";");
  const name = parts[0].toUpperCase();
  const params = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf("=");
    if (eq === -1) continue;
    params[parts[i].slice(0, eq).toUpperCase()] = parts[i].slice(eq + 1);
  }
  return { name, params, value };
}

// Resolves a TZID's UTC offset (in minutes) at a given approximate UTC
// instant, using the platform's own IANA tzdata via Intl rather than
// shipping a timezone database -- Node 20's built-in ICU carries full
// tzdata, so this works for any real zone name with no dependency.
function tzOffsetMinutes(tzid, approxUtc) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tzid,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  const parts = {};
  for (const p of dtf.formatToParts(approxUtc)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  const asIfUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second)
  );
  return (asIfUtc - approxUtc.getTime()) / 60000;
}

// Converts a wall-clock date/time in a named zone to the real UTC
// instant it represents: resolves the zone's offset from a first guess
// (the wall time treated as UTC), then re-resolves once more from that
// result. One pass is enough to be off by exactly the DST delta right
// around a transition; two passes lands correctly.
function zonedTimeToUtc(tzid, y, mo, d, h, mi, s) {
  const guess = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  const offset1 = tzOffsetMinutes(tzid, guess);
  const pass2 = new Date(guess.getTime() - offset1 * 60000);
  const offset2 = tzOffsetMinutes(tzid, pass2);
  return new Date(guess.getTime() - offset2 * 60000);
}

// Parses a DATE ("20260901") or DATE-TIME ("20260901T180000", optionally
// "Z"-suffixed) value, honoring VALUE=DATE and a TZID param. Returns
// { date: Date, allDay: boolean }, or null if the value matches neither
// shape.
function parseIcsDateTime(value, params) {
  if (params.VALUE === "DATE" || /^\d{8}$/.test(value)) {
    const m = value.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!m) return null;
    return { date: new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))), allDay: true };
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (z) {
    return { date: new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))), allDay: false };
  }
  if (params.TZID) {
    try {
      return { date: zonedTimeToUtc(params.TZID, Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s)), allDay: false };
    } catch (err) {
      // Unknown/invalid TZID (e.g. a Windows zone name ICU doesn't
      // recognize) -- fall through to floating-time handling below
      // rather than failing the whole event over one bad param.
    }
  }
  // Floating time, no zone info at all: treat the wall-clock numbers as
  // UTC rather than guessing a zone. Not "correct" for genuinely
  // floating time, but consistent and predictable, and TeamSnap feeds
  // always send either "Z" or a TZID in practice.
  return { date: new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))), allDay: false };
}

// Parses every VEVENT in an ICS feed into { uid, summary, location,
// description, start, end, allDay }, sorted by start time ascending.
// Deliberately ignores recurrence (RRULE) -- TeamSnap schedule feeds
// export one VEVENT per actual game/practice already, never a
// repeating rule to expand.
function parseIcsEvents(icsText) {
  const lines = unfoldLines(icsText);
  const events = [];
  let current = null;

  for (const rawLine of lines) {
    const line = parseContentLine(rawLine);
    if (!line) continue;

    if (line.name === "BEGIN" && line.value === "VEVENT") {
      current = {};
      continue;
    }
    if (line.name === "END" && line.value === "VEVENT") {
      if (current && current.start) {
        events.push({
          uid: current.uid || null,
          summary: current.summary ? decodeIcsText(current.summary) : "",
          location: current.location ? decodeIcsText(current.location) : "",
          description: current.description ? decodeIcsText(current.description) : "",
          start: current.start.date.toISOString(),
          end: current.end ? current.end.date.toISOString() : null,
          allDay: current.start.allDay
        });
      }
      current = null;
      continue;
    }
    if (!current) continue;

    switch (line.name) {
      case "UID": current.uid = line.value; break;
      case "SUMMARY": current.summary = line.value; break;
      case "LOCATION": current.location = line.value; break;
      case "DESCRIPTION": current.description = line.value; break;
      case "DTSTART": current.start = parseIcsDateTime(line.value, line.params); break;
      case "DTEND": current.end = parseIcsDateTime(line.value, line.params); break;
      default: break;
    }
  }

  events.sort((a, b) => a.start.localeCompare(b.start));
  return events;
}

// Pulls the feed's own calendar name (X-WR-CALNAME), if it set one, so a
// page can use it as a title -- callers fall back to their own default
// when a feed doesn't set it.
function parseIcsCalendarName(icsText) {
  for (const rawLine of unfoldLines(icsText)) {
    const line = parseContentLine(rawLine);
    if (line && line.name === "X-WR-CALNAME" && line.value.trim()) {
      return decodeIcsText(line.value.trim());
    }
  }
  return null;
}

// fetchImpl is injectable so tests never make a real network call, same
// convention as fetchNextGame/fetchHeadlines in dynamic.js.
async function fetchIcsSchedule(url, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const resp = await doFetch(url, { headers: OUTBOUND_FETCH_HEADERS });
  if (!resp.ok) {
    const err = new Error("Feed returned " + resp.status);
    err.status = resp.status;
    throw err;
  }
  const text = await resp.text();
  return { calendarName: parseIcsCalendarName(text), events: parseIcsEvents(text) };
}

module.exports = {
  isTeamsnapIcsUrl,
  unfoldLines,
  parseContentLine,
  decodeIcsText,
  parseIcsDateTime,
  parseIcsEvents,
  parseIcsCalendarName,
  fetchIcsSchedule
};
