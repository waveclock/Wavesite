# Admin auth setup

Every page under `admin/`, plus `design/beach-buddy-admin.html`, is now
gated behind Firebase Auth Google sign-in (`admin/auth-gate.js`). The
allowlist of authorized emails lives at the top of that file
(`ADMIN_EMAILS`) -- add or remove admins there.

This is UI-layer gating only. The actual access control for the data
these pages touch is `../storage.rules` (see that file's header for why
it isn't auto-deployed, and for what it does and doesn't cover).

## One-time Firebase console setup (required before this works)

1. **Authentication > Sign-in method** -- enable the **Google** provider
   for the `waveclock` project, if it isn't already.
2. **Authentication > Settings > Authorized domains** -- make sure
   `waveclock.net` (and `waveclock.firebaseapp.com`, added by default) is
   listed, or `signInWithPopup` will fail on the live site.
3. Merge and deploy the rules in `../storage.rules` (see that file for
   the merge steps -- don't blind-deploy it).

Nothing else in this repo needs to change for sign-in itself to work --
`admin/auth-gate.js` uses the same public Firebase Web SDK config already
in every admin page.
