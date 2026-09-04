// Merges the two parsed sources into one event pool before curation:
//   - ocnjCalendar.js -> town PDF events (messy titles, regex-extracted)
//   - ocnjIcs.js       -> Chamber ICS events (clean titles/times/locations)
//
// WHY DEDUP HAS TO HAPPEN HERE, NOT IN THE LLM STEP: both sources cover
// overlapping ground -- e.g. "Direct from Sweden: The Music of ABBA..."
// shows up in both the town's PDF and the Chamber's ICS feed, worded
// almost identically. Feeding the LLM two near-duplicate entries for the
// same show risks it either double-counting them toward the 6-per-day cap,
// or picking one arbitrarily and losing the ICS version's precise time/
// location. Doing exact/fuzzy dedup here, in code, means the LLM only ever
// sees one clean record per real-world event.
//
// STRATEGY: group both sources' events by date; within a date, compare
// every PDF event's title against every ICS event's title by longest
// common substring relative to the shorter title; on a match, keep the
// ICS record (clean title/time/location) but fall back to the PDF's
// description if the ICS one is thin. No match: keep as-is, tagged with
// its single source.
//
// Ported from the customer-provided merge_sources.py (2 Sep 2026 handoff).
// The recurring-weekday blocks from ocnjCalendar.js are intentionally NOT
// included here -- the ICS feed already lists each real occurrence of
// those recurring events as its own clean, dated record.
"use strict";

const TITLE_MATCH_THRESHOLD = 0.75;
const MIN_USABLE_DESCRIPTION_LEN = 20; // below this, treat as "effectively empty"

// Plain substring-containment scoring (rather than a generic diff ratio)
// avoids penalizing matches where one string has a long garbage tail --
// the PDF parser's naive title-splitting produces exactly that
// ("Straight No Chaser" vs "Straight No Chaser The concert begins at 7:00
// p"). Longest common substring relative to the SHORTER title means a
// clean short title fully contained in a longer messy one still counts as
// a match.
function titleSimilarity(a, b) {
  a = a.toLowerCase().trim();
  b = b.toLowerCase().trim();
  const shorterLen = Math.min(a.length, b.length);
  if (shorterLen === 0) return 0.0;
  return longestCommonSubstringLength(a, b) / shorterLen;
}

function longestCommonSubstringLength(a, b) {
  let prev = new Array(b.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= a.length; i++) {
    const curr = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
        if (curr[j] > best) best = curr[j];
      }
    }
    prev = curr;
  }
  return best;
}

function groupByDate(events) {
  const grouped = new Map();
  for (const e of events) {
    if (!grouped.has(e.date)) grouped.set(e.date, []);
    grouped.get(e.date).push(e);
  }
  return grouped;
}

// pdfEvents: ocnjCalendar.js's singleDateEvents list
// icsEvents: ocnjIcs.js's events list
function mergeSources(pdfEvents, icsEvents) {
  const pdfByDate = groupByDate(pdfEvents);
  const icsByDate = groupByDate(icsEvents);

  const allDates = new Set([...pdfByDate.keys(), ...icsByDate.keys()]);
  const merged = [];

  for (const d of [...allDates].sort()) {
    const pdfDay = pdfByDate.get(d) || [];
    const icsDay = icsByDate.get(d) || [];
    const matchedPdfIndices = new Set();

    // ICS events win on match -- clean fields, exact time/location.
    for (const icsEvent of icsDay) {
      let bestMatchIdx = null;
      let bestScore = 0.0;
      for (let i = 0; i < pdfDay.length; i++) {
        if (matchedPdfIndices.has(i)) continue;
        const score = titleSimilarity(icsEvent.title, pdfDay[i].title);
        if (score > bestScore) {
          bestScore = score;
          bestMatchIdx = i;
        }
      }

      const seenIn = ["oceancityvacation.com"];
      let description = icsEvent.description || "";

      if (bestMatchIdx !== null && bestScore >= TITLE_MATCH_THRESHOLD) {
        matchedPdfIndices.add(bestMatchIdx);
        seenIn.push("ocnj.us");
        const pdfDescription = pdfDay[bestMatchIdx].description || "";
        // ICS descriptions are already clean prose; PDF descriptions are
        // regex-split and often start mid-sentence with garbage. Only fall
        // back to the PDF's description when the ICS one is too thin to
        // be useful -- length alone isn't a quality signal once titles
        // match, since the PDF's leftover tail text can be long AND messy.
        if (description.length < MIN_USABLE_DESCRIPTION_LEN && pdfDescription.length >= MIN_USABLE_DESCRIPTION_LEN) {
          description = pdfDescription;
        }
      }

      merged.push({
        date: d,
        title: icsEvent.title,
        time: icsEvent.startTime || null,
        location: icsEvent.location || null,
        description,
        isChamberEvent: icsEvent.isChamberEvent || false,
        sourceUrl: icsEvent.sourceUrl || null,
        seenInSources: seenIn
      });
    }

    // Any PDF events with no ICS match at all -- keep them, unmatched.
    for (let i = 0; i < pdfDay.length; i++) {
      if (matchedPdfIndices.has(i)) continue;
      merged.push({
        date: d,
        title: pdfDay[i].title,
        time: null,
        location: null,
        description: pdfDay[i].description || "",
        isChamberEvent: false,
        sourceUrl: null,
        seenInSources: ["ocnj.us"]
      });
    }
  }

  return merged;
}

module.exports = { mergeSources, titleSimilarity };
