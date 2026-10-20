// Per-tag tide-station registry for the NFC keychain flow: each physical
// Wave Clock keychain's NFC tag carries a short ID baked into its URL
// (https://waveclock.net/t/A7K2). The first tap shows the beach picker
// and registers the chosen NOAA tide station against that ID; every tap
// after that goes straight to the tide, on any phone, even after Safari
// clears localStorage.
//
// Stored as one small JSON object per tag in the SAME Cloud Storage
// bucket index.js already uses for device designs (admin.storage().bucket(),
// "waveclock.firebasestorage.app") -- there's no Firestore (or any other
// database) provisioned in this Firebase project, and Storage's strong
// read-after-write consistency plus a generation-match precondition (see
// saveTideTag) covers everything this needs: a get, a create-only write,
// and a delete. No new infrastructure, same deploy pipeline.
"use strict";

const crypto = require("crypto");

const TIDE_TAGS_PREFIX = "tide-tags/";

// Same character set scripts/generateTagIds.js draws IDs from -- excludes
// 0/O/1/I so a tag etched small, printed, or read off a phone screen in
// bright sun can't be misread into a DIFFERENT valid-looking ID. (Kept
// even though nothing about this project prints or hand-types an ID
// anymore -- it's still harmless, and still helps if an ID is ever read
// aloud for support purposes.)
//
// 16-32 chars, not the original 4-6 -- a short ID only needs to be
// *typeable*, which stopped mattering once IDs became NFC-only (never
// printed, never manually entered). At 4-6 chars the entire ID space
// (as few as 32^4 =~ 1 million) was cheap to sweep end-to-end against
// the open GET endpoint below with no auth and no rate limiting,
// `registered:true` revealing exactly which ones were real, live
// customer tags -- turning "learn a tagId" from "tap a specific
// physical tag" into "run a script," with no physical access needed at
// all. At 16+ chars (32^16 =~ 1.2e24) that sweep is computationally
// infeasible, so possessing a tag (or knowing its ID through some other
// leak) becomes the only realistic way to ever learn it again.
// Re-validated here (not just trusted from the URL) because tagId gets
// interpolated straight into a Cloud Storage object path below -- a
// malformed or path-traversal-shaped value must never reach that call.
const TAG_ID_PATTERN = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{16,32}$/;

function isValidTagId(tagId) {
  return typeof tagId === "string" && TAG_ID_PATTERN.test(tagId);
}

function tagFile(bucket, tagId) {
  return bucket.file(TIDE_TAGS_PREFIX + tagId + ".json");
}

// A WaveClock device's own ID -- assigned by a completely separate
// process from tagId above (device provisioning, not tag minting), so
// this can't reuse TAG_ID_PATTERN's exact shape or its allowlist.
// Existing device IDs already in use (see functions/test/orchestration.test.js,
// e.g. "WC-1") are short alphanumeric-plus-hyphen strings, and nothing
// elsewhere in this codebase validates their shape at all -- every other
// place a deviceId is used (location/, settings/, manage/) just trusts
// it as a path segment. This pattern is intentionally permissive enough
// not to reject any real device ID in that style, while still being
// strict enough that a deviceId handed to linkTideTagToDevice below
// can't smuggle a path-traversal shape into the stored record.
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function isValidDeviceId(deviceId) {
  return typeof deviceId === "string" && DEVICE_ID_PATTERN.test(deviceId);
}

// A SEPARATE record from tide-tags/ above: this one just marks "a real,
// physical tag with this ID actually exists" (written once, in a batch,
// by mintTagIds -- see scripts/generateTagIds.js's own POST to
// mintTideTagBatch at mint time), vs. tide-tags/ which marks "this ID
// has been tapped and a beach picked for it." An unguessable ID alone
// (see TAG_ID_PATTERN's own comment) stops anyone from ever landing on
// a REAL tag's ID by chance, but doesn't stop anyone from simply
// inventing their OWN brand-new one and registering it -- nothing about
// length makes up a string any harder, just makes guessing an EXISTING
// one astronomically unlikely. This allowlist is what actually closes
// that gap: the HTTP handler's own POST/PUT-as-create paths (see
// index.js) check membership here BEFORE ever calling saveTideTag/
// updateTideTag, so a tagId that was never minted onto a real tag can
// never successfully register, no matter how well-formed or how long.
const TAG_ALLOWLIST_PREFIX = "tide-tag-allowlist/";

function allowlistFile(bucket, tagId) {
  return bucket.file(TAG_ALLOWLIST_PREFIX + tagId + ".json");
}

// Mirrors fetchTideTag's own "malformed input never even touches
// storage" contract.
async function isTagIdMinted(bucket, tagId) {
  if (!isValidTagId(tagId)) return false;
  try {
    await allowlistFile(bucket, tagId).download();
    return true;
  } catch (err) {
    if (err && err.code === 404) return false;
    throw err;
  }
}

// Marks a whole batch of IDs as real/mintable in one call -- the write
// side of isTagIdMinted above, called once per batch at mint time (see
// scripts/generateTagIds.js). Each marker write is itself idempotent
// (ifGenerationMatch: 0, same atomic create-only guard saveTideTag
// uses) so re-running this against a batch that was already minted is
// harmless -- already-minted entries are just reported back separately,
// not an error, the same way saveTideTag's own "already-registered"
// isn't treated as a failure. Every ID is shape-validated BEFORE any
// writes start, so one malformed entry can't leave a batch half-minted.
async function mintTagIds(bucket, tagIds) {
  for (const tagId of tagIds) {
    if (!isValidTagId(tagId)) throw new Error("invalid tagId in batch: " + tagId);
  }
  let minted = 0, alreadyMinted = 0;
  for (const tagId of tagIds) {
    try {
      await allowlistFile(bucket, tagId).save(JSON.stringify({ mintedAt: new Date().toISOString() }), {
        contentType: "application/json",
        preconditionOpts: { ifGenerationMatch: 0 }
      });
      minted++;
    } catch (err) {
      if (err && err.code === 412) { alreadyMinted++; continue; }
      throw err;
    }
  }
  return { minted, alreadyMinted };
}

// Returns the saved {stationId, stationName, createdAt} for a registered
// tag, or null for one that's never been tapped-and-picked yet (a real,
// expected steady state -- most freshly-minted tags sit unregistered for
// a while before their first tap -- not an error) OR for a malformed
// tagId. Throws only on a genuine storage failure, which callers should
// surface as a retryable error, not treat as "unregistered."
async function fetchTideTag(bucket, tagId) {
  if (!isValidTagId(tagId)) return null;
  try {
    const [buf] = await tagFile(bucket, tagId).download();
    return JSON.parse(buf.toString("utf8"));
  } catch (err) {
    if (err && err.code === 404) return null;
    throw err;
  }
}

// lat/lon are optional and nice-to-have, not load-bearing -- the
// picker always has the chosen station's real coordinates in hand (the
// NOAA stations list carries them), so this is just passing them
// through to store alongside the station, for the tide page's sunrise/
// sunset-based day/night background. A missing or out-of-range value
// is silently dropped rather than rejecting the whole registration
// over it; a tag registered before this existed (or whose picker
// request didn't include them for any reason) just won't get the
// sunrise/sunset shading, same graceful-degrade as a missing logo.
function sanitizeCoords(lat, lon) {
  // Number(null) and Number(undefined) coerce to 0 and NaN respectively
  // -- 0 is a real (if unlikely) coordinate, so a missing value has to
  // be rejected explicitly before the coercion below, not left to fall
  // out of the finite/range checks on its own.
  if (lat == null || lon == null) return null;
  const la = Number(lat), lo = Number(lon);
  if (!Number.isFinite(la) || la < -90 || la > 90) return null;
  if (!Number.isFinite(lo) || lo < -180 || lo > 180) return null;
  return { lat: la, lon: lo };
}

// townName is the user-facing display name ("Ocean City, NJ") -- distinct
// from stationName, which is the NOAA tide station's OWN name ("Ventnor,
// NJ") and can legitimately be a different nearby town than the one the
// person actually picked. Free text (a geocoded town label, not a
// station name), so it isn't format-validated like a tagId or stationId
// -- just trimmed and capped at a sane length so a malformed or
// deliberately huge value can't bloat the stored record. Omitted (not
// stored as an empty string) when missing, same convention as lat/lon,
// so a tag registered before this existed just falls back to showing
// its stationName, same graceful degrade.
const TOWN_NAME_MAX_LENGTH = 100;
function sanitizeTownName(townName) {
  if (typeof townName !== "string") return null;
  const trimmed = townName.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, TOWN_NAME_MAX_LENGTH);
}

// coastFacingDirection: the compass point the coast opens TOWARD (the
// seaward side), e.g. "E" for a Jersey-shore-style east-facing beach --
// the client resolves this (from the OSM coastline, same method
// location/index.html's own setup wizard already uses) and just hands
// over the final compass label, never a raw bearing, so this only has
// to trust it's one of the 8 real compass points rather than re-derive
// it. Same graceful-degrade convention as lat/lon/townName: missing or
// unrecognized is silently dropped, not a rejected registration.
const COAST_FACING_DIRECTIONS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
function sanitizeCoastFacingDirection(dir) {
  return typeof dir === "string" && COAST_FACING_DIRECTIONS.includes(dir) ? dir : null;
}

// srfZone (NWS public/land forecast zone, e.g. "NJZ024") and marineZone
// (NWS Coastal Waters Forecast zone, e.g. "ANZ453") share the exact same
// ID shape -- 2-3 letter state/region code + "Z" + 3 digits -- the same
// pattern location/index.html's own MARINE_ZONE_ID_PATTERN already
// validates marine zones against, reused here for both.
const ZONE_ID_PATTERN = /^[A-Z]{2,3}Z\d{3}$/;
function sanitizeZoneId(zoneId) {
  return typeof zoneId === "string" && ZONE_ID_PATTERN.test(zoneId) ? zoneId : null;
}

// Registers a station against a tag -- but ONLY if that tag isn't
// already registered. preconditionOpts.ifGenerationMatch: 0 is Cloud
// Storage's own atomic "create, don't overwrite" precondition
// (generation 0 means "no live object at this path yet"); the request
// fails with a 412 if another write already landed first -- e.g. two
// phones tapping the same physical tag at nearly the same moment, or a
// phone double-submitting the picker. That specific, expected race
// returns { status: "already-registered" } instead of throwing; any
// OTHER storage failure still throws.
async function saveTideTag(bucket, tagId, stationId, stationName, lat, lon, townName, coastFacingDirection, srfZone, marineZone) {
  if (!isValidTagId(tagId)) throw new Error("invalid tagId");
  const sanitizedTownName = sanitizeTownName(townName);
  const sanitizedCoastFacingDirection = sanitizeCoastFacingDirection(coastFacingDirection);
  const sanitizedSrfZone = sanitizeZoneId(srfZone);
  const sanitizedMarineZone = sanitizeZoneId(marineZone);
  const record = Object.assign(
    { stationId: String(stationId), stationName: String(stationName), createdAt: new Date().toISOString() },
    sanitizeCoords(lat, lon),
    sanitizedTownName ? { townName: sanitizedTownName } : null,
    sanitizedCoastFacingDirection ? { coastFacingDirection: sanitizedCoastFacingDirection } : null,
    sanitizedSrfZone ? { srfZone: sanitizedSrfZone } : null,
    sanitizedMarineZone ? { marineZone: sanitizedMarineZone } : null
  );
  try {
    await tagFile(bucket, tagId).save(JSON.stringify(record), {
      contentType: "application/json",
      preconditionOpts: { ifGenerationMatch: 0 }
    });
    return { status: "created", record };
  } catch (err) {
    if (err && err.code === 412) return { status: "already-registered" };
    throw err;
  }
}

// Overwrites a tag's station regardless of whether one's already set --
// the deliberate counterpart to saveTideTag's atomic create-ONLY
// contract. Used only for an explicit, user-initiated "change my beach"
// action (see the tide page's own "Change beach" link), never for the
// automatic first-tap registration, which must keep using saveTideTag
// so two near-simultaneous first taps can't race each other into
// silently overwriting one another's pick. No precondition, so this
// always succeeds (short of a genuine storage failure) -- there's no
// "already registered" case to report here, that's the whole point.
async function updateTideTag(bucket, tagId, stationId, stationName, lat, lon, townName, coastFacingDirection, srfZone, marineZone) {
  if (!isValidTagId(tagId)) throw new Error("invalid tagId");
  const sanitizedTownName = sanitizeTownName(townName);
  const sanitizedCoastFacingDirection = sanitizeCoastFacingDirection(coastFacingDirection);
  const sanitizedSrfZone = sanitizeZoneId(srfZone);
  const sanitizedMarineZone = sanitizeZoneId(marineZone);
  const record = Object.assign(
    { stationId: String(stationId), stationName: String(stationName), createdAt: new Date().toISOString() },
    sanitizeCoords(lat, lon),
    sanitizedTownName ? { townName: sanitizedTownName } : null,
    sanitizedCoastFacingDirection ? { coastFacingDirection: sanitizedCoastFacingDirection } : null,
    sanitizedSrfZone ? { srfZone: sanitizedSrfZone } : null,
    sanitizedMarineZone ? { marineZone: sanitizedMarineZone } : null
  );
  await tagFile(bucket, tagId).save(JSON.stringify(record), { contentType: "application/json" });
  return record;
}

// Reverse index -- "which tag (if any) is linked to this device" --
// kept as its OWN small record rather than ever scanning tide-tags/ by
// deviceId, since that's unbounded and these are append-only objects,
// not a queryable database. Deliberately holds ONLY tagId + linkedAt:
// a device's own pages (Manage/Pair) are trusted with nothing more
// secret than "a keychain is paired" -- the tagId itself is a bearer
// credential for a DIFFERENT trust scope (see TAG_ID_PATTERN's own
// comment on why it's never shown on screen for the pairing-code flow
// either), so nothing that reads this file is allowed to hand the raw
// tagId back to a client; see deviceLinkStatusHandler in index.js.
const DEVICE_TAG_LINKS_PREFIX = "device-tag-links/";

function deviceTagLinkFile(bucket, deviceId) {
  return bucket.file(DEVICE_TAG_LINKS_PREFIX + deviceId + ".json");
}

// Returns null for a device with nothing paired (the default, expected
// state) or a malformed deviceId, never for a genuine storage failure,
// which throws -- same null-vs-throw contract as fetchTideTag.
async function fetchDeviceTagLink(bucket, deviceId) {
  if (!isValidDeviceId(deviceId)) return null;
  try {
    const [buf] = await deviceTagLinkFile(bucket, deviceId).download();
    return JSON.parse(buf.toString("utf8"));
  } catch (err) {
    if (err && err.code === 404) return null;
    throw err;
  }
}

// Only clears the pointer if it STILL points at tagId -- guards against
// an unlink (triggered by a newer, different pairing superseding this
// one -- see linkTideTagToDevice below) racing past a pairing that's
// already replaced it, which would otherwise delete the NEWER link
// instead of the stale one it was actually meant to clear.
async function clearDeviceTagLinkIfMatching(bucket, deviceId, tagId) {
  const current = await fetchDeviceTagLink(bucket, deviceId);
  if (!current || current.tagId !== tagId) return;
  try {
    await deviceTagLinkFile(bucket, deviceId).delete();
  } catch (err) {
    if (err && err.code === 404) return;
    throw err;
  }
}

// Links a tag to a WaveClock device -- once a tag's record carries this,
// the tide page stops using its OWN stationId/stationName/etc. fields
// (left in place, not deleted, in case they're ever useful again) and
// instead reads straight from that device's own locations/{deviceId}.json,
// so editing the WaveClock's settings is what updates the keychain too.
//
// One keychain per WaveClock, enforced here rather than left as just a
// UI convention: if this DEVICE already has a DIFFERENT tag linked,
// that tag is unlinked first (falls back to standalone, same as an
// explicit unpair); if this TAG was already linked to a DIFFERENT
// device, that old device's own reverse pointer is cleared so it stops
// claiming a keychain it no longer has. Either way this always
// succeeds and moves the link -- re-pairing (to the same device, a
// different device, or a device that already had a different tag) is
// never an error case. Works on a tag that's never been tapped/
// registered at all (fetchTideTag returns null, so the merge below
// just starts from an empty record) -- pairing a brand-new keychain to
// an existing WaveClock before its first tap is a real, expected path,
// not an edge case.
async function linkTideTagToDevice(bucket, tagId, deviceId) {
  if (!isValidTagId(tagId)) throw new Error("invalid tagId");
  if (!isValidDeviceId(deviceId)) throw new Error("invalid deviceId");

  const existing = await fetchTideTag(bucket, tagId);
  if (existing && existing.linkedDeviceId && existing.linkedDeviceId !== deviceId) {
    await clearDeviceTagLinkIfMatching(bucket, existing.linkedDeviceId, tagId);
  }

  const existingLink = await fetchDeviceTagLink(bucket, deviceId);
  if (existingLink && existingLink.tagId !== tagId) {
    await unlinkTideTagFromDevice(bucket, existingLink.tagId);
  }

  const linkedAt = new Date().toISOString();
  const record = Object.assign({}, existing, { linkedDeviceId: deviceId, linkedAt });
  await tagFile(bucket, tagId).save(JSON.stringify(record), { contentType: "application/json" });
  await deviceTagLinkFile(bucket, deviceId).save(JSON.stringify({ tagId, linkedAt }), { contentType: "application/json" });
  return record;
}

// The explicit "Unpair" action's own write, also reused internally by
// linkTideTagToDevice above whenever a NEW pairing supersedes an older
// one. Clears just the linking fields, keeping whatever standalone
// station data (if any) the tag had before being linked, so unpairing
// hands it back exactly as it was -- same "nothing erased, just no
// longer the active source" principle linking itself already follows.
// A no-op (not an error) for a tag that was never linked in the first
// place; returns the deviceId it was unlinked FROM (or null) so a
// caller can report what actually happened.
async function unlinkTideTagFromDevice(bucket, tagId) {
  if (!isValidTagId(tagId)) throw new Error("invalid tagId");
  const existing = await fetchTideTag(bucket, tagId);
  if (!existing || existing.linkedDeviceId == null) return null;
  const deviceId = existing.linkedDeviceId;
  const record = Object.assign({}, existing);
  delete record.linkedDeviceId;
  delete record.linkedAt;
  await tagFile(bucket, tagId).save(JSON.stringify(record), { contentType: "application/json" });
  await clearDeviceTagLinkIfMatching(bucket, deviceId, tagId);
  return deviceId;
}

// Device-side counterpart to unlinkTideTagFromDevice -- the Manage
// page's own "Unpair" action knows only deviceId (same trust token
// every other device-scoped action there already relies on), never the
// actual tagId, so it has to go through the reverse index to find out
// what to unlink. A device with nothing paired is a no-op, not an
// error -- same "already in the state you wanted" contract as
// deleteTideTag.
async function unpairDevice(bucket, deviceId) {
  if (!isValidDeviceId(deviceId)) throw new Error("invalid deviceId");
  // Self-healing (see its own comment) rather than the plain lookup --
  // without it, a device paired before device-tag-links/ existed would
  // report "nothing to unpair" even though a keychain really is linked.
  const link = await fetchDeviceTagLinkSelfHealing(bucket, deviceId);
  if (!link) return false;
  await unlinkTideTagFromDevice(bucket, link.tagId);
  return true;
}

// ---------- short-lived pairing codes ----------
//
// The one-tap shortcut (same browser that set up the WaveClock taps a
// new keychain) calls linkTideTagToDevice directly -- both IDs are
// already known to that single browser. This section covers the OTHER
// case: pairing from a different device than the one that tapped the
// keychain (someone else's phone did the tap, or they're pairing from a
// computer). The keychain's own page requests a short, disposable code;
// the WaveClock's Manage page redeems it. The real tagId is never shown
// on screen for this -- only this short-lived stand-in is, so a glance
// at someone's screen (or a screenshot) can't hand over the tag's own
// permanent, otherwise-never-displayed ID.
//
// Same unmistakable charset TAG_ID_PATTERN already draws from (no
// 0/O/1/I) -- a code meant to be read off one screen and typed into
// another has the exact same misread risk a tagId would, just over a
// much shorter string.
const PAIR_CODE_CHARSET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const PAIR_CODE_LENGTH = 6;
const PAIR_CODE_PATTERN = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/;
const PAIR_CODE_PREFIX = "tide-tag-pair-codes/";
const PAIR_CODE_TTL_MS = 15 * 60 * 1000;

function isValidPairCode(code) {
  return typeof code === "string" && PAIR_CODE_PATTERN.test(code);
}

function pairCodeFile(bucket, code) {
  return bucket.file(PAIR_CODE_PREFIX + code + ".json");
}

function randomPairCode() {
  let code = "";
  for (let i = 0; i < PAIR_CODE_LENGTH; i++) {
    code += PAIR_CODE_CHARSET[crypto.randomInt(PAIR_CODE_CHARSET.length)];
  }
  return code;
}

// A fresh code per call, retried on the astronomically rare chance of
// colliding with another still-live code -- ifGenerationMatch: 0 is the
// same atomic create-only guard saveTideTag uses, so two concurrent
// requests can never silently clobber each other's code.
const PAIR_CODE_MAX_ATTEMPTS = 5;
async function createPairCode(bucket, tagId) {
  if (!isValidTagId(tagId)) throw new Error("invalid tagId");
  for (let attempt = 0; attempt < PAIR_CODE_MAX_ATTEMPTS; attempt++) {
    const code = randomPairCode();
    try {
      await pairCodeFile(bucket, code).save(JSON.stringify({ tagId, createdAt: new Date().toISOString() }), {
        contentType: "application/json",
        preconditionOpts: { ifGenerationMatch: 0 }
      });
      return code;
    } catch (err) {
      if (err && err.code === 412) continue;
      throw err;
    }
  }
  throw new Error("couldn't generate a unique pairing code");
}

// Resolves a code back to the tag it was issued for, links that tag to
// deviceId, and burns the code so it can't be reused -- the delete
// happens AFTER a successful read but BEFORE the link, and a delete
// that 404s (someone else redeemed it a moment earlier) is treated the
// same as "expired," not a crash, which is what makes this safe against
// two concurrent redemptions of the same code.
async function redeemPairCode(bucket, code, deviceId) {
  if (!isValidPairCode(code)) throw new Error("invalid code");
  if (!isValidDeviceId(deviceId)) throw new Error("invalid deviceId");
  let entry;
  try {
    const [buf] = await pairCodeFile(bucket, code).download();
    entry = JSON.parse(buf.toString("utf8"));
  } catch (err) {
    if (err && err.code === 404) return { status: "invalid-or-expired" };
    throw err;
  }
  const age = Date.now() - new Date(entry.createdAt).getTime();
  if (!(age >= 0) || age > PAIR_CODE_TTL_MS) {
    return { status: "invalid-or-expired" };
  }
  try {
    await pairCodeFile(bucket, code).delete();
  } catch (err) {
    if (err && err.code === 404) return { status: "invalid-or-expired" };
    throw err;
  }
  const record = await linkTideTagToDevice(bucket, entry.tagId, deviceId);
  return { status: "linked", tagId: entry.tagId, record };
}

// One-time repair for pairings made before device-tag-links/ existed at
// all (it was added alongside linkTideTagToDevice's own write of it,
// later than pairing itself) -- those tags were correctly linked on
// their own tide-tags/ record, but have no reverse-index file for
// deviceLinkStatusHandler to find, so Manage's own pairing card never
// learned about them. Scans every tide-tags/ record for a
// linkedDeviceId with no matching reverse link yet, and writes the
// missing one. Never touches a device that already has a reverse link
// (whether from this same tag or a newer pairing since) -- a repeat run
// is a cheap no-op, and this never overwrites a link that's already
// pointing somewhere else.
async function backfillDeviceTagLinks(bucket) {
  const [files] = await bucket.getFiles({ prefix: TIDE_TAGS_PREFIX });
  let scanned = 0;
  let skipped = 0;
  const backfilled = [];
  for (const file of files) {
    scanned++;
    const tagId = file.name.slice(TIDE_TAGS_PREFIX.length, -".json".length);
    if (!isValidTagId(tagId)) continue; // not a real tag record (shouldn't happen, but never worth crashing the whole batch over)
    let record;
    try {
      const [buf] = await file.download();
      record = JSON.parse(buf.toString("utf8"));
    } catch (err) {
      continue; // unreadable/corrupt entry -- not this repair's job to fix
    }
    const deviceId = record && record.linkedDeviceId;
    if (!deviceId || !isValidDeviceId(deviceId)) continue;
    const existingLink = await fetchDeviceTagLink(bucket, deviceId);
    if (existingLink) { skipped++; continue; }
    await deviceTagLinkFile(bucket, deviceId).save(
      JSON.stringify({ tagId, linkedAt: record.linkedAt || new Date().toISOString() }),
      { contentType: "application/json" }
    );
    backfilled.push(deviceId);
  }
  return { scanned, backfilled, skipped };
}

// Same contract as fetchDeviceTagLink (null for "nothing paired"), but
// additionally self-heals the SAME legacy gap backfillDeviceTagLinks
// repairs in bulk -- used by the two places a device itself asks "is a
// keychain paired to me" (Manage's status card, and Unpair), so an
// owner who paired before device-tag-links/ existed sees the correct
// state the very next time they load either page, with no admin secret
// and no action of their own beyond that. Only falls back to a scan of
// tide-tags/ when the direct reverse-index lookup comes up empty --
// once backfilled (here, or by the bulk admin repair), every later call
// for this same device takes the fast, no-scan path again, same as any
// other device that was always paired after the fix shipped.
async function fetchDeviceTagLinkSelfHealing(bucket, deviceId) {
  const direct = await fetchDeviceTagLink(bucket, deviceId);
  if (direct) return direct;
  if (!isValidDeviceId(deviceId)) return null;
  const [files] = await bucket.getFiles({ prefix: TIDE_TAGS_PREFIX });
  for (const file of files) {
    const tagId = file.name.slice(TIDE_TAGS_PREFIX.length, -".json".length);
    if (!isValidTagId(tagId)) continue;
    let record;
    try {
      const [buf] = await file.download();
      record = JSON.parse(buf.toString("utf8"));
    } catch (err) {
      continue; // unreadable/corrupt entry -- not this lookup's job to fix
    }
    if (!record || record.linkedDeviceId !== deviceId) continue;
    const link = { tagId, linkedAt: record.linkedAt || new Date().toISOString() };
    await deviceTagLinkFile(bucket, deviceId).save(JSON.stringify(link), { contentType: "application/json" });
    return link;
  }
  return null;
}

// Unlinks a tag (lost/gifted keychain, or re-registering after a support
// request clears it) -- best-effort delete, same "already gone isn't an
// error" contract as index.js's own deleteIfExists.
async function deleteTideTag(bucket, tagId) {
  if (!isValidTagId(tagId)) throw new Error("invalid tagId");
  try {
    await tagFile(bucket, tagId).delete();
  } catch (err) {
    if (err && err.code === 404) return;
    throw err;
  }
}

module.exports = { TAG_ID_PATTERN, isValidTagId, DEVICE_ID_PATTERN, isValidDeviceId, PAIR_CODE_PATTERN, isValidPairCode, sanitizeCoords, sanitizeTownName, sanitizeCoastFacingDirection, sanitizeZoneId, COAST_FACING_DIRECTIONS, ZONE_ID_PATTERN, fetchTideTag, saveTideTag, updateTideTag, deleteTideTag, isTagIdMinted, mintTagIds, linkTideTagToDevice, createPairCode, redeemPairCode, fetchDeviceTagLink, unlinkTideTagFromDevice, unpairDevice, backfillDeviceTagLinks, fetchDeviceTagLinkSelfHealing };
