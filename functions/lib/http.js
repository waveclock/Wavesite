"use strict";

// Shared outbound-fetch headers, split into their own module so both
// dynamic.js and astro.js can use them without astro.js having to
// require dynamic.js (which already requires astro.js for
// fetchTideCardData -- that would be circular).
//
// Node's built-in fetch() has its OWN default headers when none are
// given -- verified directly (a local Node server, hit with a bare
// fetch(url), logging exactly what arrived): it sends
// "user-agent: node" and "accept-language: *". Neither is something any
// real browser has ever sent; "user-agent: node" in particular is about
// as plain a "this is a script" signal as exists, and is a common,
// basic thing for a site/CDN to block on by default -- no sophisticated
// fingerprinting required. An EARLIER attempt at this fix (adding a fake
// Chrome User-Agent) didn't help, and was then removed entirely on the
// theory that a mismatched fake-browser header was worse than sending
// none -- but "sending none" was never actually tested: Node's own
// defaults were still there the whole time, unexamined. `Accept` is left
// alone here since Node's own default ("*/*") already matches what a
// real browser's fetch() sends by default too -- that one was never the
// problem.
const OUTBOUND_FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9"
};

module.exports = { OUTBOUND_FETCH_HEADERS };
