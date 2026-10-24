// Beach Day's shared, LOCATION-keyed cache -- the piece that makes it
// "store less images" (per the product conversation this was built
// from): every device/tag sharing a town renders to the exact same
// cache entry instead of one copy per device, and the cache has no date
// in its path, so it's overwritten in place each morning rather than
// growing over time. This is deliberately separate from the per-device
// custom-screen pipeline in index.js/dynamic.js (meta.type ===
// "beachDay", already shipped) -- a device that's actually enrolled
// Beach Day as one of its own custom screens still gets its own
// `designs/{deviceId}.bin`/`.png` from THAT pipeline, independently;
// this cache exists for the keychain web view, which has no per-device
// opt-in to wait on and would otherwise need to either run the same
// three external fetches on every page load or duplicate one file per
// viewer.
"use strict";

const { createCanvas } = require("canvas");
const tzlookup = require("tz-lookup");
const { isValidDeviceId, isValidTagId } = require("./tideTag");
const { fetchBeachDayData } = require("./beachDay");
const { ensureFontsRegistered, loadBeachDayIcons, drawBeachDayCard, packTo1Bit, CANVAS_WIDTH, CANVAS_HEIGHT } = require("./dynamic");

const STATUS_PREFIX = "device-status/";
const LOCATIONS_PREFIX = "locations/";
const TAGS_PREFIX = "tide-tags/";
const CACHE_PREFIX = "beach-day-cache/";

function idFrom(prefix, name) {
  return (name.startsWith(prefix) && name.endsWith(".json")) ? name.slice(prefix.length, -5) : null;
}

async function readJson(bucket, path) {
  try {
    const [buf] = await bucket.file(path).download();
    return JSON.parse(buf.toString("utf8"));
  } catch (err) {
    return null; // missing or malformed -- same as "nothing on file" everywhere else this pattern is used
  }
}

// Zone + direction included verbatim (two locations in different zones
// or with a manually-overridden direction are genuinely different
// renders), lat/lon rounded to ~1km (2 decimal places) so two devices
// pinned to slightly different spots in the same town still land on one
// shared entry instead of minting their own.
function beachDayCacheKey({ lat, lon, stationId, srfZone, coastFacingDirection }) {
  const rlat = (Math.round(Number(lat) * 100) / 100).toFixed(2);
  const rlon = (Math.round(Number(lon) * 100) / 100).toFixed(2);
  return [stationId, srfZone || "none", coastFacingDirection || "none", rlat, rlon].join("_");
}

// Normalizes device-status's `.location` object and locations/'s own
// (flat, same field names) shape into one common shape. Returns null
// for a record that's missing what fetchBeachDayData actually needs to
// run at all (lat/lon/stationId) -- srfZone/srfOffice/srfProductPrefix/
// coastFacingDirection are all optional enhancements fetchBeachDayData
// already degrades gracefully without (see its own module comment).
function extractFromDeviceLocation(loc) {
  if (!loc || loc.lat == null || loc.lon == null || !loc.stationId) return null;
  return {
    lat: loc.lat, lon: loc.lon, stationId: loc.stationId,
    srfZone: loc.srfZone || null, coastFacingDirection: loc.coastFacingDirection || null,
    srfOffice: loc.srfOffice || null, srfProductPrefix: loc.srfProductPrefix || null,
    townName: loc.name || null
  };
}

// tide-tags/ records never carry srfOffice/srfProductPrefix at all (see
// saveTideTag in tideTag.js) -- a standalone keychain's Beach Day render
// just never gets a real rip-risk reading (falls back to "--", same as
// any other missing-bulletin case), not a bug to work around here.
function extractFromTideTag(tag) {
  if (!tag || tag.lat == null || tag.lon == null || !tag.stationId) return null;
  return {
    lat: tag.lat, lon: tag.lon, stationId: tag.stationId,
    srfZone: tag.srfZone || null, coastFacingDirection: tag.coastFacingDirection || null,
    srfOffice: null, srfProductPrefix: null, townName: tag.townName || null
  };
}

function isMoreComplete(loc) {
  return !!(loc.srfOffice && loc.srfProductPrefix);
}

// Scans every device's and standalone tag's saved location, same three
// sources and the same device-status-over-locations/ precedence
// coastOrientationReport (index.js) already uses, plus tide-tags/ for
// standalone keychains. Returns one entry per unique beachDayCacheKey --
// when two raw records land on the same key, the more complete one
// (has srfOffice+srfProductPrefix, so rip risk can actually be read)
// wins, so one WaveClock with full data sharing a town with several
// bare tide-tag keychains still gets rip risk for everyone there.
async function collectActiveBeachDayLocations(bucket) {
  const [statusFiles] = await bucket.getFiles({ prefix: STATUS_PREFIX });
  const [locationFiles] = await bucket.getFiles({ prefix: LOCATIONS_PREFIX });
  const [tagFiles] = await bucket.getFiles({ prefix: TAGS_PREFIX });

  const statusIds = new Set(statusFiles.map((f) => idFrom(STATUS_PREFIX, f.name)).filter(Boolean).filter(isValidDeviceId));
  const locationIds = new Set(locationFiles.map((f) => idFrom(LOCATIONS_PREFIX, f.name)).filter(Boolean).filter(isValidDeviceId));
  const tagIds = tagFiles.map((f) => idFrom(TAGS_PREFIX, f.name)).filter(Boolean).filter(isValidTagId);

  const raw = [];
  for (const deviceId of statusIds) {
    const j = await readJson(bucket, STATUS_PREFIX + deviceId + ".json");
    const loc = extractFromDeviceLocation(j && j.location);
    if (loc) raw.push(loc);
  }
  for (const deviceId of locationIds) {
    if (statusIds.has(deviceId)) continue; // device-status already covered this device, preferred over locations/
    const j = await readJson(bucket, LOCATIONS_PREFIX + deviceId + ".json");
    const loc = extractFromDeviceLocation(j);
    if (loc) raw.push(loc);
  }
  for (const tagId of tagIds) {
    const j = await readJson(bucket, TAGS_PREFIX + tagId + ".json");
    const loc = extractFromTideTag(j);
    if (loc) raw.push(loc);
  }

  const byKey = new Map();
  for (const loc of raw) {
    const key = beachDayCacheKey(loc);
    const existing = byKey.get(key);
    if (!existing || (isMoreComplete(loc) && !isMoreComplete(existing))) byKey.set(key, loc);
  }
  return Array.from(byKey.values());
}

// Renders one location's screen -- the exact same data/draw/pack chain
// the per-device "beachDay" dynamic-layer type in dynamic.js uses
// (fetchBeachDayData -> drawBeachDayCard -> packTo1Bit), just invoked
// directly against a plain location instead of a device's own meta,
// and with no base image to composite onto (same as that type's own
// blank-white-canvas convention -- see drawBeachDayCard's own comment).
async function renderBeachDayForLocation(loc, now, fetchImpl) {
  ensureFontsRegistered();
  const icons = await loadBeachDayIcons();
  const fields = await fetchBeachDayData(loc, now, fetchImpl);
  const at = now || new Date();
  const timeZone = tzlookup(loc.lat, loc.lon);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(at);
  const data = Object.assign(
    { town: (loc.townName || "").toUpperCase(), weekday, subtitle: "1 PM conditions" },
    fields
  );

  const canvas = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  drawBeachDayCard(ctx, data, icons);

  return { binBuffer: packTo1Bit(canvas, false), pngBuffer: canvas.toBuffer("image/png") };
}

// The daily job's own entry point: collect every active location,
// render+write each unique one. A single location's render failing
// (e.g. that morning's weather fetch genuinely down) is caught and
// counted, not allowed to abort the rest of the batch -- same per-item
// resilience regenerateCountdownDesigns already uses in index.js.
async function regenerateBeachDayCache(bucket, now, fetchImpl) {
  const locations = await collectActiveBeachDayLocations(bucket);
  let updated = 0, failed = 0;
  for (const loc of locations) {
    const key = beachDayCacheKey(loc);
    try {
      const { binBuffer, pngBuffer } = await renderBeachDayForLocation(loc, now, fetchImpl);
      await bucket.file(CACHE_PREFIX + key + ".bin").save(binBuffer, { contentType: "application/octet-stream" });
      await bucket.file(CACHE_PREFIX + key + ".png").save(pngBuffer, { contentType: "image/png" });
      updated++;
    } catch (err) {
      failed++;
    }
  }
  return { locationCount: locations.length, updated, failed };
}

module.exports = {
  STATUS_PREFIX,
  LOCATIONS_PREFIX,
  TAGS_PREFIX,
  CACHE_PREFIX,
  beachDayCacheKey,
  extractFromDeviceLocation,
  extractFromTideTag,
  collectActiveBeachDayLocations,
  renderBeachDayForLocation,
  regenerateBeachDayCache
};
