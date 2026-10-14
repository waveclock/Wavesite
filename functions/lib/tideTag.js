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

const TIDE_TAGS_PREFIX = "tide-tags/";

// Same character set scripts/generateTagIds.js draws IDs from -- excludes
// 0/O/1/I so a tag etched small, printed, or read off a phone screen in
// bright sun can't be misread into a DIFFERENT valid-looking ID.
// Re-validated here (not just trusted from the URL) because tagId gets
// interpolated straight into a Cloud Storage object path below -- a
// malformed or path-traversal-shaped value must never reach that call.
const TAG_ID_PATTERN = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4,6}$/;

function isValidTagId(tagId) {
  return typeof tagId === "string" && TAG_ID_PATTERN.test(tagId);
}

function tagFile(bucket, tagId) {
  return bucket.file(TIDE_TAGS_PREFIX + tagId + ".json");
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

// Registers a station against a tag -- but ONLY if that tag isn't
// already registered. preconditionOpts.ifGenerationMatch: 0 is Cloud
// Storage's own atomic "create, don't overwrite" precondition
// (generation 0 means "no live object at this path yet"); the request
// fails with a 412 if another write already landed first -- e.g. two
// phones tapping the same physical tag at nearly the same moment, or a
// phone double-submitting the picker. That specific, expected race
// returns { status: "already-registered" } instead of throwing; any
// OTHER storage failure still throws.
async function saveTideTag(bucket, tagId, stationId, stationName, lat, lon, townName) {
  if (!isValidTagId(tagId)) throw new Error("invalid tagId");
  const sanitizedTownName = sanitizeTownName(townName);
  const record = Object.assign(
    { stationId: String(stationId), stationName: String(stationName), createdAt: new Date().toISOString() },
    sanitizeCoords(lat, lon),
    sanitizedTownName ? { townName: sanitizedTownName } : null
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
async function updateTideTag(bucket, tagId, stationId, stationName, lat, lon, townName) {
  if (!isValidTagId(tagId)) throw new Error("invalid tagId");
  const sanitizedTownName = sanitizeTownName(townName);
  const record = Object.assign(
    { stationId: String(stationId), stationName: String(stationName), createdAt: new Date().toISOString() },
    sanitizeCoords(lat, lon),
    sanitizedTownName ? { townName: sanitizedTownName } : null
  );
  await tagFile(bucket, tagId).save(JSON.stringify(record), { contentType: "application/json" });
  return record;
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

module.exports = { TAG_ID_PATTERN, isValidTagId, sanitizeCoords, sanitizeTownName, fetchTideTag, saveTideTag, updateTideTag, deleteTideTag };
