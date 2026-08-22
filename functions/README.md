# Dynamic-layer auto-update Cloud Function

Runs once a day (09:00 UTC) and redraws the current content for every
device with an active "dynamic layer" published from `/design-v2/` -- a
**Countdown** (a target date), a **Team Schedule** (next game for a
picked sports team), **News** (headlines for a location or RSS feed), or
**Tide & Fishing** (tide curve + moon phase/rise/set for the device's
saved location) -- overwriting `designs/{deviceId}.bin` and `.png` in
place. The device itself needs no changes -- it already reads those two
files unconditionally.

## How it fits together

`design-v2/index.html` publishes up to four files per device when a
Countdown, Team, or News layer is on the canvas:

- `designs/{id}.bin` / `.png` -- today's design, exactly as before (so the
  board updates immediately on publish, same as always).
- `designs/{id}-base.png` -- everything else on the canvas, flattened,
  WITHOUT the dynamic layer's text. This is what gets redrawn onto each
  day.
- `designs/{id}-dynamic.json` -- the dynamic layer's own settings, tagged
  with a `type` field:
  - `{ type: "countdown", targetDate, label, x, y, size, fontKey, outline, inverted }`
  - `{ type: "team", sport, league, teamId, teamName, x, y, size, fontKey, outline, inverted }`
  - `{ type: "news", location, feedUrl, x, y, size, fontKey, outline, inverted }`

If there's no Countdown, Team, or News layer, `design-v2` deletes the
`-base.png` / `-dynamic.json` files instead (best-effort) so this job has
nothing to find for that device. At most one dynamic layer is treated as
active per device for now -- if a customer somehow adds more than one,
only the first one found governs auto-updates.

Each run:
1. Lists everything under `designs/` and picks out `*-dynamic.json`.
2. For each device, downloads `-dynamic.json` + `-base.png` and dispatches
   on `type` (see `lib/dynamic.js`):
   - **countdown**: computes days-remaining and draws the text.
   - **team**: fetches the team's schedule from ESPN's unofficial site API.
     If a game is found, draws the full **Game Day card** -- full-screen
     layout with an edge-to-edge matchup line tucked up under the banner
     using each team's actual name ("PENN STATE VS MARSHALL", not ESPN's
     cryptic triCode abbreviation), both teams' full-size logos (fetched
     and Atkinson-dithered server-side) flanking a large centered
     days-remaining count (split across 3 lines -- "IN" / the number, in
     a very large font / "DAY" or "DAYS" -- or a single big "TODAY!"),
     and one edge-to-edge bottom line with the game's day/date, venue
     (drawn at a noticeably larger size than the rest of the line, since
     it's the one piece worth extra visual weight), and kickoff time in
     Eastern, all sharing one baseline. In the off-season (no upcoming
     games) it
     falls back to the plain "{TEAM}: NO UPCOMING GAMES" text -- a normal,
     steady state, not an error, and there's no card to build around.
   - **news**: fetches and parses an RSS feed (see "The News card" below
     for how the feed URL is chosen), draws up to 2 headlines -- each
     word-wrapped across up to 2 lines rather than truncated to 1, so a
     headline reads in full far more often -- in the same bordered card
     style as the Game Day card. An empty/unreachable-but-responding feed
     falls back to plain
     "{LOCATION}: NO HEADLINES FOUND" text.
3. Re-packs to the device's 1-bit format and overwrites `.bin` / `.png`.
4. **Countdown** only: once the target date has passed, deletes
   `-dynamic.json` / `-base.png` (so this device stops being picked up)
   and leaves the last real `.bin`/`.png` as-is -- the board freezes on
   whatever it last showed (typically "TODAY!") rather than going blank or
   counting into negative numbers.
5. **Team and News** layers never get cleaned up this way -- they're
   perpetual (a schedule renews every season, a news feed publishes new
   items indefinitely). A transient fetch failure throws instead of
   returning null, which the caller treats as "leave this device alone and
   try again tomorrow," never as "give up on it."

## The Game Day card

`design-v2`'s live preview draws the REAL Game Day card -- banner, both
teams' dithered logos, matchup, days-remaining, date/venue -- directly
onto the canvas as soon as a game is found, and that's what publishes on
day one too. Getting there needed CORS-clean pixel access to the logo
images (drawing an image onto the same canvas that gets packed into the
device's `.bin` taints that canvas for any cross-origin image without
permissive CORS headers, and ESPN's logo CDN doesn't send any), so
`espnProxy` gained a `kind=logo` mode: it fetches the logo server-to-
server (never subject to CORS) and streams it back with its own
permissive headers, restricted to `https://*.espncdn.com` URLs only (not
an open image relay). The browser then dithers it client-side with the
exact same Atkinson algorithm the Photo tool's "Normal Photo" style
already uses, mirroring `ditheredLogoCanvas`/`drawGameDayCard` here.

The daily job still redraws the card every day regardless (the game/date/
venue change as the season progresses) -- the live preview just means the
customer sees the real thing immediately instead of a placeholder that
upgrades itself a day later.

Logo URLs come from ESPN's `logo` / `logos[0].href` team fields (see
`extractLogoUrl` in `lib/dynamic.js`) -- unverified field names, same
caveat as the rest of this API, degrades to no logo (not a broken image
or a thrown error) if either team has none. A failed logo fetch (network
error, 404, bad image data) is likewise swallowed to "no logo for that
side," never a reason to fail the whole card.

## The News card

Unlike Countdown (any date works) or Team (ESPN's API covers every team),
there's no single API that covers "news for any US town," so the News
tool doesn't try to maintain a lookup table of feeds per town/state. The
customer instead types a free-text **Location** (e.g. "Ocean City, NJ"),
which builds a Google News RSS search URL for that text
(`news.google.com/rss/search?q=...`) -- this works for essentially any
place name, not just towns big enough to have their own dedicated local
news feed. Alternatively they can paste a specific **RSS feed URL** of
their own choosing (their local paper's, a Patch.com town feed if one
exists, whatever) in an "advanced" field, which always overrides the
location search. See `newsFeedUrl` in `lib/dynamic.js`.

**Neither of these has been confirmed against a live response** the way
ESPN's schedule shape eventually was -- this needs the same kind of live
smoke test (deploy, publish a News layer, and check what actually shows
up) before fully trusting it. The RSS parsing itself
(`parseRssHeadlines`) is a small dependency-free `<item>`/`<title>`
extractor rather than a full XML parser -- deliberately kept simple since
RSS 2.0's shape is stable and well-established, but a feed with unusual
structure (e.g. Atom instead of RSS, deeply nested titles) could still
slip through and yield zero headlines, which just renders the same
"NO HEADLINES FOUND" fallback as a genuinely empty feed rather than
erroring.

`design-v2`'s live preview shows the real card (banner + real headlines)
too, via `newsProxy`: an `onRequest` function that fetches + parses the
feed server-to-server -- same CORS reasoning as `espnProxy` -- and hands
back already-**parsed** headline strings (not raw feed XML), reusing
`fetchHeadlines`/`parseRssHeadlines` directly so the preview and the real
card can never disagree about what a feed's headlines are. Unlike
`espnProxy` there's no fixed hostname to whitelist here (the customer can
point `feedUrl` at literally any feed), so `newsProxy` -- and the daily
job's own `newsFeedUrl`, since customers publish this feedUrl too, not
just preview it -- both run it through `isSafeFetchUrl` first: rejects
anything that isn't plain http/https, and rejects private/link-local IP
literals (most importantly `169.254.169.254`, Google Cloud's instance
metadata endpoint -- letting this function fetch an arbitrary customer-
supplied URL without that check would let a malicious `feedUrl` steal
this function's own service-account token). This does **not** protect
against DNS rebinding (a hostname resolving to a private IP only at fetch
time, after the check already passed) -- see `isSafeFetchUrl` in
`lib/dynamic.js` for the exact boundary.

## The Tide & Fishing card

Unlike Team/News, this one doesn't duplicate its data-shaping logic
between the live preview and the daily job -- both call `lib/astro.js`'s
`fetchTideCardData` directly. Twilight bounds, moon phase naming, and
NOAA's date/timezone quirks are exactly the kind of thing that quietly
drifts out of sync if reimplemented a second time in browser JS, unlike
Team's `findNextGame` (simple enough to keep in sync by hand) or News's
RSS parsing.

Three data sources, all free/no API key:
- **suncalc** for civil dawn/dusk, sunrise/sunset, moonrise/moonset, and
  moon phase/illumination.
- **NOAA CO-OPS** (`api.tidesandcurrents.noaa.gov`) for tide predictions,
  using the station ID already saved per-device on the Location page
  (`locations/{id}.json`'s `stationId`). Two calls: hourly `predictions`
  for the smooth curve, and `interval=hilo` for precise high/low times.
- **tz-lookup** derives the IANA timezone from lat/lon so every time
  (sun, moon, tide) is formatted the same way via `Intl.DateTimeFormat`
  (handles DST correctly) -- NOT NOAA's own local-time strings, which
  would require trusting NOAA's per-station timezone handling as the
  single source of truth for sun/moon times too.

The tide curve and every high/low/dawn/dusk time are all requested and
compared in **GMT** (`time_zone=gmt` on every NOAA call), specifically to
avoid parsing NOAA's local-time-labeled strings against suncalc's UTC
instants -- two different "local" interpretations would drift by the
station's UTC offset. Local-time display is applied in exactly one place
(`formatLocalTime`), after everything is already aligned as real UTC
instants.

The card layout (`drawTideCard` / `drawTideCardClient`) clips the curve
to the dawn-to-dusk window -- "the time before sunrise and after sunset,
but not full darkness," per the original ask -- and pins high/low labels
to their own fixed vertical band rather than floating them off the
dot's data-driven height. Early mockup iteration repeatedly hit label-
overlap bugs from the floating approach (a label 30px above an unusually
tall high tide could collide with the row above it); a fixed reserved
band per label type structurally can't have that problem, regardless of
the day's actual tide range.

**Not live-tested against NOAA or Open-Meteo** from the sandbox this was
built in -- outbound network there is allowlisted and neither host is on
it (both returned a 403 from the sandbox's own egress proxy, not from
NOAA). Built against NOAA's long-stable, publicly documented JSON shape
and covered thoroughly with mocked tests (`test/astro.test.js`,
`test/astroProxy.test.js`); needs the same live smoke test ESPN/RSS
eventually got -- deploy, publish a Tide layer, and check what actually
shows up -- before fully trusting a real station's response shape.

**NOAA is the only failure that takes the whole card down.** A live 502
from `astroProxy` ("Couldn't reach NOAA/sun-moon data right now") after
deploy showed Open-Meteo's weather call was still able to fail the entire
card even though the tide curve itself -- the one thing the card actually
can't function without -- had nothing to do with it. `fetchTideCardData`
now wraps the `fetchWeatherSignals` call in its own try/catch: an
Open-Meteo outage (or a location just outside its marine model's
coverage) logs and degrades to `weather: null` instead of throwing, same
principle as swell/water-temp already degrading field-by-field inside
`fetchWeatherSignals` itself. The NOAA fetch above it is deliberately left
alone -- it should still fail the whole card, since there's no tide data
to draw without it. See `test/astro.test.js`'s two tests contrasting an
Open-Meteo-only outage (degrades) against a genuine NOAA outage (still
fails).

**All three outbound fetches now send a browser-like User-Agent**
(`OUTBOUND_FETCH_HEADERS`, moved into its own `lib/http.js` so both
`astro.js` and `dynamic.js` can use it without a circular require --
`dynamic.js` already requires `astro.js` for `fetchTideCardData`). The
502 above turned out to still be happening after the Open-Meteo-outage
fix, so this applies the same category of fix that resolved a live ESPN
CDN logo failure (`fetchDitheredLogo`): Node's own bare fetch() default,
`User-Agent: node`, is a plain bot signal that's a common, unsophisticated
thing for an API/CDN to reject by default. This is NOT a confirmed root
cause here either -- both NOAA and Open-Meteo are policy-blocked from
this development sandbox too, so it couldn't be reproduced directly --
but it's a real, demonstrated fix for the same class of problem
elsewhere in this codebase, applied on that theory. If the live error
persists after this, the next step is the astroProxy function's actual
Cloud Function logs (`logger.error`'s underlying message), which is the
only place the true cause is visible.

**The actual root cause, found from those Cloud Function logs**: neither
of the two fixes above was it. NOAA itself was rejecting the request --
`"No Predictions data was found. Please make sure the Datum input is
valid."` -- for a real production station (`8534975`). The predictions
fetch hardcoded `datum: "MLLW"` (Mean Lower Low Water), which is only
computed for stations with enough tidal-epoch history behind them; a lot
of subordinate/harmonic prediction stations (this one included) don't
have it and only support `"STND"` (station datum) -- the one arbitrary
local reference every CO-OPS station is guaranteed to have, regardless of
type. Switched to `STND`. Safe everywhere: the card never displays which
datum a height is relative to, and NOAA's hi/lo `"type": "H"/"L"`
classification is about the local curve shape, not the datum -- changing
it only shifts every height by a constant, it doesn't change which points
count as highs and lows. See `test/astro.test.js`'s test asserting the
outbound request uses `datum=STND`, plus one reproducing this exact NOAA
error message for a station that doesn't support the requested datum.

The earlier two fixes (Open-Meteo resilience, browser-like headers)
weren't wrong to make -- they're real improvements on their own terms --
but they weren't *this* bug. Worth remembering next time: a live error
message that survives two independent, plausible-sounding fixes is a sign
to stop pattern-matching against past bugs and go straight to the actual
log line first.

**...except switching to `STND` didn't fix it either** -- redeployed,
same exact error, byte for byte, for the same station. That rules out
datum entirely: if it were a real datum-support problem, `STND` (which
every CO-OPS station is guaranteed to have) would have worked. The far
more likely explanation is that `8534975` is a "time only" subordinate
station -- NOAA CO-OPS distinguishes stations with full time-AND-height
harmonic predictions from ones that only carry a time offset from a
reference station, with no height curve computed for them at all. No
datum will ever produce a height curve for one of those; the "Datum
input is valid" wording is just NOAA's generic wrapper message for
several different "no predictions data" cases, this being one of them.

Rather than guess a fourth datum/header/network-shaped fix, this is
handled as what it now looks like: a small, real subset of the NOAA
"tidepredictions" station list (the same list the Fishing Spot picker's
station search draws from) genuinely has no height predictions to serve,
for any request. `fetchNoaaPredictions` tags this specific failure mode
-- a well-formed JSON `error` response from NOAA, meaning NOAA was
reached fine and gave a clear answer -- as `err.noaaDataError = true`,
distinct from a thrown/network-level failure (timeout, DNS, a bad
response body). `astroProxyHandler` checks for that tag and responds
`422` with an actionable message ("This tide station doesn't have full
predictions available... try picking a different station in Fishing Spot
settings") instead of the generic `502` "Couldn't reach NOAA" message,
which wrongly implied retrying later would help. design-v2 already
surfaces `err.message` verbatim in the tide tool's status line, so this
message reaches the customer as-is. See `test/astroProxy.test.js`'s test
contrasting this against the still-502 generic-network-failure case, and
`test/astro.test.js`'s tests confirming the tag on both the original
unknown-station error and this real "Datum input is valid" one.

**Solunar major/minor periods** (Phase 2) aren't provided by suncalc,
unlike everything else here -- there's no closed-form time for lunar
transit the way there is for solar noon. `computeSolunarPeriods` finds
it numerically: sample the moon's altitude (`SunCalc.getMoonPosition`)
every 2 minutes and look for local maxima (overhead) and minima
(underfoot) -- both count as "major" periods, 2 per lunar day, ~12.4h
apart. Minor periods are simpler: centered on moonrise/moonset, which
suncalc already gives directly.

A tempting shortcut -- "transit should be the midpoint of moonrise and
moonset" -- turned out to be **unreliable** and was dropped after
checking real output: `getMoonTimes` can return a rise/set pair that
don't actually bracket the same transit (the moon rises ~50min later
each day, so a given day's "set" is sometimes left over from the
previous day's rise), which makes their midpoint land near the wrong
extremum entirely. Direct altitude sampling has no such pairing
ambiguity, and was verified against real `SunCalc` output (consecutive
extrema alternate max/min and land ~12.3-12.6h apart, exactly the
expected spacing) before being trusted -- see `test/astro.test.js`.

**The fishing score** (`Fair`/`Good`/`Excellent`) is an explicit
heuristic, not a scientific claim -- two pieces of classic angling
folklore, same honesty standard as the "ESPN's API is unofficial" and
NOAA-not-live-tested notes above: (1) tidal range is greatest near new/
full moon and least near the quarters, and (2) fish are said to feed
more actively while the tide is running, not near slack, so a major/
minor period overlapping a fast-moving stretch of today's curve
(computed via `tideRateOfChange`, relative to the day's own fastest
stretch rather than a fixed ft/hr number, so it scales with each
location's actual tidal range) is a second positive signal. Phase 2 alone
has no NEGATIVE signal -- Phase 3 (below) adds one, so the score can now
actually reach `Poor`.

**Weather** (Phase 3), from Open-Meteo's free Weather + Marine APIs (no
key, lat/lon only): current wind speed/direction, a pressure trend
(rising/falling/steady, comparing "now" to ~6h ago -- `computePressure`
requires that 6h-ago reading to actually be close to 6 hours away, not
just whatever point happens to be nearest in a short series, since a
naive nearest-point lookup would happily call a same-instant reading
"6 hours ago" if that's all the data available), rain windows (contiguous
hours over a probability threshold, merged and clipped to the dawn-dusk
window), a wind "ramp" call-out (a later, meaningfully higher wind speed
worth a heads-up -- both an absolute floor and a real jump over current
conditions have to clear before it's flagged, so a currently-breezy day
doesn't trigger a false alarm), and swell height/period + sea surface
temperature (the last one nullable -- Open-Meteo's nearshore US water-
temp coverage is inconsistent, handled by omitting it rather than
showing a wrong/stale number, same principle as the tide extrema/
solunar-period null-handling elsewhere in this file).

Rain/wind call-outs replace the quiet Sunrise/Sunset line with a bold
alert strip -- the single boldest text on the card besides the title --
on any day there's something to flag, falling back to Sunrise/Sunset on
an ordinary day. Rain also gets small tick marks on the chart itself,
visually distinct from the solunar hatch bands so the two kinds of
"shaded window" are never confused. The weather footer row uses a
bold-value/quiet-label pattern throughout (`drawLabelThenValue`) so the
actual numbers are what stand out, not the words around them.

Weather now also feeds the fishing score: calm wind + steady/rising
pressure is a positive signal, high wind or a sharp pressure drop is
negative -- this is what lets the score reach `Poor`.

**A real bug caught only by looking at the rendered output, not by the
unit tests that were passing at the time**: `drawLabelThenValue` didn't
reset `ctx.textAlign` itself, so when the wind line ran right after the
moonrise/moonset line (drawn right-aligned), "Wind 8 mph NW" rendered
right-aligned too -- collapsing backward into the wind arrow icon
instead of extending rightward. Every unit test drew in isolation and
never exercised that particular sequence, so nothing caught it until an
actual screenshot of the real app did. Fixed by making the helper
self-contained (it sets its own `textAlign` unconditionally now), with
a regression test added afterward that specifically renders the two
lines in sequence.

**The Fishing Spot picker** (Phase 4, in `design-v2/index.html`) lets a
customer point this card at a second, independent location -- a favorite
pier or inlet, not necessarily where the clock itself sits. Saved to
`locations/{deviceId}-fishing.json` (Storage Rules updated to allow the
`-fishing` suffix), completely separate from the device's main
`locations/{deviceId}.json` used by Wave/Weather Forecast, Sunset, etc.
`resolveTideLocation()` checks for the fishing-spot file first and falls
back to the device's main location when it's absent -- so a customer who
never touches this picker sees no behavior change at all.

The picker itself reuses the exact same mechanics already proven live in
`location/index.html`'s own map/station picker, not a new pattern:
Nominatim (free, no key) for town search, the NOAA CO-OPS station
metadata endpoint (`mdapi/prod/webapi/stations.json?type=tidepredictions`)
fetched once and filtered by haversine distance (≤100mi, closest 8) for
nearby tide stations, and Leaflet + OpenStreetMap tiles (no key) for the
map itself.

**Leaflet couldn't be loaded from this development sandbox either** --
`https://unpkg.com/leaflet@1.9.4/dist/leaflet.js` failed with
`ERR_TUNNEL_CONNECTION_FAILED` from the sandbox's own network proxy, the
same category of restriction that blocked live NOAA/Open-Meteo testing
elsewhere in this file. The picker degrades gracefully without it (a
`typeof L === "undefined"` guard skips just the map, verified directly),
and everything that doesn't depend on the map itself -- search, the
station list, selecting one, saving, removing -- was verified working
end-to-end with Playwright, mocking Nominatim/NOAA/tile responses.
`location/index.html` already uses this identical CDN/tile setup live in
production, so this is a sandbox limitation, not an unproven approach --
but the map specifically is worth a quick look after deploying.

## Known tradeoffs

**Timezone**: this runs once, at a fixed UTC hour, for every device
regardless of where it actually is. A device very close to its own local
midnight can be briefly a day ahead or behind of the count for a few hours
until the next run. Not worth solving until it's an actual reported
problem -- doing so would need a per-device timezone (derived from its
saved lat/lon) and per-device run times instead of one shared daily run.

**ESPN's API is unofficial**: no key, no SLA, no support -- reverse
engineered by developers, and it could change or be blocked without
notice. The response shape used here (`lib/dynamic.js`'s `findNextGame`/
`fetchNextGame`) was built from well-established, widely-documented
community knowledge and has since been confirmed reachable live (see the
CORS note below), though a full live schedule response hasn't been
diffed field-by-field against what was assumed while building this.

**ESPN started returning an HTML block page instead of JSON, then started
working again on its own -- still not fully understood**: right after the
live-preview proxies shipped, every `espnProxy` request for "teams"/
"schedule" started failing with an HTML response ("Couldn't reach ESPN,"
logged underneath as a `SyntaxError` trying to parse `"<HTML><HEA..."` as
JSON) -- confirmed via the function's own logs (Firebase Console ->
Functions -> espnProxy -> Logs), while direct browser access to the same
ESPN URL, and this same Cloud Function's `logo` requests to ESPN's
separate CDN domain (`a.espncdn.com`), both kept working throughout.

Several things were tried in sequence -- adding a `User-Agent` (didn't
help), removing it again (didn't help either, but access returned shortly
after, unprompted, and has stayed working since). None of the header
changes cleanly explain the fix; the working theory is that it resolved
itself (a rolling rate limit, or an IP reassignment from Google's shared
egress pool) rather than anything in this code. Because of that, and
because there's no live evidence this specific endpoint has a
`User-Agent` problem, `fetchNextGame` (in `lib/dynamic.js`) and
`espnProxyHandler`'s "teams"/"schedule" branch (in `index.js`)
deliberately do NOT send `OUTBOUND_FETCH_HEADERS` -- it's currently
working without it, so it's left alone rather than risked.

**The same shape of problem hit the News feature's RSS fetch, but the fix
here was different and more concrete**: the News tool's live preview
showed no headlines, failing first with a `503` from Google News RSS,
then a `403` from a completely unrelated, ordinary feed (NPR) used to
rule out "is this a Google News-specific problem" -- both confirmed via
the `newsProxy` logs, and both URLs worked fine from a direct browser
hit. Waiting (the thing that apparently fixed the ESPN case) did NOT fix
this one.

Chasing this further, the actual bug was found by testing directly
rather than guessing: `fetchHeadlines` had ALSO had its `User-Agent`
header removed (same reasoning applied as ESPN, same lack of result), but
"removing the header" was never actually verified to mean "no suspicious
header" -- it just means Node's `fetch()` falls back to its OWN defaults.
A local test (a bare Node HTTP server, hit with a header-less `fetch()`)
confirmed those defaults are `User-Agent: node` and `Accept-Language: *`
-- neither of which any real browser has ever sent, and `User-Agent: node`
in particular is about as plain a "this is a script" signal as exists.
So the "remove the header" experiment never actually tested a clean
request; it just swapped one bot signature for a different, more obvious
one. Fixed by giving `fetchHeadlines` a real `User-Agent` +
`Accept-Language` (see `OUTBOUND_FETCH_HEADERS`) -- `Accept` is
deliberately left alone, since Node's own default (`*/*`) already
matches what a real browser's `fetch()` sends.

That fix held for a while, then the RSS fetch broke a THIRD time --
confirmed live via the same logs, Google News back to `503`, NPR back to
`403` -- with the corrected header still in place and unchanged (verified
by diffing `fetchHeadlines` against the exact commit that was last
confirmed working: zero difference). So the header wasn't wrong; Google
News/NPR started blocking the request again regardless of what header it
carried. Meanwhile ESPN's "teams"/"schedule" fetch, which sends NO custom
header at all, kept working the entire time. Since a real header no
longer helps and the one thing demonstrably still working elsewhere in
this file is sending no header, `fetchHeadlines` now matches that --
`OUTBOUND_FETCH_HEADERS` is no longer sent on the RSS fetch either. This
is an experiment based on what's currently working, not a diagnosed root
cause -- unlike the Node-defaults fix above, there's no local repro
proving the mechanism this time, just the live evidence that the
headerless request pattern is the one still succeeding. If RSS breaks
again, check the logs for the exact status first (a `503`/`403` is
Google/NPR's own server responding, not a local bug) before assuming
either direction on headers is automatically the fix.

ESPN's "teams"/"schedule" fetch itself is untouched throughout all of
this -- it's never shown a live problem, so there's no reason to risk it
just for theoretical consistency with the RSS fetch.

**ESPN blocks direct browser calls (CORS) -- confirmed live, and fixed**:
design-v2's Team tool originally called `site.api.espn.com` straight from
the browser for its live preview. That failed in production ("Couldn't
load teams") -- confirmed by loading the same URL directly in a browser
tab (works, returns real JSON) versus the page's own `fetch()` call to it
(blocked), which is the signature of a CORS rejection: ESPN's response
doesn't include headers granting waveclock.net's JavaScript permission to
read it, even though the URL itself is publicly reachable.

The fix is `espnProxy`, an `onRequest` HTTP function in this same
`functions/` deployment: design-v2 now calls `espnProxy` (same-origin as
far as CORS logic goes, since the function itself sends permissive CORS
headers back), which makes the actual ESPN request server-to-server --
and server-to-server calls were never subject to CORS in the first place,
browsers only enforce it for script-initiated requests. The **daily
regeneration job above is unaffected** -- it already called ESPN directly
from server-side code, so it was never subject to this bug.

This means the Team tool's live preview (picking a league/team and seeing
"who do they play next") **cannot work at all until this Cloud Function
is deployed** -- unlike Countdown, which works standalone and only needs
the deploy for the *daily* auto-update. `espnProxy` deploys as part of
the same `firebase deploy --only functions` as everything else here, no
extra step.

## Deploying

**Automatic**: `.github/workflows/deploy-functions.yml` runs `npm test`
then `firebase deploy --only functions` by itself whenever `functions/`
changes on `main` -- so a merged PR ships on its own, no terminal needed.
It also supports a manual trigger (`workflow_dispatch`, runnable from
GitHub's Actions tab -- including the mobile web UI -- or via the API)
for re-running a deploy that isn't tied to a fresh push.

This needs a one-time setup, done by a human with project access:

1. **Upgrade the Firebase project to the Blaze (pay-as-you-go) plan** if
   it isn't already -- Cloud Functions require it. Realistic cost for this
   job is well under $1/month at any scale this business is likely to
   reach (see the cost breakdown discussed when this was built).
2. Create a Google Cloud service account for deploys: **Google Cloud
   Console -> IAM & Admin -> Service Accounts -> Create Service Account**
   (any name, e.g. `github-deploy`), grant it the **Cloud Functions
   Admin**, **Service Account User**, and **Firebase Admin** roles (or
   just **Editor** if keeping it simple is preferred over the tightest
   possible scope).
3. On that service account: **Keys -> Add Key -> Create new key -> JSON**
   -- downloads a `.json` credentials file. Treat this like a password;
   it grants deploy access to the whole Firebase project.
4. In this GitHub repo: **Settings -> Secrets and variables -> Actions ->
   New repository secret**, name it `FIREBASE_SERVICE_ACCOUNT`, and paste
   the entire contents of that downloaded JSON file as the value.
5. That's it -- the next push to `main` touching `functions/` (or a
   manual run of the workflow) will deploy using that key. All of the
   above can be done from a phone browser; no local terminal needed
   for this one-time setup either.

**Manual** (still works, e.g. for testing a deploy before pushing):

1. Install the Firebase CLI if you don't have it: `npm install -g firebase-tools`
2. `firebase login`
3. From the repo root: `firebase deploy --only functions`

## Local testing (no live Firebase project needed)

```
cd functions
npm install
npm test
```

Runs `test/dynamic.test.js` (pure rendering/packing/date-math/next-game/
RSS-parsing/SSRF-guard logic, including synthetic ESPN- and RSS-shaped
responses), `test/orchestration.test.js` (the per-device list/download/
render/upload flow, against an in-memory fake Storage bucket),
`test/espnProxy.test.js` (the proxy's request validation, ESPN-forwarding,
and logo-forwarding logic), and `test/newsProxy.test.js` (request
validation, headline-forwarding, and the SSRF rejection) -- none of these
touch anything real, ESPN included.
