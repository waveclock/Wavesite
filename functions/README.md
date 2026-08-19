# Dynamic-layer auto-update Cloud Function

Runs once a day (09:00 UTC) and redraws the current content for every
device with an active "dynamic layer" published from `/design-v2/` --
either a **Countdown** (a target date) or a **Team Schedule** (next game
for a picked sports team) -- overwriting `designs/{deviceId}.bin` and
`.png` in place. The device itself needs no changes -- it already reads
those two files unconditionally.

## How it fits together

`design-v2/index.html` publishes up to four files per device when a
Countdown or Team layer is on the canvas:

- `designs/{id}.bin` / `.png` -- today's design, exactly as before (so the
  board updates immediately on publish, same as always).
- `designs/{id}-base.png` -- everything else on the canvas, flattened,
  WITHOUT the dynamic layer's text. This is what gets redrawn onto each
  day.
- `designs/{id}-dynamic.json` -- the dynamic layer's own settings, tagged
  with a `type` field:
  - `{ type: "countdown", targetDate, label, x, y, size, fontKey, outline, inverted }`
  - `{ type: "team", sport, league, teamId, teamName, x, y, size, fontKey, outline, inverted }`

If there's no Countdown or Team layer, `design-v2` deletes the
`-base.png` / `-dynamic.json` files instead (best-effort) so this job has
nothing to find for that device. At most one dynamic layer is treated as
active per device for now -- if a customer somehow adds both a Countdown
and a Team layer, only the first one found governs auto-updates.

Each run:
1. Lists everything under `designs/` and picks out `*-dynamic.json`.
2. For each device, downloads `-dynamic.json` + `-base.png` and dispatches
   on `type` (see `lib/dynamic.js`):
   - **countdown**: computes days-remaining and draws the text.
   - **team**: fetches the team's schedule from ESPN's unofficial site API
     and draws "VS/@ {OPPONENT} IN N DAYS" for the earliest upcoming game
     (or "NO UPCOMING GAMES" in the off-season -- a normal, steady state,
     not an error).
3. Re-packs to the device's 1-bit format and overwrites `.bin` / `.png`.
4. **Countdown** only: once the target date has passed, deletes
   `-dynamic.json` / `-base.png` (so this device stops being picked up)
   and leaves the last real `.bin`/`.png` as-is -- the board freezes on
   whatever it last showed (typically "TODAY!") rather than going blank or
   counting into negative numbers.
5. **Team** layers never get cleaned up this way -- they're perpetual and
   self-renew every season as ESPN's schedule updates. A transient ESPN
   fetch failure throws instead of returning null, which the caller treats
   as "leave this device alone and try again tomorrow," never as "give up
   on it."

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
community knowledge but was **never verified against a live response**
while building this, since network access to ESPN was blocked in the dev
sandbox. Worth a real smoke-test against a live team schedule after this
is deployed, before fully trusting it.

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

Runs `test/dynamic.test.js` (pure rendering/packing/date-math/next-game
logic, including synthetic ESPN-shaped responses) and
`test/orchestration.test.js` (the per-device list/download/render/upload
flow, against an in-memory fake Storage bucket -- never touches anything
real, ESPN included).
