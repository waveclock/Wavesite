// Service worker for the NFC keychain tide-tag experience (/t/:id).
// Registered from 404.html with an explicit scope of '/t/' -- even
// though this file lives at the site root (which would otherwise let it
// control every page on waveclock.net), it's deliberately narrowed so it
// only ever affects the tide-tag pages, never the rest of the static
// site (device setup, homepage, etc.).
//
// Two things this buys the tide experience:
//   1. The app shell (this page's own markup + the brand logo) loads
//      even with zero signal, instead of a browser error page.
//   2. The last successful NOAA tide fetch for each station stays
//      available offline -- stale tide data beats no tide data at all,
//      and this is a product people specifically use AT THE BEACH,
//      where signal is often weak or absent.
//
// Registration (POST/PUT to tideTagProxy) is never intercepted -- only
// GET requests are cacheable here, and a registration write always
// needs to actually reach the server to mean anything.

const SHELL_CACHE = "wc-tide-shell-v1";
const DATA_CACHE = "wc-tide-data-v1";
const SHELL_URLS = ["/404.html", "/logo.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL_URLS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // registration writes always need the real network

  const url = new URL(req.url);

  // A navigation to /t/:id -- network first (so everyone gets the
  // latest app code when they have signal), falling back to the cached
  // shell only when the network is unreachable.
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match("/404.html")));
    return;
  }

  // NOAA's own API (both tide predictions and the stations list) --
  // network first, caching each exact request URL (which already
  // encodes the station/date range) so a later offline visit replays
  // THIS station's last known response, not some other tag's.
  if (url.hostname === "api.tidesandcurrents.noaa.gov") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(DATA_CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Everything else this scope ever requests (the shell files, mainly)
  // -- cache first, network as the fallback for anything not yet cached.
  event.respondWith(caches.match(req).then((cached) => cached || fetch(req)));
});
