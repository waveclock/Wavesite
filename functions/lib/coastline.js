// Server-side fetch of OpenStreetMap natural=coastline geometry near a
// point, for the tide tag page's (404.html) Clean/Fair/Choppy wind-vs-
// coast classification. This USED to be called directly from the
// browser (404.html's own fetchOverpassCoastline) -- live reports showed
// the bars losing their color and the Clean/Offshore badges disappearing
// on real phones, which earlier research traced to Overpass's public
// mirrors being unreliable when hit directly from browser JS (CORS
// preflight failures and occasional 406 responses some of these mirrors
// return to browser-originated requests, never observed from a plain
// server-to-server fetch). Proxying through our own backend removes that
// failure mode: this makes the exact same request Overpass always
// expects, just from a server instead of a phone's browser.
"use strict";

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter"
];
// Closer radius first -- most towns have real coastline data within 3km;
// 8km is the wider fallback for a sparser/less-precisely-mapped stretch.
const COASTLINE_SEARCH_RADII_KM = [3, 8];

function buildCoastlineQuery(lat, lon, radiusKm) {
  const dLat = radiusKm / 111.32;
  const dLon = radiusKm / (111.32 * Math.cos(lat * Math.PI / 180));
  const south = lat - dLat, north = lat + dLat, west = lon - dLon, east = lon + dLon;
  return `[out:json][timeout:20];way["natural"="coastline"](${south},${west},${north},${east});out body;>;out skel qt;`;
}

async function fetchOverpassOnce(doFetch, url, query, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await doFetch(url, {
      method: "POST",
      body: "data=" + encodeURIComponent(query),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: controller.signal
    });
    if (!resp.ok) throw new Error("http " + resp.status);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

// Tries each search radius (closer first), and at each radius every
// mirror in turn, until one returns real coastline elements. Throws only
// once every radius/mirror combination has been exhausted -- callers
// (coastlineProxyHandler) turn that into a 502, same "best-effort
// enrichment, not required" treatment the client already gives this
// field (see 404.html's own graceful degrade when this is unavailable).
// fetchImpl: injected for tests; real callers omit it and get global fetch.
async function fetchCoastlineNear(lat, lon, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  let lastError = null;
  for (const radiusKm of COASTLINE_SEARCH_RADII_KM) {
    const query = buildCoastlineQuery(lat, lon, radiusKm);
    for (const url of OVERPASS_ENDPOINTS) {
      try {
        const data = await fetchOverpassOnce(doFetch, url, query, 8000);
        if (data && Array.isArray(data.elements) && data.elements.length) return data;
        lastError = new Error("no coastline elements in range");
      } catch (err) {
        lastError = err;
      }
    }
  }
  throw lastError || new Error("all Overpass mirrors failed");
}

module.exports = { OVERPASS_ENDPOINTS, COASTLINE_SEARCH_RADII_KM, buildCoastlineQuery, fetchCoastlineNear };
