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

// The banner's title only ever shows the storm's NAME -- this spells out
// its current type in front of it ("HURRICANE ISAIAS," not just
// "ISAIAS"), derived from classificationNow's own abbreviated label
// (CAT n / TROP. STORM / TROP. DEPRESSION) rather than a second NHC
// field, since that's already exactly this information. Omits the word
// entirely for anything that doesn't map cleanly (e.g. "UNKNOWN," or a
// raw post-tropical/subtropical code like "EX") rather than guessing.
function stormTypeWord(classificationNow) {
  if (!classificationNow) return "";
  if (classificationNow.indexOf("CAT") === 0) return "HURRICANE";
  if (classificationNow === "TROP. STORM") return "TROPICAL STORM";
  if (classificationNow === "TROP. DEPRESSION") return "TROPICAL DEPRESSION";
  return "";
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
    // Index into the `track` array above of the closest-approach point --
    // NHC often publishes more forecast points than this card's map has
    // room to plot (see selectMapTrackPoints), and closest approach is
    // this card's stand-in for "landfall" (NHC doesn't publish that as
    // its own structured field -- see pickClosestApproach's own comment),
    // so the map needs to know exactly which point that is to make sure
    // it's never left off.
    closestApproachIndex: closest ? track.indexOf(closest.point) : null,
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
//
// `coast` points are strictly increasing in x on purpose: drawMapPanel
// fills the region from this curve down to the panel's bottom edge as a
// solid landmass (not just a stroked outline), and a non-monotonic curve
// (looping back on itself in x) makes that fill self-intersect into a
// broken-looking shape. A real coastline obviously loops in both axes --
// this is a deliberate simplification to keep the fill a simple polygon,
// same tradeoff as the rest of this template being hand-approximated.
const COASTLINE_TEMPLATES = {
  // Mid-Atlantic: a NJ-shore-style diagonal with one notch standing in
  // for the Chesapeake Bay / Delaware Bay style inlets along this coast.
  midAtlantic: {
    coast: [[2, -10], [18, 6], [32, 16], [42, 11], [56, 30], [70, 50], [85, 66], [100, 94]],
    town: [32, 16]
  },
  // Gulf Coast: a shallower, more horizontal shoreline with one outward
  // bump standing in for the Mississippi River delta's "bird's foot" --
  // the bump itself carries that feature now (small branching spur lines
  // drawn off it read as a glitch at this card's scale, not a delta, so
  // this card no longer draws them). `delta` is just a marker distinguishing
  // this template from Mid-Atlantic (see pickCoastlineTemplate's own test).
  gulf: {
    coast: [[0, 34], [16, 26], [30, 19], [44, 23], [58, 11], [72, 20], [86, 32], [100, 28]],
    delta: [58, 11],
    town: [30, 19]
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

// Shared layout for both the hero panel (now) and the closest-approach
// panel (future): a small status line on top, then two equally big
// numbers side by side, each with its own small label underneath. Same
// equal-gap-by-measured-glyph-height technique as evenlySpacedRows, just
// with the big-number/label rows split into two columns instead of one
// -- gives both numbers in a panel the same visual weight instead of
// burying the second one in a small subtitle line.
function drawTwoBigStats(ctx, panelBox, topText, leftValue, leftLabel, rightValue, rightLabel) {
  const topFont = "bold 18px \"" + FONT_SERIF + "\"";
  const bigFont = "52px \"" + FONT_BLOCK + "\"";
  const labelFont = "bold 18px \"" + FONT_SERIF + "\"";

  ctx.font = topFont;
  const topM = ctx.measureText(topText);
  const topH = topM.actualBoundingBoxAscent + topM.actualBoundingBoxDescent;

  ctx.font = bigFont;
  const leftBigM = ctx.measureText(leftValue);
  const rightBigM = ctx.measureText(rightValue);
  const bigAscent = Math.max(leftBigM.actualBoundingBoxAscent, rightBigM.actualBoundingBoxAscent);
  const bigH = bigAscent + Math.max(leftBigM.actualBoundingBoxDescent, rightBigM.actualBoundingBoxDescent);

  ctx.font = labelFont;
  const labelM = ctx.measureText(leftLabel.length >= rightLabel.length ? leftLabel : rightLabel);
  const labelH = labelM.actualBoundingBoxAscent + labelM.actualBoundingBoxDescent;

  const totalTextH = topH + bigH + labelH;
  const gap = Math.max(4, (panelBox.h - totalTextH) / 4);
  const leftX = panelBox.x + panelBox.w * 0.27, rightX = panelBox.x + panelBox.w * 0.73;

  ctx.textAlign = "center";
  ctx.fillStyle = "#000";

  let y = panelBox.y + gap;
  ctx.font = topFont;
  ctx.fillText(topText, panelBox.x + panelBox.w / 2, y + topM.actualBoundingBoxAscent);
  y += topH + gap;

  ctx.font = bigFont;
  ctx.fillText(leftValue, leftX, y + bigAscent);
  ctx.fillText(rightValue, rightX, y + bigAscent);
  y += bigH + gap;

  ctx.font = labelFont;
  ctx.fillText(leftLabel, leftX, y + labelM.actualBoundingBoxAscent);
  ctx.fillText(rightLabel, rightX, y + labelM.actualBoundingBoxAscent);
}

function drawBanner(ctx, text) {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, CANVAS_WIDTH, BANNER_HEIGHT);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  const size = fitFontSize(ctx, text, CANVAS_WIDTH - 30, FONT_BLOCK, 30, 16);
  ctx.font = size + "px \"" + FONT_BLOCK + "\"";
  const m = ctx.measureText(text);
  const textH = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
  const baseline = (BANNER_HEIGHT - textH) / 2 + m.actualBoundingBoxAscent;
  ctx.fillText(text, CANVAS_WIDTH / 2, baseline);
}

// Draws the coastline as a FILLED landmass (land is the region below/
// right of the curve, closed off along the panel's own bottom+right
// edges), not just a stroked outline -- reads as land-vs-water at a
// glance, unlike the old thin-line-plus-hatch-marks approach it
// replaces. Relies on COASTLINE_TEMPLATES' `coast` arrays being
// strictly increasing in x (see that constant's own comment) to stay a
// simple, non-self-intersecting polygon.
function drawLandmass(ctx, mapPanel, coast) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(mapPanel.x, mapPanel.y, mapPanel.w, mapPanel.h);
  ctx.clip();

  ctx.fillStyle = "#dcdcdc";
  ctx.beginPath();
  ctx.moveTo(coast[0].x, coast[0].y);
  for (let i = 1; i < coast.length - 1; i++) {
    const cur = coast[i], next = coast[i + 1];
    ctx.quadraticCurveTo(cur.x, cur.y, (cur.x + next.x) / 2, (cur.y + next.y) / 2);
  }
  ctx.lineTo(coast[coast.length - 1].x, coast[coast.length - 1].y);
  ctx.lineTo(mapPanel.x + mapPanel.w, mapPanel.y + mapPanel.h);
  ctx.lineTo(mapPanel.x, mapPanel.y + mapPanel.h);
  ctx.closePath();
  ctx.fill("evenodd");

  ctx.lineWidth = 2.5;
  ctx.strokeStyle = "#000";
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(coast[0].x, coast[0].y);
  for (let i = 1; i < coast.length - 1; i++) {
    const cur = coast[i], next = coast[i + 1];
    ctx.quadraticCurveTo(cur.x, cur.y, (cur.x + next.x) / 2, (cur.y + next.y) / 2);
  }
  ctx.lineTo(coast[coast.length - 1].x, coast[coast.length - 1].y);
  ctx.stroke();
  ctx.restore();
}

// The map panel only has room for ~4 plotted points, but NHC's real
// forecast advisories often carry more than that (5-7 points out to
// 120 hours) -- picking the first 4 chronologically can leave off the
// closest-approach point entirely if it falls later in the track (seen
// on a real published card: a storm's closest approach was its 5th
// forecast point, past the 4 shown). This always ends the plotted span
// AT the closest-approach point (this card's stand-in for "landfall,"
// per pickClosestApproach's own comment on why there's no separate
// landfall lookup), sampling up to 4 points evenly between the current
// position and it so it's never left off. Falls back to the track's
// last point when there's no closest-approach data at all.
function selectMapTrackPoints(track, closestApproachIndex) {
  if (!track || track.length === 0) return [];
  const hasClosest = typeof closestApproachIndex === "number" && closestApproachIndex >= 0 && closestApproachIndex < track.length;
  const lastIdx = hasClosest ? closestApproachIndex : track.length - 1;
  const span = lastIdx + 1;
  const indices = span <= 4
    ? Array.from({ length: span }, (_, i) => i)
    : [...new Set([0, Math.round(lastIdx / 3), Math.round((2 * lastIdx) / 3), lastIdx])];
  return indices.map((i) => ({ point: track[i], isClosest: hasClosest && i === closestApproachIndex }));
}

// ================= Real track projection =================
// The circled track points used to sit at a fixed decorative offset
// pattern, unrelated to the storm's real bearing/distance -- it always
// "walked" up and to the right regardless of which way the storm was
// actually moving. Confirmed misleading on a real published card: a
// storm 505 mi SSW of the town rendered a path that didn't reflect that
// at all. These project each point's REAL lat/lon into the panel,
// anchored at the town marker's own pixel position (not a separate,
// unrelated grid) and auto-scaled to fit whatever room is available in
// whichever direction the storm actually lies.
//
// The coastline underneath is still the hand-approximated template (see
// COASTLINE_TEMPLATES' own comment) -- it is NOT on the same real
// lat/lon grid, so a correctly-plotted storm dot can still land on the
// illustrated "land" even when the real storm is over water. Only the
// dot's position RELATIVE TO THE TOWN MARKER (true bearing and
// distance) is accurate; its position relative to the drawn coastline
// shape is not. Replacing the coastline with real geography is tracked
// separately (see the README's Hurricane Tracker section) and needs
// real network access this dev sandbox doesn't have.
const MILES_PER_DEG_LAT = 69;
// Never zoom in tighter than this, even for a very close storm -- a
// closest approach of a few miles shouldn't visually stretch across the
// whole panel as if it were hundreds of miles away.
const TRACK_MAX_PX_PER_MILE = 0.6;

function milesPerDegLon(lat) {
  return MILES_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

// How many pixels each real mile should occupy, chosen so every given
// point fits inside the room actually available around the anchor in
// whichever compass direction it falls, capped at TRACK_MAX_PX_PER_MILE
// so close points aren't exaggerated. Margin only needs to clear the dot
// itself (radius + stroke) -- label TEXT is clamped separately at draw
// time (see drawMapPanel) rather than reserved for here, since the town
// marker sits close to this template's left edge and a generous margin
// on every side left almost no room for a westward-trending storm.
function computeTrackScale(anchorPx, anchorLat, anchorLon, points, bounds) {
  const MARGIN = 20;
  const rightRoom = bounds.x + bounds.w - MARGIN - anchorPx.x;
  const leftRoom = anchorPx.x - bounds.x - MARGIN;
  const belowRoom = bounds.y + bounds.h - MARGIN - anchorPx.y;
  const aboveRoom = anchorPx.y - bounds.y - MARGIN;
  const milesPerLon = milesPerDegLon(anchorLat);

  let scale = TRACK_MAX_PX_PER_MILE;
  points.forEach((p) => {
    const dxMiles = (p.lon - anchorLon) * milesPerLon;
    const dyMilesNorth = (p.lat - anchorLat) * MILES_PER_DEG_LAT;
    if (dxMiles > 0 && rightRoom > 0) scale = Math.min(scale, rightRoom / dxMiles);
    if (dxMiles < 0 && leftRoom > 0) scale = Math.min(scale, leftRoom / -dxMiles);
    if (dyMilesNorth > 0 && aboveRoom > 0) scale = Math.min(scale, aboveRoom / dyMilesNorth);
    if (dyMilesNorth < 0 && belowRoom > 0) scale = Math.min(scale, belowRoom / -dyMilesNorth);
  });
  return Math.max(scale, 0.02);
}

function projectTrackPoint(anchorPx, anchorLat, anchorLon, lat, lon, scale) {
  const dxMiles = (lon - anchorLon) * milesPerDegLon(anchorLat);
  const dyMilesNorth = (lat - anchorLat) * MILES_PER_DEG_LAT;
  return { x: anchorPx.x + dxMiles * scale, y: anchorPx.y - dyMilesNorth * scale };
}

// A real close-approach distance (tens of miles, not unusual) can still
// project to just a few pixels from the town marker once scaled to fit
// the panel, visually burying the star under the dot. Pushes a too-close
// point radially outward to a minimum on-screen distance from the
// anchor, preserving its real bearing exactly -- this is a presentation
// floor so the star stays visible, not a claim that the real distance
// was any different (the panel's actual number for it is shown in the
// closest-approach panel's own text, not read off this map).
function enforceMinRadiusFromAnchor(proj, anchorPx, minRadius) {
  const dx = proj.x - anchorPx.x, dy = proj.y - anchorPx.y;
  const dist = Math.hypot(dx, dy);
  if (dist >= minRadius || dist === 0) return proj;
  const k = minRadius / dist;
  return { x: anchorPx.x + dx * k, y: anchorPx.y + dy * k };
}

function rectOverlapArea(a, b) {
  const w = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const h = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  return w * h;
}

// Real points can land anywhere now, not the predictable fixed walk the
// old decorative layout had -- points close together along a consistent
// bearing (very possible in real forecast data, e.g. a slow-moving
// storm) can put one point's label right on top of a neighboring dot or
// label. An above/below-only choice still isn't enough once 3+ points
// are roughly collinear and tightly spaced -- there's no slot left on
// either side that clears everything. Tries 4 placements per label
// (above/below/right/left of its dot), measures each one's REAL text
// width so its bounding box is exact, and scores every candidate by how
// much it overlaps every other dot and every label already placed
// earlier in this same pass -- picking whichever has the least overlap
// (usually none), not just "the side with more panel room."
function layoutTrackLabels(ctx, positions, mapPanel, extraObstacles) {
  const DOT_R = 13, DOT_PAD = 4, GAP = 7, LABEL_H = 15;
  ctx.font = "bold 13px \"" + FONT_SERIF + "\"";

  const dotBoxes = positions.map((p) => ({
    x1: p.x - DOT_R - DOT_PAD, x2: p.x + DOT_R + DOT_PAD,
    y1: p.y - DOT_R - DOT_PAD, y2: p.y + DOT_R + DOT_PAD
  })).concat(extraObstacles || []);

  function clampBox(box, labelX, labelY) {
    let dx = 0, dy = 0;
    if (box.x1 + dx < mapPanel.x + 4) dx = mapPanel.x + 4 - box.x1;
    if (box.x2 + dx > mapPanel.x + mapPanel.w - 4) dx = mapPanel.x + mapPanel.w - 4 - box.x2;
    if (box.y1 + dy < mapPanel.y + 4) dy = mapPanel.y + 4 - box.y1;
    if (box.y2 + dy > mapPanel.y + mapPanel.h - 4) dy = mapPanel.y + mapPanel.h - 4 - box.y2;
    return {
      box: { x1: box.x1 + dx, x2: box.x2 + dx, y1: box.y1 + dy, y2: box.y2 + dy },
      labelX: labelX + dx, labelY: labelY + dy
    };
  }

  const placedBoxes = [];
  return positions.map((p, i) => {
    const text = p.label.day + " " + p.label.time;
    const halfW = ctx.measureText(text).width / 2 + 3;

    const raw = [
      { align: "center", labelX: p.x, labelY: p.y - 20, box: { x1: p.x - halfW, x2: p.x + halfW, y1: p.y - 20 - LABEL_H, y2: p.y - 20 + 4 } },
      { align: "center", labelX: p.x, labelY: p.y + 30, box: { x1: p.x - halfW, x2: p.x + halfW, y1: p.y + 30 - LABEL_H, y2: p.y + 30 + 4 } },
      { align: "left", labelX: p.x + DOT_R + GAP, labelY: p.y + 4, box: { x1: p.x + DOT_R + GAP, x2: p.x + DOT_R + GAP + halfW * 2, y1: p.y - 9, y2: p.y + 9 } },
      { align: "right", labelX: p.x - DOT_R - GAP, labelY: p.y + 4, box: { x1: p.x - DOT_R - GAP - halfW * 2, x2: p.x - DOT_R - GAP, y1: p.y - 9, y2: p.y + 9 } }
    ];

    let best = null, bestOverlap = Infinity;
    raw.forEach((candidate, ci) => {
      const clamped = clampBox(candidate.box, candidate.labelX, candidate.labelY);
      let overlap = 0;
      dotBoxes.forEach((db, j) => { if (j !== i) overlap += rectOverlapArea(clamped.box, db); });
      placedBoxes.forEach((pb) => { overlap += rectOverlapArea(clamped.box, pb); });
      const score = overlap + ci * 0.01; // tiny tie-break toward above/below/right/left in that order
      if (score < bestOverlap) {
        bestOverlap = score;
        best = { align: candidate.align, labelX: clamped.labelX, labelY: clamped.labelY, box: clamped.box };
      }
    });

    placedBoxes.push(best.box);
    return best;
  });
}

function drawMapPanel(ctx, mapPanel, data) {
  const template = pickCoastlineTemplate(data.townLat, data.townLon);
  const mox = mapPanel.x + 14, moy = mapPanel.y + 16;
  const msx = (mapPanel.w - 70) / 100, msy = (mapPanel.h - 32) / 80;
  const MP = (x, y) => ({ x: mox + x * msx, y: moy + y * msy });

  const coast = template.coast.map(([x, y]) => MP(x, y));
  drawLandmass(ctx, mapPanel, coast);

  const town = MP(template.town[0], template.town[1]);
  ctx.fillStyle = "#fff";
  ctx.beginPath(); ctx.arc(town.x, town.y + 13, 9, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 1.8;
  ctx.beginPath(); ctx.arc(town.x, town.y + 13, 9, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = "#000";
  drawStar(ctx, town.x, town.y + 13, 7.5);

  const points = selectMapTrackPoints(data.track, data.closestApproachIndex);
  if (points.length === 0) return;

  // Real lat/lon projection, anchored at the town marker's own pixel
  // position -- see this file's "Real track projection" comment above
  // for why (and its honest limits).
  const townAnchor = { x: town.x, y: town.y + 13 };
  const scale = computeTrackScale(townAnchor, data.townLat, data.townLon, points.map((e) => e.point), mapPanel);
  const positions = points.map((entry) => {
    const rawProj = projectTrackPoint(townAnchor, data.townLat, data.townLon, entry.point.lat, entry.point.lon, scale);
    const proj = enforceMinRadiusFromAnchor(rawProj, townAnchor, 26);
    return { x: proj.x, y: proj.y, label: entry.point.label, isClosest: entry.isClosest };
  });

  ctx.save();
  ctx.setLineDash([4.5, 4]);
  ctx.lineWidth = 2;
  ctx.beginPath();
  positions.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  ctx.stroke();
  ctx.restore();

  const townBox = { x1: townAnchor.x - 15, x2: townAnchor.x + 15, y1: townAnchor.y - 15, y2: townAnchor.y + 15 };
  const labelLayout = layoutTrackLabels(ctx, positions, mapPanel, [townBox]);

  positions.forEach((p, i) => {
    // The closest-approach point (this card's "landfall" stand-in) is
    // filled black instead of white, so it reads as the one point on
    // this map that matters most, not just another step in the track.
    ctx.fillStyle = p.isClosest ? "#000" : "#fff";
    ctx.beginPath(); ctx.arc(p.x, p.y, 13, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.arc(p.x, p.y, 13, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = p.isClosest ? "#fff" : "#000";
    ctx.font = "bold 16px \"" + FONT_SERIF + "\"";
    ctx.textAlign = "center";
    ctx.fillText(String(i + 1), p.x, p.y + 5.5);

    const layout = labelLayout[i];
    ctx.fillStyle = "#000";
    ctx.font = "bold 13px \"" + FONT_SERIF + "\"";
    ctx.textAlign = layout.align;
    ctx.fillText(p.label.day + " " + p.label.time, layout.labelX, layout.labelY);
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

  const typeWord = stormTypeWord(data.classificationNow);
  const bannerText = (typeWord ? typeWord + " " : "") + data.stormName.toUpperCase() + (data.townName ? " — " + data.townName.toUpperCase() : "");
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

  const hasWind = data.windMphNow != null;
  drawTwoBigStats(
    ctx, heroPanel, "NOW · " + data.classificationNow,
    String(data.miles), "MI " + data.direction,
    hasWind ? String(data.windMphNow) : "N/A", "MPH"
  );

  if (data.closestApproach) {
    const ca = data.closestApproach;
    const caHasWind = ca.windMph != null;
    drawTwoBigStats(
      ctx, closestPanel, "CLOSEST · " + ca.classification + " · " + ca.label.day + " " + ca.label.time,
      String(ca.miles), "MILES",
      caHasWind ? String(ca.windMph) : "N/A", "MPH"
    );
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
  stormTypeWord,
  ktToMph,
  fetchActiveStorms,
  findNearestStorm,
  parseForecastTrack,
  fetchForecastTrack,
  pickClosestApproach,
  pickCoastlineTemplate,
  selectMapTrackPoints,
  computeTrackScale,
  projectTrackPoint,
  enforceMinRadiusFromAnchor,
  rectOverlapArea,
  layoutTrackLabels,
  fetchHurricaneTrackerCardData,
  drawHurricaneTrackerCard
};
