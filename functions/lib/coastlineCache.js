// Server-side cache for fetchCoastlineNear's own result, keyed by rounded
// lat/lon -- a real coastline's shape never changes, so once ANY tag's
// pick has resolved a given spot, every later pick near that same spot
// (a different person, a different tag, "Change beach" back to the same
// town) can skip Overpass entirely instead of repeating its own
// multi-mirror/multi-radius retry chain (the thing that made Wildwood,
// NJ's lookup take tens of seconds -- see coastline.js's own comments).
// 404.html's fetchCoastFacingBearing already caches successes in
// localStorage, but that only ever helps the SAME browser's later visits
// -- this is the shared, cross-user version of that same idea, sitting
// in front of coastlineProxyHandler instead of in front of the client's
// own fetch.
//
// Stored the same way tideTag.js stores tags -- one small JSON file per
// key in the same Cloud Storage bucket, since that's the only "database"
// this Firebase project has provisioned (see tideTag.js's own comment).
"use strict";

const COASTLINE_CACHE_PREFIX = "coastline-cache/";

// Rounded to 2 decimal places (~1.1km grid at mid latitudes) -- same
// precision 404.html's own coastBearingCacheKey already uses for its
// localStorage cache, so a spot that's a cache hit in one is a cache hit
// in the other.
function coastlineCacheKey(lat, lon) {
  return lat.toFixed(2) + "_" + lon.toFixed(2);
}

function coastlineCacheFile(bucket, lat, lon) {
  return bucket.file(COASTLINE_CACHE_PREFIX + coastlineCacheKey(lat, lon) + ".json");
}

// Never throws -- a cache miss (nothing stored yet) and a cache failure
// (a transient storage hiccup) get treated identically: fall through to
// a live Overpass lookup, exactly what would have happened with no cache
// at all. A cache can only ever make this faster, never a new way for
// the real request to fail.
async function fetchCachedCoastline(bucket, lat, lon) {
  try {
    const [buf] = await coastlineCacheFile(bucket, lat, lon).download();
    return JSON.parse(buf.toString("utf8"));
  } catch (err) {
    return null;
  }
}

// Also never throws, for the same reason -- by the time this is called,
// the real (uncached) response has already been resolved; a write
// failure here just means the NEXT lookup for this spot costs a live
// Overpass round trip again, same as today, not a failure the caller
// needs to handle.
async function saveCachedCoastline(bucket, lat, lon, data) {
  try {
    await coastlineCacheFile(bucket, lat, lon).save(JSON.stringify(data), { contentType: "application/json" });
  } catch (err) {
    // best-effort only -- see this function's own comment above.
  }
}

module.exports = { COASTLINE_CACHE_PREFIX, coastlineCacheKey, fetchCachedCoastline, saveCachedCoastline };
