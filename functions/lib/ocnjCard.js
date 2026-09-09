// OCNJ Events card: today's curated Ocean City, NJ events, read from the
// daily-refreshed data/ocnj-events.json this app's own OCNJ Events
// pipeline publishes (see lib/ocnjPipeline.js and functions/README.md's
// "OCNJ Events" section) -- NOT a live re-run of that pipeline. Re-fetching
// the town PDF, the Chamber's ICS feed, and re-curating with Claude on
// every card refresh would be slow and needlessly costly; the pipeline
// already does that once a day and leaves a small, cheap-to-read JSON
// file behind, so this card just reads that file, exactly the same way
// Live Music (lib/liveMusic.js) treats the customer's Beach API as its
// data source rather than re-deriving it.
"use strict";

// The same public Storage REST URL manage/index.html already uses for
// designs/{id}.bin (firebasestorage.googleapis.com/v0/b/.../o/...?alt=media,
// governed by a Firebase Storage security rule, not bucket-level object
// ACLs -- see the "OCNJ Events" README section for why data/*.json needs
// that same rule extended to it).
const OCNJ_EVENTS_PUBLIC_URL = "https://firebasestorage.googleapis.com/v0/b/waveclock.firebasestorage.app/o/data%2Focnj-events.json?alt=media";

const CANVAS_WIDTH = 792;
const CANVAS_HEIGHT = 272;
const BANNER_HEIGHT = 48;
const FONT_BLOCK = "WC Countdown Block";
const FONT_SERIF = "WC Countdown Serif";
const EVENT_TIME_ZONE = "America/New_York";

// How many upcoming events this card shows, total -- NOT per day. The
// pipeline's own curate()/curateWithoutAI() step already caps any one
// date at 6 (see lib/ocnjCurate.js's MAX_PER_DAY), but this card walks
// FORWARD across multiple days to fill its row budget (see
// fetchOcnjEventsCardData below), so MAX_ROWS is doing its own real
// truncation here too, not just relying on the upstream per-day cap.
const MAX_ROWS = 6;

// A run's generated_at older than this is the same "treat as stale, might
// be showing yesterday's events" signal the output contract documents for
// any consumer of data/ocnj-events.json.
const STALE_AFTER_MS = 48 * 60 * 60 * 1000;

function fitFontSize(ctx, text, maxWidth, family, maxSize, minSize) {
  for (let size = maxSize; size > minSize; size--) {
    ctx.font = size + "px \"" + family + "\"";
    if (ctx.measureText(text).width <= maxWidth) return size;
  }
  ctx.font = minSize + "px \"" + family + "\"";
  return minSize;
}

// Same truncateToFit as lib/liveMusic.js/lib/beachflag.js -- shrinking a
// font only goes so far, so this clips with an ellipsis rather than
// letting a long title/location run off the edge of the card.
function truncateToFit(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let truncated = text;
  while (truncated.length > 1 && ctx.measureText(truncated.trim() + "…").width > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return truncated.trim() + "…";
}

function todayInOceanCity(now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: EVENT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now || new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return get("year") + "-" + get("month") + "-" + get("day");
}

function formatGeneratedAtLabel(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", { timeZone: EVENT_TIME_ZONE, hour: "numeric", minute: "2-digit", hour12: true }).format(d);
}

// "2026-09-16" -> "9/16" -- each event's own date, since this card can
// now show events from several different upcoming days at once (see
// fetchOcnjEventsCardData below), not just today's. Plain string split
// rather than a Date/Intl round-trip: `dateStr` is already a plain
// YYYY-MM-DD calendar date with no time-of-day or timezone to get wrong,
// so parsing it as one avoids the DST-adjacent off-by-one-day bugs that
// exact kind of round-trip has caused elsewhere in this codebase.
function formatEventDateLabel(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.split("-");
  if (parts.length !== 3) return null;
  const month = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);
  if (!month || !day) return null;
  return month + "/" + day;
}

// Walks forward across data.days (today included) collecting events in
// date order until MAX_ROWS are gathered, tagging each with its own
// `date` -- "the next 6 events," not "up to 6 events today." A day with
// no curated events at all (or no days left before the published range
// ends) is a real, ordinary state (a slow news week, the range running
// out) -- not an error, same contract as Live Music's empty `events`
// array. This DOES throw on an actual fetch/parse failure (non-2xx,
// unreachable, or a response missing the `days` array this card depends
// on), so the scheduled job retries instead of publishing stale-looking
// blank content.
async function fetchOcnjEventsCardData(fetchImpl, now) {
  const doFetch = fetchImpl || fetch;
  const resp = await doFetch(OCNJ_EVENTS_PUBLIC_URL);
  if (!resp.ok) throw new Error("OCNJ events fetch failed: " + resp.status);
  const data = await resp.json();
  if (!data || !Array.isArray(data.days)) throw new Error("Unexpected OCNJ events response shape (no days[] array)");

  const today = todayInOceanCity(now);
  // Defensive sort -- curateWithoutAI() already emits days in date order,
  // but curate()'s Claude output has no such guarantee (the system prompt
  // asks for correct per-date content, not a sorted days[] array).
  const sortedDays = data.days.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const events = [];
  for (const day of sortedDays) {
    if (day.date < today) continue; // never show a day that's already passed
    for (const e of (Array.isArray(day.events) ? day.events : [])) {
      events.push({ date: day.date, title: e.title || null, time: e.time || null, location: e.location || null });
      if (events.length >= MAX_ROWS) break;
    }
    if (events.length >= MAX_ROWS) break;
  }

  const generatedAtMs = data.generated_at ? new Date(data.generated_at).getTime() : NaN;
  const nowMs = (now || new Date()).getTime();
  const stale = isNaN(generatedAtMs) ? true : (nowMs - generatedAtMs) > STALE_AFTER_MS;

  return {
    date: today,
    events,
    generatedAtLabel: formatGeneratedAtLabel(data.generated_at),
    stale
  };
}

// Row geometry mirrors lib/liveMusic.js's MAX_ROWS/ROW_START_Y/ROW_LAST_Y/
// ROW_STEP exactly (same card size, same "last row ends at h-24" baseline)
// -- see that file's own comment for why. No footer overflow line here,
// though: unlike Live Music, fetchOcnjEventsCardData above already walks
// forward across days to fill exactly up to MAX_ROWS real events (never
// more), so the footer row is only ever the "Updated ..." timestamp, not
// a "+N more" count.
const ROW_START_Y = BANNER_HEIGHT + 28;
const ROW_LAST_Y = CANVAS_HEIGHT - 24;
const ROW_STEP = Math.round((ROW_LAST_Y - ROW_START_Y) / (MAX_ROWS - 1));
const FOOTER_Y = CANVAS_HEIGHT - 10;

function drawOcnjEventsCard(ctx, data) {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, CANVAS_WIDTH, BANNER_HEIGHT);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const bannerTitle = "EVENTS IN OCEAN CITY, NJ";
  const bannerSize = fitFontSize(ctx, bannerTitle, CANVAS_WIDTH - 40, FONT_BLOCK, 30, 20);
  ctx.font = bannerSize + "px \"" + FONT_BLOCK + "\"";
  ctx.fillText(bannerTitle, CANVAS_WIDTH / 2, BANNER_HEIGHT / 2 + Math.round(bannerSize * 0.30));

  if (!data.events.length) {
    ctx.textAlign = "center";
    ctx.fillStyle = "#000";
    ctx.font = "26px \"" + FONT_SERIF + "\"";
    ctx.fillText("No upcoming events found", CANVAS_WIDTH / 2, BANNER_HEIGHT + (CANVAS_HEIGHT - BANNER_HEIGHT) / 2 + 8);
  } else {
    const leftX = 40;
    // Wide enough for "12/25  11:00 AM" (the longest realistic date+time
    // pairing) at this row's font/size without needing its own truncation.
    const timeColWidth = 200;
    const detailX = leftX + timeColWidth;
    const detailMaxWidth = CANVAS_WIDTH - detailX - 32;

    let y = ROW_START_Y;
    data.events.forEach((event) => {
      ctx.textAlign = "left";
      ctx.fillStyle = "#000";
      ctx.font = "600 22px \"" + FONT_SERIF + "\"";
      // Date always shows (this card now spans several upcoming days, not
      // just today) -- time joins it when known, e.g. "9/16  6:00 PM".
      const dateTimeParts = [formatEventDateLabel(event.date), event.time].filter(Boolean);
      if (dateTimeParts.length) ctx.fillText(dateTimeParts.join("  "), leftX, y);

      const detailParts = [];
      if (event.title) detailParts.push(event.title);
      if (event.location) detailParts.push(event.location);
      const detailText = detailParts.join(" — ");
      if (detailText) {
        ctx.font = "22px \"" + FONT_SERIF + "\"";
        ctx.fillText(truncateToFit(ctx, detailText, detailMaxWidth), detailX, y);
      }
      y += ROW_STEP;
    });
  }

  if (data.generatedAtLabel) {
    ctx.textAlign = "right";
    ctx.font = "11px \"" + FONT_SERIF + "\"";
    ctx.fillStyle = "#444";
    const label = "Updated " + data.generatedAtLabel + (data.stale ? " (may be delayed)" : "");
    ctx.fillText(label, CANVAS_WIDTH - 24, FOOTER_Y);
  }
}

module.exports = {
  OCNJ_EVENTS_PUBLIC_URL,
  MAX_ROWS,
  formatEventDateLabel,
  fetchOcnjEventsCardData,
  drawOcnjEventsCard
};
