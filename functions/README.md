# Dynamic-layer auto-update Cloud Function

Runs once a day (09:00 UTC) and redraws the current content for every
device with an active "dynamic layer" published from `/design/` -- a
**Countdown** (a target date), a **Team Schedule** (next game for a
picked sports team), **News** (headlines for a location or RSS feed),
**Tide & Fishing** (tide curve + moon phase/rise/set for the device's
saved location), or **Beach Buddy** (a single recurring illustrated
character whose pose/headline is driven by that same tide/weather data
-- see its own section below) -- overwriting `designs/{deviceId}.bin`
and `.png` in place. The device itself needs no changes -- it already
reads those two files unconditionally.

## How it fits together

`design/index.html` publishes up to four files per device when a
Countdown, Team, News, or Beach Buddy layer is on the canvas:

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
  - `{ type: "beachBuddy", lat, lon, stationId, inverted }` -- same
    lat/lon/stationId shape as `"tide"`, no other settings; see "Beach
    Buddy" below.

If there's no Countdown, Team, News, or Beach Buddy layer, `design`
deletes the `-base.png` / `-dynamic.json` files instead (best-effort) so
this job has nothing to find for that device. At most one dynamic layer
is treated as active per device for now -- if a customer somehow adds
more than one, only the first one found governs auto-updates.

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

`design`'s live preview draws the REAL Game Day card -- banner, both
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

### Win-loss records

Each team's current record (e.g. "8-3") comes from a THIRD ESPN
endpoint, distinct from the two already in use: `espnTeamUrl` (the
single-team detail endpoint, `.../teams/{teamId}`) rather than
`espnTeamsUrl` (the whole-league list, used for the picker dropdown) or
`espnScheduleUrl` (this team's games, which carries no record field).
`extractRecordSummary` reads `team.record.items[].summary`, preferring
the entry typed `"total"` over array order. Same unverified-field-name
caveat as everything else here, and unlike the schedule/logo endpoints
this one hasn't been confirmed against a live response at all yet --
publish a Team layer and check the live preview before fully trusting
it. Degrades to `null` on any failure (missing teamId, network error,
bad status, unexpected shape) rather than throwing -- a record is a
nice-to-have, not load-bearing, so a broken record fetch should never
take the whole card down (see `fetchTeamRecord`).

The live preview reaches this endpoint through `espnProxy`'s new
`kind=record` mode, same CORS reasoning as `kind=schedule`/`kind=teams`.
The daily job calls `fetchTeamRecord` directly (server-to-server, never
subject to CORS), same as `fetchNextGame`. Neither the live preview nor
the daily job cache the fetched record anywhere -- like the schedule and
logos, it's fetched fresh every time from just `sport`/`league`/`teamId`
in `designs/{id}-dynamic.json`, so there's no extra state to keep in
sync or go stale.

**Placement**: this card was already using every pixel of its 272px
height before records existed (see `drawGameDayCard`'s own comment), so
there was never a dedicated place to put a third piece of information
without shrinking something that was already there. Two placements are
tried, in order, neither of which shrinks the logos, the headline's own
max font size, or anything else already on the card:

1. **Over the logo**: the record is drawn as its own text, centered
   over each logo, sharing the headline's baseline -- but only when the
   plain "TEAM VS TEAM" headline, at its own completely unmodified
   auto-fit size, already leaves enough real horizontal gap between its
   own edge and that logo (see `fitRecordOverLogo`). This room has to
   already exist, not be manufactured by shrinking the headline to make
   space. In practice this needs short team names -- most pro-league
   matchups get it, most full college names don't.
2. **Folded into the headline**, bookending it with a dot separator
   ("`8-3  ·  PENN STATE VS MARSHALL  ·  2-9`") when there isn't room
   for #1. The extra spacing around each dot is purely cosmetic, so
   `buildPaddedRecordHeadline` gives it up first -- one space at a time,
   at the headline's full 24px size -- before the font itself is ever
   allowed to shrink below that ceiling (down to the usual 16px floor).
   Losing some whitespace is free; losing readable text size isn't.

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

`design`'s live preview shows the real card (banner + real headlines)
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
which wrongly implied retrying later would help. design already
surfaces `err.message` verbatim in the tide tool's status line, so this
message reaches the customer as-is. See `test/astroProxy.test.js`'s test
contrasting this against the still-502 generic-network-failure case, and
`test/astro.test.js`'s tests confirming the tag on both the original
unknown-station error and this real "Datum input is valid" one.

**The "time only" subordinate-station theory above was also wrong.** A
second station (`8535838`) hit the exact same error, which pointed away
from "one unlucky station" and toward something systemic. Confirmed by
bypassing this codebase entirely -- hitting NOAA directly from a browser
with the customer's own connection, comparing a known-good reference
station (Atlantic City, `8534720`) against the two failing ones:

- Atlantic City worked fine with this code's exact request shape
  (`time_zone=gmt`, `datum=STND`, a narrow same-day window) -- so the
  request format itself was never the problem.
- The failing station returned the identical error under `interval=h`
  **and** `interval=hilo` -- ruling out a curve-vs-hilo capability split.
- The failing station's predictions request succeeded the moment
  `time_zone` changed from `gmt` to `lst_ldt` -- same station, same
  interval, same datum, nothing else different.

That's the actual, complete cause: **`time_zone=gmt` silently breaks
predictions for subordinate stations.** Best-guess mechanism (not
verified against NOAA's internals, just consistent with everything
observed): a subordinate station's predictions are computed as a time/
height offset applied to a reference station, anchored to *local*
calendar days -- a GMT-specified request window can straddle a different
local calendar day than intended, breaking that computation, while a
reference station's own full harmonic computation doesn't care either
way. That's exactly why Atlantic City worked under both time zones the
whole time, masking the bug until a subordinate station was actually
tried against it.

Fixed by switching every request to `time_zone=lst_ldt` (the station's
own local time) instead of `gmt`. That means `begin_date`/`end_date` must
now be sent in local wall-clock time too (not UTC), and the returned `t`
values need converting from local-wall-clock-in-a-zone back to a UTC
instant -- neither direction has a JS built-in, so `noaaLocalDateParam`
and `parseNoaaLocalTimestamp` replace the old `noaaDateParam`/
`parseNoaaGmtTimestamp`, using the same `timeZone` (from `tzlookup`)
already computed for display formatting elsewhere in this file. The
datum (`STND`) and header (`OUTBOUND_FETCH_HEADERS`) fixes from the two
earlier attempts remain in place -- neither was wrong to make, just not
this bug -- and this is why: a live error surviving three independent,
individually-plausible fixes (network headers, then datum, then a wrong
theory about station capability) meant the actual cause was still
unfound, and the only way to pin it down for certain was a controlled,
one-variable-at-a-time comparison against NOAA directly, bypassing this
codebase's own request-building code so a bug in the code couldn't hide
in the result. See `test/astro.test.js`'s tests for `noaaLocalDateParam`/
`parseNoaaLocalTimestamp` (including a same-string-different-zone case,
and a same-zone-different-season case to confirm DST is resolved
correctly rather than a fixed offset), and the test asserting
`time_zone=lst_ldt` is actually sent.

**`time_zone=lst_ldt` was necessary but not sufficient.** The customer
retested after that fix deployed and the card still didn't load. Isolated
it one variable at a time again, hitting NOAA directly, keeping
`time_zone=lst_ldt` fixed throughout:

- `datum=STND` failed on **both** `interval=h` and `interval=hilo`.
- `datum=MLLW` also failed on `interval=h` -- but succeeded on
  `interval=hilo`.

Two more things this whole investigation had gotten wrong turned out to
both be real, at the same time:

1. **`STND` isn't actually universal.** The earlier switch from `MLLW` to
   `STND` was based on NOAA's own documentation calling `STND` the
   guaranteed fallback every station supports -- true in principle,
   apparently not true in practice for this station. Reverted to `MLLW`,
   which is what actually works, and which is also what real customers
   would expect anyway (the datum ordinary tide charts and other tide
   clocks use). No fallback chain between the two -- there's no evidence
   `STND` is ever actually needed, and adding speculative complexity for
   an unconfirmed case isn't worth it.
2. **This station has no continuous curve at all, at any datum.** This
   was the *original* theory (a "time only" subordinate station), dropped
   too early -- the test that seemed to disprove it (`interval=h` and
   `interval=hilo` failing identically under `STND`) was confounded by
   also being under the wrong `time_zone`, which broke everything
   regardless of interval and masked the real, narrower distinction.
   With `time_zone` and `datum` both correct, the split is real and
   specific to `interval=h`: this subordinate station only has time/
   height-offset hi/lo predictions from a reference station, with no
   harmonic curve ever computed for it.

`fetchTideCardData` now treats these two NOAA calls with different
criticality, the same resilience principle used everywhere else in this
file: `interval=hilo` (the day's actual high/low points) is the one
thing the card can't function without, so a failure there still fails
the whole card. `interval=h` (the continuous curve, nice-to-have on top)
degrades to an empty array on a confirmed `noaaDataError` -- but NOT on
a genuine network-level failure, which still fails the whole card, since
that's a real problem rather than a known data-availability fact. Both
NOAA calls still fire concurrently for latency; `curvePromise` gets a
no-op `.catch()` attached immediately so its own rejection is never
"unhandled" if `hiloPromise` throws first and execution never reaches
its own `try`/`catch` -- a real crash caught only by actually running
these two failure paths together in a test, not by inspecting the code.

`drawTideCard` already skipped drawing the curve line entirely for
`tideCurve.length <= 1` (from earlier sparse-data handling), so an empty
curve doesn't crash rendering -- but its height-scale calculation only
looked at `tideCurve`, which silently fell back to a fixed `[0,1]` range
whenever the curve was empty. That would have clipped real hi/lo values
(e.g. a real `3.777` from this exact station) off the top of the plot
instead of scaling to fit them. Fixed in both `dynamic.js` and
`design/index.html` (the client copy) by deriving the height range
from `tideExtrema` too, not just `tideCurve` -- a no-op in the normal
case (extrema already fall within the curve's own range) but load-bearing
for a hi/lo-only station. See `test/dynamic.test.js`'s regression test
rendering exactly that scenario and confirming the high-tide dot lands
within the plot's own y-range rather than off the top, plus
`test/astro.test.js`'s three tests covering: hilo-succeeds/curve-fails
(degrades, card still works), hilo-fails/curve-succeeds (still fails,
hilo is the load-bearing one), and a genuine non-`noaaDataError` failure
on the curve request alone (still fails -- only a confirmed "no data"
response degrades).

The moral, worth remembering the next time a live error survives a fix
that seemed to nail it: **isolate one variable at a time against the
real system, not against this codebase's assumptions about it** -- every
wrong turn in this investigation (headers, a too-broad datum theory, a
too-early-abandoned interval theory) came from changing more than one
thing at once, or trusting NOAA's documentation over what NOAA actually
does for a specific real station.

**A curved line for hi/lo-only stations, and larger/bolder text
throughout.** Once the card was actually rendering for a hi/lo-only
station, the two dots had no line connecting them at all -- correct
(nothing to crash on) but not very useful. `interpolateTideCurveFromExtrema`
(astro.js) synthesizes one: a cosine ("versine") ease between each pair
of consecutive extrema, sampled every 15 minutes. This isn't arbitrary --
a real tide's rate of change is genuinely ~0 right at a high or low and
fastest around the midpoint, which is exactly the shape a cosine
interpolation produces (a straight line would draw a sharp, physically
wrong corner at every hi/lo instead). It's the same curve shape behind
the "rule of twelfths" mariners have used by hand for centuries to
estimate tide height between known highs and lows. `fetchTideCardData`
only reaches for it when the real curve came back empty -- never in
place of real NOAA data. See `test/astro.test.js`'s tests confirming the
shape (monotonic, flat-sloped at both ends, each original extremum still
present exactly at the segment boundaries) and multi-extremum (a full
low-high-low-high day) behavior.

Every font on the card was bumped up, and several previously-light
elements (Sunrise/Sunset, the hi/lo time labels, moonrise/moonset, the
weather-row labels) switched to bold -- the request was simply "bigger
and bolder, find the space." The space came from the plot band itself:
trimmed from 64px to 40px, since it's just a simple rise-and-fall shape
and doesn't need much vertical resolution to read clearly. The reclaimed
~24px was redistributed across the top strip, both hi/lo label zones, and
the footer, all of which needed more line-height for the bigger text, not
just wider glyphs. Verified visually, not just by absence of exceptions:
rendered real PNGs (normal day, an alert-strip day, a 4-extremum day, a
hi/lo-only/interpolated-curve day, and a fully sparse weather day) and
inspected each for overlap or clipping before settling on final sizes --
same discipline as every other visual change in this file, since passing
tests alone already missed at least one real rendering bug earlier in
this project (the `textAlign` leak). Applied identically to `dynamic.js`
and the `design/index.html` client copy, per this file's usual
duplication convention.

**A second pass, with a hard floor: nothing on the card smaller than
18px** (matching the fishing badge/moon phase), plus trimmed wording
where the words no longer fit next to bigger numbers. Measured actual
text widths with `ctx.measureText` before touching layout, rather than
guessing:

- Moonrise/moonset kept its full words -- at 18px it still fits
  comfortably next to the moon phase name, even the longest one
  (`Waning Crescent`).
- The wind/pressure/swell/water-temp row did NOT fit at 18px with its
  old "Wind 8 mph NW · 1015 hPa (-6 in 6h)" / "Swell 2.1 ft @ 8s · 68°F
  water" wording -- the two clusters' widths overlapped by ~35px at the
  canvas's actual width. Dropped the "Wind"/"Swell"/"water" label words
  (each icon -- the wind arrow, the pressure trend arrow, the wave
  glyph -- already identifies its own number, the same convention
  "H"/"L" and the trend arrow already used even before this row was
  touched) and shortened the pressure delta from "(-6 in 6h)" to "(-6)"
  (always 6h, so the words added nothing). `drawLabelThenValue` (and its
  design client copy) became dead code once its only caller no longer
  needed a separate label -- removed rather than left unused.
- The MAJOR/MINOR solunar band label went from 11px to 18px italic --
  often wider than a MINOR period's own hatch band (only ~50min wide),
  which briefly looked like a real overlap bug with the curve/dot at a
  glance. A closer, full-resolution crop of the render showed the curve
  actually clears the label cleanly; the label's white halo box is sized
  to the text, not the band, and was already designed to extend past a
  narrow band's edges rather than clip -- worth noting since a low-res
  thumbnail read as broken when the real pixels weren't.
- The plot band itself needed to grow back from 40px to 44px (with the
  hi/lo label zones trimmed slightly to compensate) once the MAJOR/MINOR
  label doubled in height (16px box to 22px) -- the first attempt at 30px
  genuinely did put the badge and the curve in the same few pixels.
  Caught the same way as everything else here: by rendering and looking,
  not by computing the numbers on paper and assuming they'd work.

See `test/dynamic.test.js`'s alert-strip test, updated for this pass --
at the old, smaller sizes, checking one pixel worked for telling the
warning triangle apart from the fallback Sunrise text, but at 18px the
two now occupy overlapping x-ranges near the card's left edge (both
start close to the edge), so the test now checks a y just above where
the text's own ink starts, where only the triangle's apex reaches.

**A third pass: every piece of text is solid black, no gray.** Several
labels (Sunrise/Sunset, hi/lo time labels, moonrise/moonset, the footer
separator dots) were still drawn at a partial alpha (`rgba(0,0,0,0.75-
0.8)`) even after the two font-size passes above -- a holdover from when
those elements were meant to read as visually secondary next to bolder
neighbors. Switched every text `fillStyle` in `drawTideCard` (and the
`design/index.html` client copy) to solid `#000`. The dashed guide
lines (sunrise/sunset verticals, the plot's baseline, the leader ticks
connecting a dot to its label) are deliberately left at their existing
partial alpha -- those are lines, not text, and stay a lighter weight on
purpose so they read as structure rather than content.

**A fourth pass, from a reference mockup: a new title and an hourly
axis.** Two specific asks, not a full redesign against the mockup --
everything else about the card's structure stayed put.

- **Title** changed from "TODAY'S TIDE" to "DAILY FISHING FORECAST:
  TIDES & SOLUNAR", matching the reference image. Centering broke down
  immediately at this length -- the old centering offset was tuned for a
  ten-character title with nothing competing for space, and a
  forty-character one pushed straight into the fishing badge. Switched to
  left-aligned with a fixed 24px margin, which scales safely with title
  length the way a centering offset tuned for one specific string never
  can. `maxWidth` reserves room for the *widest possible* badge
  ("FISHING: EXCELLENT", not whatever score happens to be showing
  today) -- sizing against today's actual (possibly shorter) badge would
  silently start overlapping it the day the score is longer than
  whatever the reservation was tuned against. Caught a real version of
  exactly that bug in testing: an early attempt reserved space using a
  badge-width measurement taken *before* this card's fonts were
  registered in-process, which used narrower fallback-font metrics than
  the real bundled Bungee font -- looked fine in a quick check, then
  failed the moment "FISHING: EXCELLENT" (the actual longest score) was
  rendered with the real font. Worth remembering generally: canvas text
  measurements are only trustworthy once `ensureFontsRegistered()` has
  actually run in that process -- calling `drawTideCard` directly in a
  fresh script, the way a quick manual check tends to, silently uses
  fallback metrics unless something else already triggered registration.

- **Hourly axis** along the plot's bottom edge -- tick marks and labels
  ("6 AM", "9 AM", ...) so the curve's shape can be read against time of
  day without cross-referencing the H/L dot labels for it. Ticks land on
  round *local-clock* hours (using `card.timeZone`, the same field
  `fetchTideCardData` already returns), 3 hours apart, computed by
  reading dawn's local hour/minute via `Intl.DateTimeFormat` and rounding
  up to the next multiple of 3 -- not raw UTC hours, which would land at
  the wrong local clock times for any zone not on a whole-hour-from-UTC
  offset relationship with 3. Deliberately smaller (12px) than the rest
  of the card's 18px-minimum content text -- this is axis scaffolding,
  not content, the same distinction a chart's own axis labels always get
  and the reference mockup's own axis shows too.

  Fitting a genuinely new row required real space the existing layout
  hadn't budgeted for, not just visual tightening -- the plot's bottom
  edge, the low-value hi/lo labels, and the footer all shifted down to
  make room, verified the same way as every layout change in this
  file: rendering real scenarios (a normal day, an alert-strip day, a
  4-extremum day) at full resolution and checking for overlap before
  settling on final offsets. See `test/dynamic.test.js`'s test asserting
  a tick actually lands at the correct pixel for a known dawn time and
  zone (confirming it uses local time, not UTC) and a companion test
  confirming a card with no `timeZone` at all still renders without
  throwing (falls back to the runtime's own local time).

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

**The Fishing Spot picker** (Phase 4, in `design/index.html`) lets a
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

## The Sun/Moon/Tide Timeline card

A second, distinct tool from Tide & Fishing above (its own toolbar
button/`kind: "tideTimeline"`/`type: "tideTimeline"` dynamic layer, not a
variant of it) -- built from an extensive round of visual mockup
iteration with the customer before any production code existed, each
round verified against a real rendered PNG rather than a verbal
description. The whole board represents one local calendar day, midnight
to midnight, left to right, in three bands: a sun icon + town name/date
across the top, tide highs/lows above a time axis about two-thirds down,
and moon rise/set/overhead/underfoot events below it. There's no hour
axis at all -- every time on the card is its own label.

**Draw-then-invert, not per-element ink color.** The single biggest
design decision, proposed by the customer directly: draw the *entire*
card in the simple, uniform black-ink-on-white scheme with zero day/night
awareness, then invert the finished night-side pixel columns (before
sunrise, after sunset) as the very last step (`TIMELINE_invertNightColumns`
/ `timelineInvertNightColumnsClient`, `ctx.getImageData` → `255 - value`
per RGB channel → `ctx.putImageData`, alpha untouched). An earlier
per-element approach (pick ink color while drawing, based on whether that
element's x falls in day or night) kept breaking: a "SUNSET 7:39PM" label
whose own rendered width exceeded the available night-zone width had part
of itself land on the wrong-colored background, rendering white-on-white
and vanishing -- no per-element fix could avoid that without knowing the
final layout in advance. Inverting whole finished columns is correct by
construction for *any* element that happens to land there, including one
straddling the boundary itself. That's also why the sun icon
(`drawTimelineSunIcon` / `drawTimelineSunIconClient`) is deliberately
centered exactly on `sunriseX`/`sunsetX` and never clamped like the text
around it: the invert pass bisects it for free into a white-glyph-on-black
half and a black-glyph-on-white half, satisfying the "half dark, half
white" sun icon the customer asked for with no special-case logic.

**Data layer (`fetchTideTimelineData` in `lib/astro.js`) is deliberately
lighter than `fetchTideCardData`** -- no continuous tide curve (hi/lo
points only), no weather, no fishing score -- but covers a full local
midnight-to-midnight window instead of `fetchTideCardData`'s dawn-to-dusk
one. `moonEvents` combines rise/set/overhead/underfoot into one
time-sorted array (the same "array of events" shape `tideExtrema` already
uses) rather than fixed named fields, since a 24h window can rarely hold
exactly one of each -- the lunar day runs ~24h50m, not 24h, so a given
day can just as easily hold zero or two of any one event.

**Overhead/underfoot reuses `findMoonAltitudeExtrema`** (originally built
for solunar major-period fishing-score calculation) rather than adding a
second astronomical sampler: it now tags each transit with
`extremaType: "overhead"` (an altitude local maximum -- the moon crossing
the local meridian) or `"underfoot"` (a local minimum -- the antitransit
on the opposite side of the earth). `computeSolunarPeriods`, the existing
caller, only ever needed "this is a major-period center" and ignores the
new field entirely, so this is non-breaking.

**`localMidnight(now, timeZone)`** is a DST-safe local-midnight lookup
with no timezone library dependency, using a simpler one-pass technique
than this file's existing `parseNoaaLocalTimestamp`: `now` is itself a
real anchor instant, and `now`'s own local wall-clock time (via
`Intl.DateTimeFormat`) is exactly how far past local midnight `now`
already is -- so subtracting that off `now` lands on local midnight
directly, no guess-and-correct needed. (`parseNoaaLocalTimestamp` has to
invert an arbitrary wall-clock *string* with no anchor instant to measure
from in the first place, which is why it can't use this shortcut.)

**Live preview** goes through its own proxy, `astroTimelineProxy`
(`astroTimelineProxyHandler` in `index.js`) -- the same shape and
validation as `astroProxy`, but calling `fetchTideTimelineData` instead.
A distinct endpoint rather than a third `type` query param on the
existing one, since the two cards' payloads are genuinely different
shapes (see above), not just different content.

**The picker (`design/index.html`'s Timeline tool panel) requires both a
town name and a tide station up front** -- unlike Tide & Fishing's
device-location-with-an-optional-override model, there's no fallback
here at all; the customer picks both explicitly every time, since the
town name is itself rendered on the card. The picker's mechanics (town
search via Nominatim, nearby-station lookup via the same NOAA CO-OPS
station-list endpoint + haversine filtering, Leaflet + OpenStreetMap map)
are the Fishing Spot picker's own proven code, duplicated under a
`timeline`-prefixed set of functions/element IDs rather than shared --
consistent with this codebase's existing precedent of duplicating
UI/rendering logic between features rather than introducing a shared
abstraction for something this small. Picking a station sets the
layer's own `lat`/`lon`/`stationId`/`townName` directly (no separate
Storage write the way Fishing Spot's `-fishing.json` gets one) -- these
are this card's own core settings, published inline with everything else
in `-dynamic.json`.

**Not live-tested against NOAA** from this development sandbox, for the
same reason noted under the Tide & Fishing card above (NOAA isn't
reachable from here) -- covered thoroughly with mocked tests instead
(`test/astro.test.js`, `test/astroTimelineProxy.test.js`,
`test/dynamic.test.js`'s `drawTideTimelineCard`/`renderDynamicDesign`
suites, including pixel-level checks that the night-side background and
the sun icon actually invert correctly, not just "doesn't throw"). Needs
the same live smoke test the other cards eventually got: deploy, publish
a Timeline layer, and check what actually shows up.

## Beach Buddy

A single recurring illustrated character ("Buddy"), one new pose/
headline a day, driven entirely by the device's own real conditions --
no separate settings to publish at all beyond the same `lat`/`lon`/
`stationId` the Tide & Fishing card already uses (`{ type: "beachBuddy",
lat, lon, stationId, inverted }`). Unlike every other card here, it has
no black title banner and no border on purpose: one big headline, an
optional short subline, and the character -- meant to read as a
friendly daily greeting, not a data card.

**Mood selection (`moodForBeachData` in `lib/dynamic.js`) reuses
`fetchTideCardData` exactly as the "tide" type does** -- no second data
source, no extra NOAA/Open-Meteo calls. A fixed priority order picks
today's headline + pose from whatever that same payload already
contains: active rain beats rain later today beats a wind ramp/high
current wind beats a big daytime swell beats nighttime beats the day's
next tide extremum beats a calm-day default (with the water temperature
if Open-Meteo has one). Every branch degrades gracefully the same way
the Tide & Fishing card's own weather row does -- a missing/null
`data.weather` (a down Open-Meteo call) or empty `tideExtrema` just
falls through to a later branch instead of throwing, and only a genuine
NOAA failure (the one thing this card, like Tide & Fishing, can't
function without) fails the whole render.

**The character is illustrated by Imagen (via Firebase AI Logic /
Vertex AI), with a procedural vector-line stick figure as the
fallback** (`lib/imagen.js` + `drawBeachBuddyArtCard`/
`drawBeachBuddyCard` in `lib/dynamic.js`). Two things make this
different from a naive "call an image model and draw whatever comes
back":

1. **The headline text is never part of the generated image.** Every
   current image model, Imagen included, can't reliably render small
   precise lettering -- asking it to also draw "HIGH TIDE 3:00 PM" would
   produce garbled text on an e-ink display where legibility is the
   whole point. `imagen.js`'s `STYLE_PREFIX` explicitly asks for no
   text/lettering at all; `drawBeachBuddyHeadline` draws the real,
   legible headline itself, in code, on top, exactly the way every other
   card here draws its own text.
2. **One fixed style prefix on every single call** (`STYLE_PREFIX` in
   `lib/imagen.js`) is what keeps "Buddy" reading as the same recurring
   character day to day rather than a new random illustration each time
   -- flat two-color linework (no gradients/shading a 1-bit threshold
   would turn to noise), the same character description, every time.
   `IMAGEN_SCENE_HINTS` supplies just the one line that actually changes
   -- what Buddy is doing -- keyed by the same pose names the procedural
   fallback's `STICK_POSES` uses, so a mood computed from real data
   drives the same scene idea whichever renderer ends up drawing it.

**Imagen only supports a fixed set of aspect ratios** ("1:1", "3:4",
"4:3", "9:16", "16:9") -- none close to this display's own ~2.9:1 strip.
Rather than stretch or crop a generated image into an unnatural shape,
`IMAGE_ASPECT_RATIO` asks for a normal "1:1" portrait illustration and
`drawBeachBuddyArtCard` places it as a modest centered panel below the
headline, with clean white margin either side -- closer to how a real
Life-is-Good-style design actually composes a small character
illustration with text than an edge-to-edge background fill would be.
The returned image is dithered into the panel with the same Atkinson
algorithm already used for team logos (`ditheredArtCanvas`, mirroring
`ditheredLogoCanvas`) -- a flat, mostly-2-color illustration dithers into
clean crisp linework, unlike a plain luminance threshold which would
lose Imagen's own anti-aliased edges.

**A failed/blocked/unreachable Imagen call never fails the whole
card.** `renderDynamicDesign`'s `"beachBuddy"` branch tries Imagen first
and falls back to the procedural stick-figure card
(`drawBeachBuddyCard`) on ANY failure -- a safety-filtered result, an
API error, a bad/undecodable image -- logging the reason and continuing,
the same "nice-to-have, not load-bearing" contract `fetchDitheredLogo`
already uses for a missing team logo. The result object's `usedArt`
field records which one actually rendered, for anyone reading the
Cloud Function logs. `beachBuddyArtImpl`, the last parameter of
`renderDynamicDesign`, swaps out the real Imagen call for tests --
`test/imagen.test.js` covers `lib/imagen.js` in isolation (prompt
construction, success, every failure shape) and
`test/dynamic.test.js`'s `renderDynamicDesign (type: beachBuddy, with
Imagen art)` suite covers the success/fallback wiring end to end, all
without a real Vertex AI call.

**Imagen only ever gets called once per (pose, sunny) scenario, not once
per device per day.** `getOrGenerateBeachBuddyArt` in `index.js` checks
Firebase Storage at `beachBuddyArt/v<PROMPT_VERSION>/<cacheKey>.png`
(`cacheKeyForMood` in `lib/imagen.js`) before ever calling
`generateBeachBuddyArt` -- a cache hit (a `download()` 404) returns the
already-generated bytes; a miss generates once and saves it there for
every future device/town/day that lands on the same mood. `PROMPT_VERSION`
is folded into the path so a real prompt-wording change (bump the
constant) starts a fresh set of cached images instead of serving stale
art forever. Because the art is shared and cheap to look up, Beach
Buddy's headline refreshes on its OWN hourly schedule
(`regenerateBeachBuddyDesigns`, `0 * * * *`) instead of the once-daily
`regenerateCountdownDesigns` job every other layer type uses -- that
daily job explicitly skips `"beachBuddy"` devices now (`NOT_BEACH_BUDDY`)
so the two schedules never race on the same device. `imagenProxy` (the
live design-tool preview, below) routes through this exact same cache
too, so re-previewing an already-cached pose+sunny combination never
bills another Imagen call.

**The design tool's live preview shows the real Imagen art too, via
`imagenProxy`** (`imagenProxyHandler` in `index.js`) -- same CORS
reasoning as every other proxy in this file (a script-initiated `fetch()`
straight to Vertex AI needs CORS headers it doesn't send), but a
deliberately different security shape from the rest: `espnProxy`/
`newsProxy`/`astroProxy` are thin passthroughs of a free public API, so
an open relay is a mild abuse-surface concern at worst. Imagen bills per
generated image, so `imagenProxy` never accepts a free-text prompt from
the browser at all -- only a `pose` query param checked with
`Object.prototype.hasOwnProperty.call` against `IMAGEN_SCENE_HINTS`
(the same fixed, small set of poses `moodForBeachData` ever picks from;
the `hasOwnProperty` check specifically to reject `pose=constructor` and
similar prototype-chain lookups that a naive `IMAGEN_SCENE_HINTS[pose]`
truthy check would wrongly accept). The prompt itself is still always
built server-side from `imagen.js`'s fixed `STYLE_PREFIX` + one matching
hint, exactly like the daily job -- the browser can only choose which of
six known scenes to render, never what to render.

`design/index.html`'s Beach Buddy tool calls this once per session (not
on every redraw) via `fetchBeachBuddyArtClient`, dithers the result once
(reusing `ditheredLogoCanvasOpaque`, the same helper team logos already
use) and caches it on the layer object -- reopening the tool tab or
editing something else on the canvas does NOT trigger another
generation, since unlike Tide & Fishing's free NOAA/Open-Meteo calls,
every one of these has a real cost. If the proxy call fails for any
reason (Imagen not set up yet, a safety filter, a network error), the
preview falls back to the procedural stick-figure card, same contract as
the daily job's own server-side fallback -- see `beachBuddyMoodStatus`
in `design/index.html` for the status text shown either way.

**Not live-tested against a real Vertex AI project from this
development sandbox** (no GCP credentials for the `waveclock` project
are available here) -- but it HAS been live-tested by the project owner
against the real deployed `imagenProxy`, which caught a real bug this
sandbox never could have: the first version of this file called the
standalone Imagen model (`imagen-4.0-generate-001` via
`ai.models.generateImages(...)`), confirmed via a real Cloud Function
log to 404 with *"Publisher model ... was not found or your project
does not have access to it"* -- Model Garden search for "Imagen 4" on
the real project turned up no standalone Imagen model card at all.
Image generation now lives on Gemini's own multimodal model instead,
reached through the ordinary `generateContent` call (with
`responseModalities: ["IMAGE"]` and an `imageConfig`), not a separate
Imagen-specific method -- `lib/imagen.js` now calls
`gemini-2.5-flash-image` ("Nano Banana" in Model Garden) this way. This
fix itself is NOT yet confirmed working end-to-end (the 404 is fixed,
but a full publish-and-see-the-real-art smoke test hadn't happened as
of this writing) -- still needs that final check: publish a Beach Buddy
layer, and look at the actual illustration that comes back (does the
character stay recognizable/on-style, does the mood match, does the
headline stay legible over it).

**One-time setup, beyond the Blaze-plan requirement below** (a human
with project access, done from the Google Cloud Console -- none of this
can be done from code). Google renamed "Vertex AI" to "Gemini Enterprise
Agent Platform" partway through this feature's life -- the Console's
product name and exact menu wording may have moved again by the time
you read this, so these steps describe what to look for, not just what
to click:

1. **Enable the API** on the `waveclock` project: Console -> APIs &
   Services -> Library -> search "Vertex AI API" (or "Gemini Enterprise
   Agent Platform API" if that's what the Library shows now -- same
   underlying API, `aiplatform.googleapis.com`) -> Enable. Imagen usage
   is billed per generated image (check
   [current Imagen pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing)
   before enabling for real, since unlike the rest of this Cloud
   Function's near-zero cost, this is the one part of the daily job with
   a real per-call cost -- one generation per device per day it's
   published).
2. **Grant the Cloud Functions service account the role that includes
   `aiplatform.user`**: Console -> IAM & Admin -> IAM -> find the same
   service account this Cloud Function already runs as (its default
   compute/App Engine service account -- looks like
   `<PROJECT_NUMBER>-compute@developer.gserviceaccount.com` -- unless a
   custom one was set up for the deploy steps below; this is a
   DIFFERENT identity from the `github-deploy` service account those
   steps create, which only needs deploy permissions, not this role) ->
   Edit -> Add Role -> search "Agent Platform User" (confirmed live,
   2026 -- this is the current display name for `roles/aiplatform.user`,
   what used to show as "Vertex AI User"; the role picker also lists
   several "Vertex AI ... Service Agent" roles that look similar but are
   for Google-managed service agents, not this one -- "Agent Platform
   User"'s own description reads "Grants access to use all resource in
   Agent Platform"). If the Console has renamed it again by the time
   you're reading this, search the role ID `roles/aiplatform.user`
   directly instead -- far less likely to have moved than the display
   name has twice already.
3. **If a live call still 404s** with "Publisher model ... was not
   found or your project does not have access to it" even with steps 1
   and 2 done: Console -> search "Model Garden" (may be filed under
   "Gemini Enterprise Agent Platform" now) -> search the model name
   `lib/imagen.js` currently calls (`IMAGEN_MODEL`, e.g.
   "gemini-2.5-flash-image") -> open its model card -> look for an
   Enable/Get-started/access-terms action there. This is a real,
   live-confirmed failure mode (see the "Not live-tested" note above) --
   API-enabled + IAM-granted was NOT enough by itself the first time;
   the actual cause that once turned out to be an outright wrong/
   discontinued model name, not a missing access grant, but Model
   Garden access gating is a real, documented thing for generative
   models too, so check both.
4. That's it -- no API key to store as a secret. `lib/imagen.js`
   authenticates with `@google/genai`'s `enterprise: true` mode (the
   SDK's current recommended flag -- functionally identical to the
   older `vertexai: true`, see that file's own comment), which on a Node
   runtime uses Application Default Credentials: the same service-
   account identity already used for Cloud Storage everywhere else in
   this file.

If this isn't enabled yet (or the role hasn't been granted, or the
model name has moved again), Beach Buddy still works -- every render
just falls back to the procedural stick-figure card until that one-time
setup is done, per the graceful-degradation contract above. Check the
`imagenProxy` Cloud Function's own logs (Console -> Cloud Functions ->
`imagenProxy` -> Logs/Observability tab) for the real underlying error
if it's not working -- the browser never sees more than a generic
"couldn't generate" message, by design (see imagenProxyHandler's own
comment in index.js).

## Local Info (Beach Flags)

A customer feature request from a Santa Rosa Beach, FL customer, asking
for the day's beach-hazard flag color and (later) local live music
listings. Built as a single "Local Info" tool (`design/index.html`'s
toolbar button, currently hidden -- see below) rather than a new
toolbar icon per data source, since these are hyper-regional requests --
useful to a handful of customers along one stretch of coast, not
everyone -- and more will likely come in over time from other towns.
Picking WHICH option happens on a separate gallery page
(`design/local-info-gallery.html`, linked from the tool panel) rather
than an in-panel dropdown -- a customer needs room to see a live
preview and a description per option before picking, which a toolbar
dropdown doesn't have space for. Selecting "Use This" there bounces
back to `index.html?...&localInfoChoice=<subType>`, which applies it
immediately. "Beach Flags" is the only real gallery option today; a
future "Live Music" option (`30a.com/events/`) would slot into the same
gallery page as a second entry.

**Data source, and its real caveat**: `https://30a.com/beachflag/`, a
single URL covering the whole 30A corridor (not per-device -- flag
color doesn't vary town to town along that stretch). There's no
documented API for it -- `lib/beachflag.js` fetches the page and pattern-
matches its visible text (`"YELLOW: MEDIUM HAZARD"`, a separate
`"PURPLE: Marine Pests Present..."` line when more than one flag is
flying, `"Last Refreshed: ..."`), the same "read the visible words"
approach `fetchHeadlines` already uses for RSS, just over plain text
instead of XML. This is meaningfully more fragile than every other data
source in this app (NOAA, ESPN, TeamSnap's iCal feeds are all real,
documented APIs) -- if 30a.com redesigns that page, the parser will need
an update. Two sources were seriously considered and rejected first:
Mote Marine's BCRS (the more "official" source, flag color is literally
one of its tracked fields, but app-only with no public API) and Beach
Day API (a real, documented, developer-first REST API -- but paid, and
every other data source in this app is free).

**Bonus stats, not a new source**: the surf-height/water-temp/rip-risk
line on the card (`fetchBeachFlagCardData` in `lib/beachflag.js`) reuses
`fetchTideCardData` exactly as the Tide card does -- no new fetch, and
it degrades gracefully (stats just don't show) rather than failing the
card if that call fails, since the flag status is the whole point of
this card and the rest is a nice-to-have. Rip current risk
(`ripCurrentRisk` in `lib/astro.js`) is a simplified LOW/MODERATE/HIGH
estimate derived from Open-Meteo Marine's wave height + period alone --
explicitly NOT the official NWS Beach Hazards Statement, which also
weighs tide stage, wind direction relative to the coast, and local
bathymetry per beach; see that function's own comment for the exact
thresholds and reasoning. The town name shown alongside it is never
fetched -- it's the device's own saved location nickname
(`locations/{id}.json`'s `name` field, via `resolveTideLocation` in
`design/index.html`), stored on the layer's `-dynamic.json` meta at
publish time as `townName`, the same "save it once, don't refetch it"
approach `tideTimeline`'s own `meta.townName` already uses.

**Refresh schedule**: `regenerateBeachFlagDesigns`, every 3 hours (not
hourly like Beach Buddy) -- the flag color itself only actually changes
a couple of times a day per 30a.com's own "Last Refreshed"/"Last
Changed" timestamps, so polling faster than that just re-fetches the
same value. Cheap either way (a lightweight text fetch, no Imagen-style
per-generation cost).

**Not yet verified against the live page**: this development sandbox's
network access is restricted to an allowlist that doesn't cover
`30a.com` (or `api.weather.gov`, or any other external site tried during
this build) -- `lib/beachflag.js`'s parser was built and tested against
a page structure reconstructed from an actual screenshot of the live
page (see the file's own header comment), not the real HTML source.
The toolbar button (`toolLocalInfoBtn`) ships hidden (`style="display:
none;"`, same convention as the currently-hidden Tide & Fishing button)
until someone with real network access confirms it against production
-- remove that style attribute once it's verified.

## Known tradeoffs

**At most one dynamic layer per screen, enforced client-side, not server-side**:
publish (`design/index.html`) only ever tracks the *first* Countdown/
Team/News/Tide layer it finds in `layers` for the daily auto-update
(`DYNAMIC_KINDS`); a second one of the same kind would render fine at
publish time but stay frozen forever after, since the daily job never
touches it. Team/News/Tide can't produce a duplicate -- they're
full-screen cards that wipe/replace the whole `layers` array on
creation. Countdown used to be the exception: it's a normal draggable/
resizable stamp (so it can coexist with other layers), and the "Countdown"
toolbar button used to stage a brand-new one every time it was clicked,
with no check for an existing one -- so it was possible to end up with
two Countdown layers, only one of which would ever actually update. It's
now deduplicated the same way tapping an existing layer already worked:
clicking the toolbar button pulls the existing Countdown back into
editing instead of staging a second one alongside it. The panel's date/
label/font controls also used to go silently dead the moment you hit the
checkmark to place it -- they were only ever wired to the in-progress
staged object, not the already-committed layer, so editing them after
committing looked like it should work (still visibly enabled, still
showing the right values) but had no effect at all. They're now bound to
"whichever Countdown currently exists, staged or already committed" so
they keep working right through a commit. (Fixing this also surfaced --
and fixed -- a related bug: cancelling an edit of any reselected layer,
of any kind, used to delete it outright instead of restoring it, since
`selectLayer` pulls the layer out of `layers` to edit it and Cancel never
put it back.)

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

**`basketball/womens-college-basketball` hasn't been confirmed against a
live response**: added to `ALLOWED_LEAGUES`/the League dropdown/
`LEAGUE_DISPLAY_NAME` on the strength of the same widely-documented ESPN
slug convention as the other 5 leagues (all of which HAVE been confirmed
live), but this specific one hasn't itself been smoke-tested yet --
publish a Team layer against it and check the live preview/next game
before fully trusting it, same as the News feature's own
not-yet-confirmed caveat above.

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
design's Team tool originally called `site.api.espn.com` straight from
the browser for its live preview. That failed in production ("Couldn't
load teams") -- confirmed by loading the same URL directly in a browser
tab (works, returns real JSON) versus the page's own `fetch()` call to it
(blocked), which is the signature of a CORS rejection: ESPN's response
doesn't include headers granting waveclock.net's JavaScript permission to
read it, even though the URL itself is publicly reachable.

The fix is `espnProxy`, an `onRequest` HTTP function in this same
`functions/` deployment: design now calls `espnProxy` (same-origin as
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
