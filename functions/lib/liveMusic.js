// Live Music card: today's live music schedule for the 30A corridor,
// from the "WaveClock Beach API" -- a real, documented REST API a
// customer's own developer built and deployed specifically for this app
// (unlike Beach Flags' 30a.com/beachflag/, which has no API and has to
// be scraped -- see lib/beachflag.js's own header comment). No API key
// is required at the moment; if one gets added later, MUSIC_API_KEY
// below is where it'd go (see the handoff doc's "Auth" section).
//
// Uses GET /v1/device specifically, not /v1/events -- it's the one
// endpoint the API's own docs describe as "one compact payload for the
// clock": pre-formatted clock-style times ("5:30-9:00P"), and venue/act
// strings the API itself caps at 26/34 characters, clearly sized with a
// small device screen in mind. This card ignores that payload's own
// `flag` field entirely -- Beach Flags already has its own, independently
// verified pipeline (lib/beachflag.js), and the two must never disagree
// about which one is "the" flag color source for a customer who has both
// enabled.
"use strict";

const MUSIC_API_BASE = "https://beach-api-741108980745.us-east1.run.app";

// This is the customer's own service, not a third-party site being
// scraped -- the handoff doc explicitly asks for a descriptive
// identifying User-Agent ("Send User-Agent: WaveClock/<version>
// (<contact>)"), the opposite of the browser-spoofing OUTBOUND_FETCH_HEADERS
// (lib/http.js) uses for sites that block obviously-a-script requests.
const MUSIC_API_HEADERS = {
  "User-Agent": "WaveClock/1.0 (+https://waveclock.net)"
};

const CANVAS_WIDTH = 792;
const CANVAS_HEIGHT = 272;
const BANNER_HEIGHT = 48;
const FONT_BLOCK = "WC Countdown Block";
const FONT_SERIF = "WC Countdown Serif";

// How many rows the card actually has room to draw at a legible size --
// requesting exactly this many from the API (via music_limit) means no
// separate slicing step, and totalToday (from the response's own
// music_total) still tells us whether to show a "+N more" line.
const MAX_ROWS = 4;

function fitFontSize(ctx, text, maxWidth, family, maxSize, minSize) {
  for (let size = maxSize; size > minSize; size--) {
    ctx.font = size + "px \"" + family + "\"";
    if (ctx.measureText(text).width <= maxWidth) return size;
  }
  ctx.font = minSize + "px \"" + family + "\"";
  return minSize;
}

// Same truncateToFit as lib/beachflag.js -- shrinking a font only goes so
// far, and a venue/act pair can still be too wide for its row even at a
// reasonable size, so this clips with an ellipsis rather than overflow.
function truncateToFit(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let truncated = text;
  while (truncated.length > 1 && ctx.measureText(truncated.trim() + "…").width > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return truncated.trim() + "…";
}

// "2026-09-02T21:32:10-05:00" -> "9:32 PM". `gen` is already in
// America/Chicago (the API's own fixed time zone, per the handoff doc's
// "Conventions" section) -- formatting through that zone explicitly
// rather than trusting the environment's local zone to happen to match.
function formatGeneratedAtLabel(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit", hour12: true }).format(d);
}

// Zero events today is a real, ordinary state (off-season, a rained-out
// evening, or simply nothing left once `from_now` drops today's already-
// finished shows) -- not an error, so this never throws for that. It DOES
// throw on an actual fetch/parse failure (non-2xx, unreachable, or a
// response missing the `music` array this card depends on), same as
// every other data source in this app: a real failure should retry next
// run, not silently publish stale-looking blank content.
async function fetchMusicEventsCardData(fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const params = new URLSearchParams({ music_limit: String(MAX_ROWS + 1) });
  const resp = await doFetch(MUSIC_API_BASE + "/v1/device?" + params.toString(), { headers: MUSIC_API_HEADERS });
  if (!resp.ok) throw new Error("Live music fetch failed: " + resp.status);
  const data = await resp.json();
  if (!data || !Array.isArray(data.music)) throw new Error("Unexpected live music response shape (no music[] array)");

  const events = data.music.map((m) => ({
    range: m.r || null,
    venue: m.v || null,
    act: m.a || null
  }));
  const totalToday = typeof data.music_total === "number" ? data.music_total : events.length;

  return {
    events,
    totalToday,
    stale: !!(data.stale && data.stale.music),
    generatedAtLabel: formatGeneratedAtLabel(data.gen)
  };
}

// Card layout: black banner (matching every other Custom Screen layer)
// reads "LIVE MUSIC TODAY"; the body lists up to MAX_ROWS shows (time
// range, venue, act) at a size meant to be read at a glance, not
// squinted at -- a "+N more today" line takes the place of a row only
// when there's genuinely more than fits. No events at all falls back to
// a plain "no live music" message instead of an empty-looking card.
// Draws directly onto an already-composited ctx, same contract as
// drawTideCard/drawNewsCard/drawBeachFlagCard -- compositeAndPack in
// dynamic.js owns creating the canvas and packing the result.
function drawMusicCard(ctx, data) {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, CANVAS_WIDTH, BANNER_HEIGHT);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const bannerTitle = "LIVE MUSIC TODAY";
  const bannerSize = fitFontSize(ctx, bannerTitle, CANVAS_WIDTH - 40, FONT_BLOCK, 30, 20);
  ctx.font = bannerSize + "px \"" + FONT_BLOCK + "\"";
  ctx.fillText(bannerTitle, CANVAS_WIDTH / 2, BANNER_HEIGHT / 2 + Math.round(bannerSize * 0.35));

  if (!data.events.length) {
    ctx.textAlign = "center";
    ctx.fillStyle = "#000";
    ctx.font = "26px \"" + FONT_SERIF + "\"";
    ctx.fillText("No live music scheduled today", CANVAS_WIDTH / 2, BANNER_HEIGHT + (CANVAS_HEIGHT - BANNER_HEIGHT) / 2 + 8);
  } else {
    const leftX = 40;
    const timeColWidth = 168;
    const detailX = leftX + timeColWidth;
    const detailMaxWidth = CANVAS_WIDTH - detailX - 32;
    const rowStep = 40;
    let y = BANNER_HEIGHT + 46;

    const shown = data.events.slice(0, MAX_ROWS);
    const moreCount = Math.max(0, data.totalToday - shown.length);
    shown.forEach((event, i) => {
      const isLastRowWithMore = i === MAX_ROWS - 1 && moreCount > 0;
      ctx.textAlign = "left";
      ctx.fillStyle = "#000";
      ctx.font = "600 22px \"" + FONT_SERIF + "\"";
      if (event.range) ctx.fillText(event.range, leftX, y);

      const detailParts = [];
      if (event.venue) detailParts.push(event.venue.toUpperCase());
      if (event.act) detailParts.push(event.act);
      const detailText = detailParts.join(" — ");
      if (detailText) {
        ctx.font = "22px \"" + FONT_SERIF + "\"";
        ctx.fillText(truncateToFit(ctx, detailText, detailMaxWidth), detailX, y);
      }
      y += rowStep;

      if (isLastRowWithMore) {
        ctx.textAlign = "left";
        ctx.fillStyle = "#444";
        ctx.font = "italic 20px \"" + FONT_SERIF + "\"";
        ctx.fillText("+ " + moreCount + " more today", leftX, y);
      }
    });
  }

  if (data.generatedAtLabel) {
    ctx.textAlign = "right";
    ctx.font = "11px \"" + FONT_SERIF + "\"";
    ctx.fillStyle = "#444";
    const label = "Updated " + data.generatedAtLabel + (data.stale ? " (may be delayed)" : "");
    ctx.fillText(label, CANVAS_WIDTH - 24, CANVAS_HEIGHT - 10);
  }
}

module.exports = {
  MUSIC_API_BASE,
  fetchMusicEventsCardData,
  drawMusicCard
};
