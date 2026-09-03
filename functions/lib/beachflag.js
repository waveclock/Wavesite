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
  const doubleStackGap = 6; // real double-red flags fly tight together on one pole
  let iconX = 56;
  const flags = data.flags.length ? data.flags : [{ color: "GREEN", label: "No current advisory" }];
  flags.forEach((f) => {
    const pattern = FLAG_PATTERNS[f.color] || "dots";
    drawFlagIcon(ctx, iconX, iconY, iconW, iconH, pattern);
    let bottomY = iconY + iconH;
    if (f.color === "DOUBLE RED") {
      drawFlagIcon(ctx, iconX, iconY + iconH + doubleStackGap, iconW, iconH, pattern);
      bottomY = iconY + iconH + doubleStackGap + iconH;
    }
    ctx.textAlign = "center";
    ctx.fillStyle = "#000";
    ctx.font = "600 16px \"" + FONT_SERIF + "\"";
    ctx.fillText(f.color, iconX + iconW / 2, bottomY + 26);
    iconX += 150; // wide enough for the bigger icon above, no overlap with a second flag
  });

  const textX = 340;
  const textMaxWidth = CANVAS_WIDTH - textX - 32;
  let y = BANNER_HEIGHT + 58;
  ctx.textAlign = "left";
  ctx.fillStyle = "#000";

  // Town name, when the device has a saved location -- a label above the
  // hazard text, not the banner itself (the banner stays the flag
  // color(s), same as every card without a location set). A device's
  // town nickname is normally short, but shrink-to-fit anyway (same as
  // the primary hazard label below) rather than trust it never runs long.
  if (data.townName) {
    const townText = data.townName.toUpperCase();
    const townSize = fitFontSize(ctx, townText, textMaxWidth, FONT_SERIF, 20, 15);
    ctx.font = townSize + "px \"" + FONT_SERIF + "\"";
    ctx.fillStyle = "#444";
    ctx.fillText(townText, textX, y);
    ctx.fillStyle = "#000";
    y += 36;
  }

  const primaryLabel = flags[0].label.toUpperCase();
  const labelSize = fitFontSize(ctx, primaryLabel, textMaxWidth, FONT_BLOCK, 34, 22);
  ctx.font = labelSize + "px \"" + FONT_BLOCK + "\"";
  ctx.fillText(primaryLabel, textX, y);
  y += labelSize + 18;

  ctx.font = "20px \"" + FONT_SERIF + "\"";
  for (const f of flags.slice(1)) {
    ctx.fillText(f.label, textX, y);
    y += 28;
  }

  const statParts = [];
  if (data.swellHeightFt != null) statParts.push("Surf " + data.swellHeightFt + " ft");
  if (data.waterTempF != null) statParts.push("Water " + data.waterTempF + "°F");
  // Approximate, not the official NWS Beach Hazards Statement -- see
  // ripCurrentRisk's own comment in astro.js.
  if (data.ripRisk) statParts.push("Rip Risk: " + data.ripRisk);
  if (statParts.length) {
    const statText = statParts.join("   ·   ");
    // Shrink-to-fit like the banner/primary label above -- unlike those,
    // this measures WITH the "600 " weight prefix included (fitFontSize
    // doesn't support one), since a bold face measures wider than the
    // regular weight it'd otherwise be sized against.
    let statSize = 22;
    while (statSize > 15) {
      ctx.font = "600 " + statSize + "px \"" + FONT_SERIF + "\"";
      if (ctx.measureText(statText).width <= textMaxWidth) break;
      statSize--;
    }
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
