# AI design generator — deploy notes

This Cloud Function backs the "Generate with AI" panel on `/designv2/`. It
was written but **not deployed** — deploying requires your own Firebase CLI
login and your fal.ai key, neither of which should ever pass through an AI
assistant or get committed to this repo.

## Prerequisites (check these first)

1. **Blaze (pay-as-you-go) plan.** Cloud Functions on the free Spark plan
   cannot make outbound requests to non-Google APIs — this function calls
   fal.ai, so the project must be on Blaze. Check/upgrade at
   console.firebase.google.com → your project → Usage and billing.
2. **Firestore enabled**, in Native mode (used for the generation-count
   rate limiter). Console → Firestore Database → Create database, if you
   haven't already.

## One-time setup

```bash
npm install -g firebase-tools   # if you don't have it
firebase login
firebase use waveclock          # matches .firebaserc at the repo root

cd functions
npm install
```

## Set the fal.ai key (do this yourself — never share the key in chat)

```bash
firebase functions:secrets:set FAL_KEY
```

This prompts for the value interactively and stores it in Google Secret
Manager. The function reads it via `defineSecret("FAL_KEY")` — it's never
in source, env files, or git.

## Deploy

```bash
firebase deploy --only functions,firestore:rules
```

## After deploying, sanity-check

- Open `waveclock.net/designv2/?id=WC-TEST` (any placeholder ID works for
  testing), type a prompt, hit Generate.
- Try a prompt with an obviously blocked term — should get an "isn't
  allowed" error without ever reaching fal.ai (check Cloud Functions logs
  to confirm no fal.ai request was made).
- Generate 8 times on the same `?id=` to confirm the device cap kicks in
  ("used up its AI generations").
- Check Firestore → `aiGenerationLimits` collection — you should see
  `device_WC-TEST` and `ip_<your IP>` documents with counts incrementing.

## Things worth verifying against current fal.ai docs before relying on them

- The exact request/response shape for `fal-ai/flux/schnell` (model slugs
  and parameters occasionally change) — particularly whether custom
  `image_size: {width, height}` is still accepted as written, and whether
  `enable_safety_checker` is still the correct parameter name.
- Whether fal.ai's returned image URLs serve permissive CORS headers.
  The frontend loads them into a `<canvas>` and reads pixel data
  (`getImageData`) to threshold them to 1-bit — this throws a
  SecurityError if the image's CORS headers don't allow it. If that
  happens in testing, the fix is to have the Cloud Function download the
  image server-side and re-host it in Firebase Storage instead of
  returning fal.ai's URL directly.

## Tuning

- `DEVICE_LIFETIME_CAP` / `IP_DAILY_CAP` in `index.js` — currently 8
  lifetime per device, 20/day per IP as a backstop.
- `BLOCKED_TERMS` in `index.js` — the basic keyword blocklist. Extend as
  needed; it's intentionally simple (substring match on a normalized
  prompt), with fal.ai's `enable_safety_checker` as the second layer that
  screens actual output.
