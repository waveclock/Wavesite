// Beach Flag card: the daily beach-hazard flag color(s) for the 30A /
// South Walton, FL corridor, plus (when the device has a saved location)
// the town name, today's surf height, water temperature, and a
// simplified rip current risk estimate -- all from the same free
// NOAA/Open-Meteo pipeline the Tide card already uses (see
// ripCurrentRisk in lib/astro.js for the risk estimate's own caveat: it's
// an approximation, not the official NWS Beach Hazards Statement).
//
// There's no documented API for the flag color itself -- 30a.com/beachflag/
// is a single page (one URL, covers every town along 30A, not per-device)
// that renders it as plain visible text ("YELLOW: MEDIUM HAZARD", a
// separate "PURPLE: Marine Pests Present..." line when more than one flag
// is flying, "Last Refreshed: ..."). This strips the page down to text and
// pattern-matches those known phrases, the same "read the visible words"
// approach fetchHeadlines already uses for RSS in dynamic.js -- just over
// plain text instead of XML. More fragile than a real API: if 30a.com
// meaningfully redesigns that page, this parser will need an update.
"use strict";

const { OUTBOUND_FETCH_HEADERS } = require("./http");
const { fetchTideCardData } = require("./astro");

const BEACH_FLAG_URL = "https://30a.com/beachflag/";

const CANVAS_WIDTH = 792;
const CANVAS_HEIGHT = 272;
const BANNER_HEIGHT = 48;
// Matches Bungee-Regular / PT Serif, already registered once by
// ensureFontsRegistered() in dynamic.js (registerFont is a global
// side effect on the "canvas" package's font registry -- any file can
// reference these family names in ctx.font without re-registering or
// importing dynamic.js itself, avoiding a circular require).
const FONT_BLOCK = "WC Countdown Block";
const FONT_SERIF = "WC Countdown Serif";

// Order matters for the regex below: DOUBLE RED must be checked before
// RED, or "RED" would match inside "DOUBLE RED" first and leave a
// dangling "DOUBLE" behind.
const FLAG_PATTERNS = {
  GREEN: "dots",
  YELLOW: "lines",
  RED: "solid",
  "DOUBLE RED": "solid2",
  PURPLE: "cross"
};

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

// Every "COLOR: label" segment found becomes one active flag -- the page
// can show more than one at once (e.g. a hazard color plus a separate
// PURPLE marine-pest notice), so this doesn't stop at the first match.
function parseBeachFlagText(text) {
  const flags = [];
  const seen = new Set();
  const re = /\b(GREEN|YELLOW|DOUBLE RED|RED|PURPLE)\s*:\s*([^.]+?)(?=(?:\.\s*)|(?:\bLast (?:Refreshed|Changed)\s*:)|(?:\b(?:GREEN|YELLOW|DOUBLE RED|RED|PURPLE)\s*:)|$)/gi;
  let m;
  while ((m = re.exec(text))) {
    let color = m[1].toUpperCase().replace(/\s+/g, " ");
    if (seen.has(color)) continue;
    seen.add(color);
    const label = m[2].trim();
    if (label && label.toUpperCase() !== "N/A") flags.push({ color, label });
  }

  const refreshedMatch = text.match(/Last Refreshed:\s*([0-9/]+\s+[0-9:]+\s*(?:am|pm)?\s*[A-Z]{2,4})/i);

  return {
    flags,
    lastRefreshedText: refreshedMatch ? refreshedMatch[1].trim() : null
  };
}

async function fetchBeachFlagStatus(fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const resp = await doFetch(BEACH_FLAG_URL, { headers: OUTBOUND_FETCH_HEADERS });
  if (!resp.ok) throw new Error("Beach flag fetch failed: " + resp.status);
  const html = await resp.text();
  const parsed = parseBeachFlagText(stripHtml(html));
  if (!parsed.flags.length) throw new Error("No flag colors found on 30a.com/beachflag/ -- page format may have changed");
  return parsed;
}

// Combines the scraped flag status with wave-height/water-temp/rip-risk
// from the SAME free data fetchTideCardData already pulls for the Tide
// card at this device's own location. Those fields are a nice-to-have,
// not load-bearing -- the flag status is the whole point of this card, so
// a tide-data hiccup degrades the stats row rather than failing the card.
// townName is never fetched here -- it's whatever the caller already has
// on hand from the device's saved location (see resolveTideLocation in
// design/index.html / the -dynamic.json meta's own townName field), the
// same "just pass along what's already resolved" approach tideTimeline's
// meta.townName uses.
async function fetchBeachFlagCardData({ lat, lon, stationId, townName }, now, fetchImpl) {
  const [flagStatus, tideData] = await Promise.all([
    fetchBeachFlagStatus(fetchImpl),
    (lat != null && lon != null && stationId)
      ? fetchTideCardData({ lat, lon, stationId }, now, fetchImpl).catch(() => null)
      : Promise.resolve(null)
  ]);
  // swell/waterTempF/ripRisk live under tideData.weather (see
  // fetchTideCardData's return shape in astro.js), not top-level on the
  // card -- weather itself is already optional there (null on an
  // Open-Meteo outage).
  const weather = tideData && tideData.weather;
  return {
    flags: flagStatus.flags,
    lastRefreshedText: flagStatus.lastRefreshedText,
    townName: townName || null,
    swellHeightFt: weather && weather.swell ? weather.swell.heightFt : null,
    waterTempF: weather && weather.waterTempF != null ? weather.waterTempF : null,
    // See ripCurrentRisk in astro.js -- a simplified LOW/MODERATE/HIGH
    // approximation from wave height + period alone, not the official NWS
    // Beach Hazards Statement.
    ripRisk: weather ? weather.ripRisk : null
  };
}

// A pennant shape (rectangle with a triangular notch cut from the right
// edge) -- close enough to a real beach-safety flag at card scale, and
// simple enough to clip a fill pattern to. Double Red draws this twice,
// stacked, matching the real double-flag convention.
function flagPennantPath(ctx, x, y, w, h) {
  const notch = w * 0.24;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w - notch, y + h / 2);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.closePath();
}

// Draws one flag (pole + pennant) with a pattern standing in for color,
// since the device is 1-bit e-ink -- no red/yellow/green/purple to draw
// with, only black ink density. Sparse dots read as "calm" (green),
// dense crosshatch as "the odd one out" (purple/marine pests), solid
// black as maximum hazard (red / double red), mirroring how the real
// flags themselves read as calm-to-alarming at a glance.
function drawFlagIcon(ctx, x, y, w, h, pattern) {
  const poleX = x;
  ctx.strokeStyle = "#000";
  ctx.fillStyle = "#000";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(poleX, y - 6);
  ctx.lineTo(poleX, y + h + 6);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(poleX, y - 9, 3, 0, Math.PI * 2);
  ctx.fill();

  const fx = x, fy = y, fw = w, fh = h;
  ctx.save();
  flagPennantPath(ctx, fx, fy, fw, fh);
  ctx.clip();
  ctx.fillStyle = "#fff";
  ctx.fillRect(fx, fy, fw, fh);

  ctx.fillStyle = "#000";
  ctx.strokeStyle = "#000";
  if (pattern === "solid" || pattern === "solid2") {
    ctx.fillRect(fx, fy, fw, fh);
  } else if (pattern === "dots") {
    const step = 8;
    for (let yy = fy + 4; yy < fy + fh; yy += step) {
      for (let xx = fx + 4; xx < fx + fw; xx += step) {
        ctx.beginPath();
        ctx.arc(xx, yy, 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else if (pattern === "lines") {
    ctx.lineWidth = 2;
    for (let yy = fy + 4; yy < fy + fh; yy += 6) {
      ctx.beginPath();
      ctx.moveTo(fx, yy);
      ctx.lineTo(fx + fw, yy);
      ctx.stroke();
    }
  } else if (pattern === "cross") {
    ctx.lineWidth = 1.6;
    for (let d = -fh; d < fw + fh; d += 7) {
      ctx.beginPath();
      ctx.moveTo(fx + d, fy);
      ctx.lineTo(fx + d - fh, fy + fh);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(fx + fw - d, fy);
      ctx.lineTo(fx + fw - d + fh, fy + fh);
      ctx.stroke();
    }
  }
  ctx.restore();

  ctx.lineWidth = 3;
  ctx.strokeStyle = "#000";
  flagPennantPath(ctx, fx, fy, fw, fh);
  ctx.stroke();
}

function beachFlagBannerTitle(flags) {
  if (!flags.length) return "BEACH FLAGS";
  return flags.map((f) => f.color).join(" + ");
}

function fitFontSize(ctx, text, maxWidth, family, maxSize, minSize) {
  for (let size = maxSize; size > minSize; size--) {
    ctx.font = size + "px \"" + family + "\"";
    if (ctx.measureText(text).width <= maxWidth) return size;
  }
  ctx.font = minSize + "px \"" + family + "\"";
  return minSize;
}

// Same shrink-to-fit as fitFontSize, but measures WITH a font-weight
// prefix (e.g. "600", "700") included -- fitFontSize alone can't do this,
// and a bold face measures wider than the regular weight it'd otherwise
// be sized against, so sizing with one weight and drawing with another
// risks overflowing past maxWidth (found live: a long town name drawn
// bold after being sized unweighted ran off the right edge of the card).
function fitWeightedFontSize(ctx, text, maxWidth, family, weight, maxSize, minSize) {
  for (let size = maxSize; size > minSize; size--) {
    ctx.font = weight + " " + size + "px \"" + family + "\"";
    if (ctx.measureText(text).width <= maxWidth) return size;
  }
  ctx.font = weight + " " + minSize + "px \"" + family + "\"";
  return minSize;
}

// Shrinking the font only goes so far -- fitFontSize/fitWeightedFontSize
// both stop at a floor rather than keep shrinking indefinitely (the whole
// point of raising those floors was to stop using tiny, hard-to-read
// text), so a genuinely long string can still be wider than maxWidth even
// at the smallest allowed size. Call this AFTER settling on a final font
// (ctx.font already set) to clip with an ellipsis instead of letting it
// run off the edge of the card. Only ever needed for townName -- it's the
// one field on this card that's a customer's own free-text nickname
// rather than a short, bounded label from 30a.com or a fixed format this
// code composes itself.
function truncateToFit(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let truncated = text;
  while (truncated.length > 1 && ctx.measureText(truncated.trim() + "…").width > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return truncated.trim() + "…";
}

// Card layout: black banner (matching every other Custom Screen layer)
// names the active color(s); the body shows one flag icon per active
// color on the left, the primary hazard description and any secondary
// notices (e.g. a marine-pest line alongside the hazard color) on the
// right, and a small surf/water stat line at the bottom when available.
// Draws directly onto an already-composited ctx (base image + white
// background already in place), same contract as drawTideCard/
// drawNewsCard -- compositeAndPack in dynamic.js owns creating the
// canvas and packing the result, this only ever draws.
function drawBeachFlagCard(ctx, data) {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, CANVAS_WIDTH, BANNER_HEIGHT);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const bannerTitle = beachFlagBannerTitle(data.flags);
  const bannerSize = fitFontSize(ctx, bannerTitle, CANVAS_WIDTH - 40, FONT_BLOCK, 30, 20);
  ctx.font = bannerSize + "px \"" + FONT_BLOCK + "\"";
  ctx.fillText(bannerTitle, CANVAS_WIDTH / 2, BANNER_HEIGHT / 2 + Math.round(bannerSize * 0.35));

  // Bigger icons than the first cut (88x64, was 70x50) -- this card reads
  // at a glance from across a room, so both the icon and every label on
  // it (except the small "Updated ..." timestamp, which nobody needs to
  // read from a distance) should be as large as the layout can fit.
  const iconY = BANNER_HEIGHT + 36;
  const iconW = 88, iconH = 64;
  const doubleStackGap = 4; // real double-red flags fly tight together on one pole
  const iconMaxWidth = 264; // clear of the right column (textX below) with room to spare
  let iconX = 56;
  let maxIconBottomY = 0;
  const flags = data.flags.length ? data.flags : [{ color: "GREEN", label: "No current advisory" }];
  flags.forEach((f) => {
    const pattern = FLAG_PATTERNS[f.color] || "dots";
    let bottomY;
    if (f.color === "DOUBLE RED") {
      // Shorter than a single flag's iconH (64) -- two full-height
      // pennants stacked on one pole would leave no room below for the
      // caption + rip risk line within the card's fixed height, so this
      // pair is drawn a little more compact than a lone flag is.
      const stackH = 52;
      drawFlagIcon(ctx, iconX, iconY, iconW, stackH, pattern);
      drawFlagIcon(ctx, iconX, iconY + stackH + doubleStackGap, iconW, stackH, pattern);
      bottomY = iconY + stackH * 2 + doubleStackGap;
    } else {
      drawFlagIcon(ctx, iconX, iconY, iconW, iconH, pattern);
      bottomY = iconY + iconH;
    }
    ctx.textAlign = "center";
    ctx.fillStyle = "#000";
    ctx.font = "600 18px \"" + FONT_SERIF + "\"";
    ctx.fillText(f.color, iconX + iconW / 2, bottomY + 24);
    maxIconBottomY = Math.max(maxIconBottomY, bottomY);
    iconX += 150; // wide enough for the bigger icon above, no overlap with a second flag
  });

  // Rip current risk sits under the flags themselves, not buried in the
  // stats line with surf height/water temp -- it's a hazard reading, not
  // a nice-to-have stat, so it gets equal billing with the flag icons it
  // describes. Approximate, not the official NWS Beach Hazards Statement
  // -- see ripCurrentRisk's own comment in astro.js.
  if (data.ripRisk) {
    const ripText = "RIP RISK: " + data.ripRisk;
    ctx.textAlign = "left";
    ctx.fillStyle = "#000";
    fitWeightedFontSize(ctx, ripText, iconMaxWidth, FONT_SERIF, "700", 24, 18);
    ctx.fillText(ripText, 56, maxIconBottomY + 58);
  }

  const textX = 340;
  const textMaxWidth = CANVAS_WIDTH - textX - 32;
  let y = BANNER_HEIGHT + 46;
  ctx.textAlign = "left";
  ctx.fillStyle = "#000";

  // Town name, when the device has a saved location -- a label above the
  // hazard text, not the banner itself (the banner stays the flag
  // color(s), same as every card without a location set). A device's
  // town nickname is normally short, but shrink-to-fit (and, in the rare
  // case that's still not enough, truncateToFit) anyway rather than trust
  // it never runs long -- it's the customer's own free text, unlike every
  // other label on this card.
  if (data.townName) {
    let townText = data.townName.toUpperCase();
    const townSize = fitWeightedFontSize(ctx, townText, textMaxWidth, FONT_SERIF, "600", 28, 20);
    townText = truncateToFit(ctx, townText, textMaxWidth);
    ctx.fillStyle = "#444";
    ctx.fillText(townText, textX, y);
    ctx.fillStyle = "#000";
    y += townSize + 22;
  }

  // primaryLabel/secondary labels come from 30a.com's scraped page, not
  // this app's own fixed strings -- shrink-to-fit like townName above,
  // and same truncateToFit safety net for the rare label too long to fit
  // even at the smallest allowed size.
  let primaryLabel = flags[0].label.toUpperCase();
  const labelSize = fitFontSize(ctx, primaryLabel, textMaxWidth, FONT_BLOCK, 34, 22);
  ctx.font = labelSize + "px \"" + FONT_BLOCK + "\"";
  primaryLabel = truncateToFit(ctx, primaryLabel, textMaxWidth);
  ctx.fillText(primaryLabel, textX, y);
  y += labelSize + 20;

  // Secondary flag labels and the surf/water stat line both aim for
  // roughly the same size as the primary hazard label above (the "nice
  // size" this card is built around) -- just not drawn with FONT_BLOCK's
  // heavy display weight, so the primary label still reads as the one
  // headline.
  ctx.font = "30px \"" + FONT_SERIF + "\"";
  for (const f of flags.slice(1)) {
    ctx.fillText(truncateToFit(ctx, f.label, textMaxWidth), textX, y);
    y += 36;
  }

  const statParts = [];
  if (data.swellHeightFt != null) statParts.push("Surf " + data.swellHeightFt + " ft");
  if (data.waterTempF != null) statParts.push("Water " + data.waterTempF + "°F");
  if (statParts.length) {
    const statText = statParts.join("   ·   ");
    fitWeightedFontSize(ctx, statText, textMaxWidth, FONT_SERIF, "600", 28, 20);
    ctx.fillText(statText, textX, CANVAS_HEIGHT - 24);
  }

  if (data.lastRefreshedText) {
    ctx.textAlign = "right";
    ctx.font = "11px \"" + FONT_SERIF + "\"";
    ctx.fillStyle = "#444";
    ctx.fillText("Updated " + data.lastRefreshedText, CANVAS_WIDTH - 24, CANVAS_HEIGHT - 10);
  }
}

module.exports = {
  BEACH_FLAG_URL,
  stripHtml,
  parseBeachFlagText,
  fetchBeachFlagStatus,
  fetchBeachFlagCardData,
  drawFlagIcon,
  beachFlagBannerTitle,
  drawBeachFlagCard
};
