# Countdown auto-update Cloud Function

Runs once a day (09:00 UTC) and redraws the day-count for every device with
an active Countdown layer published from `/design-v2/`, overwriting
`designs/{deviceId}.bin` and `.png` in place. The device itself needs no
changes -- it already reads those two files unconditionally.

## How it fits together

`design-v2/index.html` publishes up to four files per device when a
Countdown layer is on the canvas:

- `designs/{id}.bin` / `.png` -- today's design, exactly as before (so the
  board updates immediately on publish, same as always).
- `designs/{id}-base.png` -- everything else on the canvas, flattened,
  WITHOUT the countdown text. This is what gets redrawn onto each day.
- `designs/{id}-countdown.json` -- `{ targetDate, label, x, y, size,
  fontKey, outline, inverted }`, the countdown's own settings.

If there's no Countdown layer, `design-v2` deletes the `-base.png` /
`-countdown.json` files instead (best-effort) so this job has nothing to
find for that device.

Each run:
1. Lists everything under `designs/` and picks out `*-countdown.json`.
2. For each device, downloads `-countdown.json` + `-base.png`, computes
   days-remaining, draws the text (see `lib/countdown.js`), re-packs to the
   device's 1-bit format, and overwrites `.bin` / `.png`.
3. Once the target date has passed, deletes `-countdown.json` /
   `-base.png` (so this device stops being picked up) and leaves the last
   real `.bin`/`.png` as-is -- the board freezes on whatever it last showed
   (typically "TODAY!") rather than going blank or counting into negative
   numbers.

## Known tradeoff: timezone

This runs once, at a fixed UTC hour, for every device regardless of where
it actually is. A device very close to its own local midnight can be
briefly a day ahead or behind of the count for a few hours until the next
run. Not worth solving until it's an actual reported problem -- doing so
would need a per-device timezone (derived from its saved lat/lon) and
per-device run times instead of one shared daily run.

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

Runs `test/countdown.test.js` (pure rendering/packing/date-math logic) and
`test/orchestration.test.js` (the per-device list/download/render/upload
flow, against an in-memory fake Storage bucket -- never touches anything
real).
