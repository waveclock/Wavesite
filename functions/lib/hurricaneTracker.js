// Hurricane Tracker card: the nearest active tropical system to a
// device's saved location, how far away it is right now, what it's
// forecast to be doing at its closest approach to this town, and a
// small track map.
//
// Data source: NHC's public CurrentStorms.json (no key, no auth --
// https://www.nhc.noaa.gov/CurrentStorms.json), the same free/official
// feed several open-source hurricane-tracking tools parse (e.g.
// OCHA-DAP/ds-nhc-forecast, the Weather::NHC::TropicalCyclone Perl
// module). Root shape: { activeStorms: [ { id, binNumber, name,
// classification, intensity, pressure, latitudeNumeric, longitudeNumeric,
// movementDir, movementSpeed, lastUpdate, forecastAdvisory: { advNum,
// issuance, url } }, ... ] }. intensity/pressure/movementSpeed are in
// knots per NHC convention. NOT confirmed against a live response from
// this dev sandbox (nhc.noaa.gov is blocked from here) -- same caveat as
// this codebase's ESPN integration, needs a real live check once
// deployed. Degrades to the "no active storm nearby" state on ANY
// shape mismatch rather than guessing wrong.
//
// The forecast TRACK (the numbered points on the card's map) is a
// second fetch, following forecastAdvisory.url to NHC's plain-text
// Forecast/Advisory (TCM) product and regex-matching its "FORECAST
// VALID" lines (e.g. "FORECAST VALID 11/0600Z 22.7N 62.7W" followed by
// "MAX WIND 120 KT...GUSTS 145 KT") -- real NHC forecast points, not a
// linear projection WaveClock makes up itself. That distinction matters
// for a safety-relevant card: showing a guessed path as if it were an
// official forecast would be actively misleading. If this fetch or
// parse fails, the card still shows the current position/intensity
// (which came from the first, simpler fetch) with no map/closest-
// approach section, rather than fabricating a path.
"use strict";

const CANVAS_WIDTH = 792;
const CANVAS_HEIGHT = 272;
const BANNER_HEIGHT = 40;
const PANEL_GAP = 8;
const PANEL_RADIUS = 18;
const FONT_BLOCK = "WC Countdown Block";
const FONT_SERIF = "WC Countdown Serif";

const NHC_CURRENT_STORMS_URL = "https://www.nhc.noaa.gov/CurrentStorms.json";

// Nothing further away than this ever gets shown -- a storm a couple
// thousand miles out in the open Atlantic isn't "your" hurricane alert
// yet. Generous on purpose (storms move fast and this only costs a
// second small text fetch, not a redraw of anything else).
const MAX_RELEVANT_MILES = 1200;

function fitFontSize(ctx, text, maxWidth, family, maxSize, minSize) {
  for (let size = maxSize; size > minSize; size--) {
    ctx.font = size + "px \"" + family + "\"";
    if (ctx.measureText(text).width <= maxWidth) return size;
  }
  ctx.font = minSize + "px \"" + family + "\"";
  return minSize;
}

// Same truncateToFit as lib/liveMusic.js/lib/beachflag.js/lib/ocnjCard.js.
function truncateToFit(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let truncated = text;
  while (truncated.length > 1 && ctx.measureText(truncated.trim() + "…").width > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return truncated.trim() + "…";
}

// ================= Geometry =================

function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const COMPASS_POINTS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

// Compass direction FROM (lat1,lon1) TO (lat2,lon2) -- used as
// "the storm is <this> of your town", so callers pass (townLat,
// townLon, stormLat, stormLon).
function bearingCompass(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180, toDeg = (r) => (r * 180) / Math.PI;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  const deg = (toDeg(Math.atan2(y, x)) + 360) % 360;
  return COMPASS_POINTS[Math.round(deg / 22.5) % 16];
}

// NHC's classification field distinguishes TD ("Tropical Depression"),
// TS ("Tropical Storm"), and HU ("Hurricane") directly -- intensity (kt)
// only needs to pick the category NUMBER once classification says HU.
// Unverified field values (see this file's header comment); degrades to
// a bare "TS"/"TD" label on anything that doesn't parse as a number
// rather than guessing a category.
function classificationLabel(classification, intensityKt) {
  const kt = Number(intensityKt);
  if (classification === "HU" && !isNaN(kt)) {
    if (kt >= 137) return "CAT 5";
    if (kt >= 113) return "CAT 4";
    if (kt >= 96) return "CAT 3";
    if (kt >= 83) return "CAT 2";
    return "CAT 1";
  }
  if (classification === "TS") return "TROP. STORM";
  if (classification === "TD") return "TROP. DEPRESSION";
  return classification || "UNKNOWN";
}

// Same thresholds as classificationLabel's HU branch, but derived purely
// from a wind speed -- no separate classification STRING exists per
// forecast point in NHC's text product (just "MAX WIND ... KT"), so a
// forecast point's own category has to come from its own wind speed,
// never from the storm's CURRENT classification. A depression forecast
// to reach hurricane strength by its closest approach must show that,
// not "still a depression" just because that's what it is right now.
function categoryFromWindKt(kt) {
  const n = Number(kt);
  if (isNaN(n)) return "UNKNOWN";
  if (n < 34) return "TROP. DEPRESSION";
  if (n < 64) return "TROP. STORM";
  if (n >= 137) return "CAT 5";
  if (n >= 113) return "CAT 4";
  if (n >= 96) return "CAT 3";
  if (n >= 83) return "CAT 2";
  return "CAT 1";
}

function ktToMph(kt) {
  const n = Number(kt);
  return isNaN(n) ? null : Math.round(n * 1.15078);
}

// ================= NHC fetch =================

// Throws on a genuine fetch/parse failure (matches fetchNextGame's own
// contract for ESPN) -- a caller should retry next run, not treat this
// as "no storms" (which is findNearestStorm's job, not this one's).
async function fetchActiveStorms(fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const resp = await doFetch(NHC_CURRENT_STORMS_URL);
  if (!resp.ok) throw new Error("NHC CurrentStorms fetch failed: " + resp.status);
  const data = await resp.json();
  return Array.isArray(data && data.activeStorms) ? data.activeStorms : [];
}

// Picks the single nearest storm to (lat, lon), skipping any storm
// missing usable coordinates. Returns null for the common case (no
// storm within MAX_RELEVANT_MILES, or no storms active at all) -- a
// real, steady-state "nothing to show," not an error.
function findNearestStorm(storms, lat, lon) {
  let best = null, bestMiles = Infinity;
  for (const storm of storms || []) {
    const sLat = Number(storm && storm.latitudeNumeric);
    const sLon = Number(storm && storm.longitudeNumeric);
    if (isNaN(sLat) || isNaN(sLon)) continue;
    const miles = haversineMiles(lat, lon, sLat, sLon);
    if (miles < bestMiles) { bestMiles = miles; best = storm; }
  }
  if (!best || bestMiles > MAX_RELEVANT_MILES) return null;
  return { storm: best, miles: bestMiles };
}

// Parses the handful of "FORECAST VALID DD/HHMMZ LAT LON" blocks out of
// NHC's plain-text Forecast/Advisory product -- see this file's header
// comment for why this (not a self-computed projection) is what backs
// the card's map. issuance anchors month/year, since the product text
// itself only ever gives day-of-month -- rolls into next month when the
// forecast day is earlier than the issuance day (a forecast spanning a
// month boundary).
const FORECAST_VALID_RE = /FORECAST VALID\s+(\d{2})\/(\d{4})Z\s+(\d{1,3}\.?\d*)([NS])\s+(\d{1,3}\.?\d*)([EW])[\s\S]{0,40}?MAX WIND\s+(\d{1,3})\s*KT/g;

function parseForecastTrack(text, issuanceDate) {
  const points = [];
  if (typeof text !== "string" || !text) return points;
  const issuance = issuanceDate instanceof Date && !isNaN(issuanceDate.getTime()) ? issuanceDate : new Date();
  let match;
  FORECAST_VALID_RE.lastIndex = 0;
  while ((match = FORECAST_VALID_RE.exec(text))) {
    const day = parseInt(match[1], 10);
    const hhmm = match[2];
    const lat = parseFloat(match[3]) * (match[4] === "S" ? -1 : 1);
    const lon = parseFloat(match[5]) * (match[6] === "W" ? -1 : 1);
    const windKt = parseInt(match[7], 10);
    if (isNaN(day) || isNaN(lat) || isNaN(lon) || isNaN(windKt)) continue;

    let year = issuance.getUTCFullYear(), month = issuance.getUTCMonth();
    if (day < issuance.getUTCDate()) {
      month += 1;
      if (month > 11) { month = 0; year += 1; }
    }
    const validAt = new Date(Date.UTC(year, month, day, parseInt(hhmm.slice(0, 2), 10), parseInt(hhmm.slice(2), 10)));
    points.push({ lat, lon, windKt, validAt });
  }
  return points;
}

async function fetchForecastTrack(forecastAdvisoryUrl, issuanceDate, fetchImpl) {
  if (!forecastAdvisoryUrl) return [];
  try {
    const doFetch = fetchImpl || fetch;
    const resp = await doFetch(forecastAdvisoryUrl);
    if (!resp.ok) return [];
    const text = await resp.text();
    return parseForecastTrack(text, issuanceDate);
  } catch (err) {
    return [];
  }
}

// The track point nearest this town IS the "closest approach" -- no
// separate landfall-town lookup (NHC doesn't publish that as structured
// data; free-text-parsing a town name out of advisory prose would be
// exactly the kind of unreliable guess this card is trying to avoid).
function pickClosestApproach(trackPoints, lat, lon) {
  let best = null, bestMiles = Infinity;
  for (const p of trackPoints || []) {
    const miles = haversineMiles(lat, lon, p.lat, p.lon);
    if (miles < bestMiles) { bestMiles = miles; best = p; }
  }
  if (!best) return null;
  return { point: best, miles: bestMiles };
}

function formatTrackLabel(validAt) {
  const dayPart = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(validAt).toUpperCase();
  const timePart = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: true }).format(validAt).toUpperCase().replace(" ", "");
  return { day: dayPart, time: timePart };
}

// ================= Orchestration =================

// Returns { noActiveStorm: true } when there's nothing within range (the
// steady-state most of the year) -- or the full card data otherwise.
// Only the first (CurrentStorms) fetch can throw; everything downstream
// of it (forecast track) degrades to an empty/partial result instead,
// per this file's header comment.
async function fetchHurricaneTrackerCardData({ lat, lon, townName }, now, fetchImpl) {
  // No saved location at all -- skip the live NHC fetch entirely rather
  // than spend it on a result we can't use anyway (nothing to measure
  // distance from).
  if (typeof lat !== "number" || typeof lon !== "number" || isNaN(lat) || isNaN(lon)) {
    return { noActiveStorm: true, townName: townName || null };
  }
  const storms = await fetchActiveStorms(fetchImpl);
  const nearest = findNearestStorm(storms, lat, lon);
  if (!nearest) return { noActiveStorm: true, townName: townName || null };

  const { storm, miles } = nearest;
  const issuance = storm.forecastAdvisory && storm.forecastAdvisory.issuance ? new Date(storm.forecastAdvisory.issuance) : (now || new Date());
  const track = await fetchForecastTrack(storm.forecastAdvisory && storm.forecastAdvisory.url, issuance, fetchImpl);
  const closest = pickClosestApproach(track, lat, lon);

  return {
    noActiveStorm: false,
    townName: townName || null,
    stormName: storm.name || "UNNAMED SYSTEM",
    direction: bearingCompass(lat, lon, Number(storm.latitudeNumeric), Number(storm.longitudeNumeric)),
    miles: Math.round(miles),
    classificationNow: classificationLabel(storm.classification, storm.intensity),
    windMphNow: ktToMph(storm.intensity),
    track: track.map((p) => ({ lat: p.lat, lon: p.lon, label: formatTrackLabel(p.validAt) })),
    closestApproach: closest ? {
      miles: Math.round(closest.miles),
      classification: categoryFromWindKt(closest.point.windKt),
      windMph: ktToMph(closest.point.windKt),
      label: formatTrackLabel(closest.point.validAt)
    } : null
  };
}

// ================= Coastline templates =================
// Hand-approximated, NOT traced from real GIS/coastline data -- this
// dev sandbox's network is blocked from every public geographic-data
// source tried (jsdelivr, NHC's own site). Simplified to each region's
// single most recognizable feature rather than every real bend, which
// read as noise at this card's small scale during design. See the
// README's Hurricane Tracker section for the plan to replace these with
// real simplified coastline data later -- a one-time, static fetch
// (coastlines don't move), not something this card needs to do live.
const COASTLINE_TEMPLATES = {
  // Mid-Atlantic: NJ shore, Chesapeake Bay mouth, Outer Banks hook.
  midAtlantic: {
    coast: [[44, -4], [50, 14], [54, 34], [16, 48], [56, 60], [88, 70], [46, 76], [40, 86]],
    town: [50, 14]
  },
  // Gulf Coast: Mississippi River delta "bird's foot," LA/MS/AL coast,
  // Mobile Bay, into the Florida Panhandle.
  gulf: {
    coast: [[2, 10], [16, 18], [30, 24], [44, 30], [60, 36], [76, 42], [84, 50], [78, 58], [88, 66], [100, 70]],
    delta: [18, 20],
    town: [78, 56]
  }
};

// Simple longitude bucketing -- west of the FL Panhandle/AL line reads
// as Gulf Coast, otherwise Mid-Atlantic. Every town this card currently
// has a template for is covered; anything else falls back to Mid-
// Atlantic rather than failing to render at all.
function pickCoastlineTemplate(lat, lon) {
  if (typeof lon === "number" && lon <= -85 && lat < 31) return COASTLINE_TEMPLATES.gulf;
  return COASTLINE_TEMPLATES.midAtlantic;
}

function drawStar(ctx, cx, cy, r) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.45;
    const ang = -Math.PI / 2 + (i * Math.PI) / 5;
    const x = cx + rad * Math.cos(ang), y = cy + rad * Math.sin(ang);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

function panel(ctx, x, y, w, h) {
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, PANEL_RADIUS);
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = "#000";
  ctx.stroke();
}

// Lays rows out with equal gaps above the first row, between each pair,
// and below the last -- using each row's own measured glyph height
// (actualBoundingBoxAscent+Descent), same technique
// drawGameDayCard's "IN"/"DAY(S)" labels use around its big number.
// Equal FIXED-height slots look uneven once row font sizes differ a
// lot (a big hero number barely has headroom in its own half of a
// panel, while a small subtitle has lots in its half).
function evenlySpacedRows(ctx, panelBox, rows) {
  const cx = panelBox.x + panelBox.w / 2;
  ctx.textAlign = "center";
  const metrics = rows.map((row) => {
    ctx.font = row.font;
    const m = ctx.measureText(row.text);
    return { ascent: m.actualBoundingBoxAscent, h: m.actualBoundingBoxAscent + m.actualBoundingBoxDescent };
  });
  const totalTextH = metrics.reduce((s, m) => s + m.h, 0);
  const gap = Math.max(4, (panelBox.h - totalTextH) / (rows.length + 1));
  let y = panelBox.y + gap;
  rows.forEach((row, i) => {
    ctx.font = row.font;
    ctx.fillStyle = row.color || "#000";
    ctx.fillText(row.text, cx, y + metrics[i].ascent);
    y += metrics[i].h + gap;
  });
}

function drawBanner(ctx, text) {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, CANVAS_WIDTH, BANNER_HEIGHT);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  const size = fitFontSize(ctx, text, CANVAS_WIDTH - 30, FONT_BLOCK, 24, 14);
  ctx.font = size + "px \"" + FONT_BLOCK + "\"";
  const m = ctx.measureText(text);
  const textH = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
  const baseline = (BANNER_HEIGHT - textH) / 2 + m.actualBoundingBoxAscent;
  ctx.fillText(text, CANVAS_WIDTH / 2, baseline);
}

function drawMapPanel(ctx, mapPanel, data) {
  const template = pickCoastlineTemplate(data.townLat, data.townLon);
  const mox = mapPanel.x + 14, moy = mapPanel.y + 16;
  const msx = (mapPanel.w - 70) / 100, msy = (mapPanel.h - 32) / 80;
  const MP = (x, y) => ({ x: mox + x * msx, y: moy + y * msy });

  const coast = template.coast.map(([x, y]) => MP(x, y));
  ctx.save();
  ctx.lineWidth = 2.2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(coast[0].x, coast[0].y);
  for (let i = 1; i < coast.length - 1; i++) {
    const cur = coast[i], next = coast[i + 1];
    const midX = (cur.x + next.x) / 2, midY = (cur.y + next.y) / 2;
    ctx.quadraticCurveTo(cur.x, cur.y, midX, midY);
  }
  ctx.lineTo(coast[coast.length - 1].x, coast[coast.length - 1].y);
  ctx.stroke();
  ctx.restore();

  if (template.delta) {
    const base = MP(template.delta[0], template.delta[1]);
    ctx.save();
    ctx.lineWidth = 1.8;
    [[6, 26], [0, 30], [-7, 25]].forEach(([dx, dy]) => {
      ctx.beginPath();
      ctx.moveTo(base.x, base.y);
      ctx.lineTo(base.x + dx * msx * 0.5, base.y + dy * msy * 0.5);
      ctx.stroke();
    });
    ctx.restore();
  }

  ctx.save();
  ctx.lineWidth = 1;
  for (let i = 1; i < coast.length - 1; i++) {
    const cur = coast[i];
    ctx.beginPath();
    ctx.moveTo(cur.x - 2, cur.y - 12);
    ctx.lineTo(cur.x - 9, cur.y - 7);
    ctx.stroke();
  }
  ctx.restore();

  const town = MP(template.town[0], template.town[1]);
  ctx.fillStyle = "#fff";
  ctx.beginPath(); ctx.arc(town.x, town.y + 13, 8, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#000";
  drawStar(ctx, town.x, town.y + 13, 6.5);

  const track = (data.track || []).slice(0, 4);
  if (track.length === 0) return;
  const trackOx = mapPanel.x + mapPanel.w - 58, trackOy = mapPanel.y + mapPanel.h - 38;
  const positions = track.map((p, i) => ({
    x: trackOx + [-16, -2, 14, 24][i],
    y: trackOy + [0, -28, -60, -98][i],
    label: p.label
  }));

  ctx.save();
  ctx.setLineDash([3.5, 3]);
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  positions.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  ctx.stroke();
  ctx.restore();

  positions.forEach((p, i) => {
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "#000";
    ctx.font = "bold 11px \"" + FONT_SERIF + "\"";
    ctx.textAlign = "center";
    ctx.fillText(String(i + 1), p.x, p.y + 4);
    ctx.font = "8px \"" + FONT_SERIF + "\"";
    ctx.fillText(p.label.day, p.x, p.y - 13);
    ctx.fillText(p.label.time, p.x, p.y + 20);
  });
}

function drawHurricaneTrackerCard(ctx, data) {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  if (data.noActiveStorm) {
    drawBanner(ctx, "HURRICANE TRACKER" + (data.townName ? " — " + data.townName.toUpperCase() : ""));
    const body = { x: PANEL_GAP, y: BANNER_HEIGHT + PANEL_GAP, w: CANVAS_WIDTH - PANEL_GAP * 2, h: CANVAS_HEIGHT - BANNER_HEIGHT - PANEL_GAP * 2 };
    panel(ctx, body.x, body.y, body.w, body.h);
    evenlySpacedRows(ctx, body, [
      { text: "NO ACTIVE STORMS NEARBY", font: "44px \"" + FONT_BLOCK + "\"" },
      { text: "Checked again automatically every hour", font: "bold 18px \"" + FONT_SERIF + "\"", color: "#555" }
    ]);
    return;
  }

  const bannerText = data.stormName.toUpperCase() + (data.townName ? " — " + data.townName.toUpperCase() : "");
  drawBanner(ctx, bannerText);

  const bodyTop = BANNER_HEIGHT + PANEL_GAP, bodyBottom = CANVAS_HEIGHT - PANEL_GAP;
  const bodyLeft = PANEL_GAP, bodyRight = CANVAS_WIDTH - PANEL_GAP;
  const mapW = 270;
  const leftW = bodyRight - PANEL_GAP - mapW - bodyLeft;
  const halfH = (bodyBottom - bodyTop - PANEL_GAP) / 2;

  const heroPanel = { x: bodyLeft, y: bodyTop, w: leftW, h: halfH };
  const closestPanel = { x: bodyLeft, y: bodyTop + halfH + PANEL_GAP, w: leftW, h: halfH };
  const mapPanel = { x: bodyRight - mapW, y: bodyTop, w: mapW, h: bodyBottom - bodyTop };

  panel(ctx, heroPanel.x, heroPanel.y, heroPanel.w, heroPanel.h);
  panel(ctx, closestPanel.x, closestPanel.y, closestPanel.w, closestPanel.h);
  panel(ctx, mapPanel.x, mapPanel.y, mapPanel.w, mapPanel.h);

  const windText = data.windMphNow != null ? data.windMphNow + " MPH" : "WIND N/A";
  evenlySpacedRows(ctx, heroPanel, [
    { text: data.miles + " MI " + data.direction, font: "62px \"" + FONT_BLOCK + "\"" },
    { text: "NOW · " + data.classificationNow + " · " + windText, font: "bold 18px \"" + FONT_SERIF + "\"" }
  ]);

  if (data.closestApproach) {
    const ca = data.closestApproach;
    const caWind = ca.windMph != null ? ca.windMph + " MPH" : "WIND N/A";
    evenlySpacedRows(ctx, closestPanel, [
      { text: "CLOSEST: " + ca.miles + " MI · " + ca.classification, font: "bold 19px \"" + FONT_SERIF + "\"" },
      { text: caWind, font: "bold 18px \"" + FONT_SERIF + "\"", color: "#333" },
      { text: ca.label.day + " " + ca.label.time, font: "bold 18px \"" + FONT_SERIF + "\"", color: "#333" }
    ]);
  } else {
    evenlySpacedRows(ctx, closestPanel, [
      { text: "FORECAST TRACK", font: "bold 19px \"" + FONT_SERIF + "\"" },
      { text: "NOT AVAILABLE RIGHT NOW", font: "bold 17px \"" + FONT_SERIF + "\"", color: "#555" }
    ]);
  }

  drawMapPanel(ctx, mapPanel, Object.assign({ townLat: data.townLat, townLon: data.townLon }, data));
}

module.exports = {
  NHC_CURRENT_STORMS_URL,
  MAX_RELEVANT_MILES,
  haversineMiles,
  bearingCompass,
  classificationLabel,
  categoryFromWindKt,
  ktToMph,
  fetchActiveStorms,
  findNearestStorm,
  parseForecastTrack,
  fetchForecastTrack,
  pickClosestApproach,
  pickCoastlineTemplate,
  fetchHurricaneTrackerCardData,
  drawHurricaneTrackerCard
};
