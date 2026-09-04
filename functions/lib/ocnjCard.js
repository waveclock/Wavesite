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

// Same 6-per-day cap the pipeline's own curate() step already enforces
// (see lib/ocnjCurate.js's MAX_PER_DAY) -- this card never needs a "+N
// more" overflow line the way Live Music does, since the published JSON
// is guaranteed to already have at most 6 events for any one date.
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

// A day with no curated events at all is a real, ordinary state (a slow
// news week, or today just falling outside both sources' covered range)
// -- not an error, same contract as Live Music's empty `events` array.
// This DOES throw on an actual fetch/parse failure (non-2xx, unreachable,
// or a response missing the `days` array this card depends on), so the
// scheduled job retries instead of publishing stale-looking blank content.
async function fetchOcnjEventsCardData(fetchImpl, now) {
  const doFetch = fetchImpl || fetch;
  const resp = await doFetch(OCNJ_EVENTS_PUBLIC_URL);
  if (!resp.ok) throw new Error("OCNJ events fetch failed: " + resp.status);
  const data = await resp.json();
  if (!data || !Array.isArray(data.days)) throw new Error("Unexpected OCNJ events response shape (no days[] array)");

  const today = todayInOceanCity(now);
  const todayEntry = data.days.find((d) => d.date === today);
  const events = (todayEntry && Array.isArray(todayEntry.events) ? todayEntry.events : []).slice(0, MAX_ROWS);

  const generatedAtMs = data.generated_at ? new Date(data.generated_at).getTime() : NaN;
  const nowMs = (now || new Date()).getTime();
  const stale = isNaN(generatedAtMs) ? true : (nowMs - generatedAtMs) > STALE_AFTER_MS;

  return {
    date: today,
    events: events.map((e) => ({ title: e.title || null, time: e.time || null, location: e.location || null })),
    generatedAtLabel: formatGeneratedAtLabel(data.generated_at),
    stale
  };
}

// Row geometry mirrors lib/liveMusic.js's MAX_ROWS/ROW_START_Y/ROW_LAST_Y/
// ROW_STEP exactly (same card size, same "last row ends at h-24" baseline)
// -- see that file's own comment for why. No footer overflow line here,
// though: unlike Live Music, the published data is already capped at 6
// events for any date, so the full row budget is always real events, and
// the footer row is only ever the "Updated ..." timestamp.
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
  const bannerTitle = "TODAY IN OCEAN CITY";
  const bannerSize = fitFontSize(ctx, bannerTitle, CANVAS_WIDTH - 40, FONT_BLOCK, 30, 20);
  ctx.font = bannerSize + "px \"" + FONT_BLOCK + "\"";
  ctx.fillText(bannerTitle, CANVAS_WIDTH / 2, BANNER_HEIGHT / 2 + Math.round(bannerSize * 0.30));

  if (!data.events.length) {
    ctx.textAlign = "center";
    ctx.fillStyle = "#000";
    ctx.font = "26px \"" + FONT_SERIF + "\"";
    ctx.fillText("No events scheduled today", CANVAS_WIDTH / 2, BANNER_HEIGHT + (CANVAS_HEIGHT - BANNER_HEIGHT) / 2 + 8);
  } else {
    const leftX = 40;
    const timeColWidth = 168;
    const detailX = leftX + timeColWidth;
    const detailMaxWidth = CANVAS_WIDTH - detailX - 32;

    let y = ROW_START_Y;
    data.events.forEach((event) => {
      ctx.textAlign = "left";
      ctx.fillStyle = "#000";
      ctx.font = "600 22px \"" + FONT_SERIF + "\"";
      if (event.time) ctx.fillText(event.time, leftX, y);

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
  fetchOcnjEventsCardData,
  drawOcnjEventsCard
};
