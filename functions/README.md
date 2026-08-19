# Dynamic-layer auto-update Cloud Function

Runs once a day (09:00 UTC) and redraws the current content for every
device with an active "dynamic layer" published from `/design-v2/` -- a
**Countdown** (a target date), a **Team Schedule** (next game for a
picked sports team), or **News** (headlines for a location or RSS feed)
-- overwriting `designs/{deviceId}.bin` and `.png` in place. The device
itself needs no changes -- it already reads those two files
unconditionally.

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
     If a game is found, draws the full **Game Day card** -- bordered
     full-screen layout with both teams' logos (fetched and Atkinson-
     dithered server-side), the matchup ("PHI VS DAL"), days-remaining
     ("IN 5 DAYS" / "TODAY!"), and (when available) the game's date/time
     in Eastern and the venue name. In the off-season (no upcoming games)
     it falls back to the plain "{TEAM}: NO UPCOMING GAMES" text -- a
     normal, steady state, not an error, and there's no card to build
     around.
   - **news**: fetches and parses an RSS feed (see "The News card" below
     for how the feed URL is chosen), draws up to 3 headlines -- truncated
     to fit -- in the same bordered card style as the Game Day card. An
     empty/unreachable-but-responding feed falls back to plain
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

## Deploying (not done automatically -- this needs a human with project access)

1. **Upgrade the Firebase project to the Blaze (pay-as-you-go) plan** if
   it isn't already -- Cloud Functions require it. Realistic cost for this
   job is well under $1/month at any scale this business is likely to
   reach (see the cost breakdown discussed when this was built).
2. Install the Firebase CLI if you don't have it: `npm install -g firebase-tools`
3. `firebase login`
4. From the repo root: `firebase deploy --only functions`

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
