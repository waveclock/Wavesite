// Keychain Screens: user-added extra panels on the keychain tide page
// (404.html) -- opt-in, keychain-only (never pushed to a physical
// WaveClock), picked from a small gallery page (screens/index.html,
// reached via the page's own "More Screens" button). One small JSON
// array per tag, same "one file per identity" Storage convention
// tide-tags/ already uses (see that file's own header comment for why
// Storage instead of a real database).
//
// Deliberately keyed by tagId, never deviceId -- this is a property of
// the physical keychain someone's holding, not of any WaveClock it
// might also be linked to (see 404.html's own identity model: every
// visit resolves a tagId from the URL first, device-linking is a
// secondary lookup on top of that).
"use strict";

const { isValidTagId } = require("./tideTag");

const KEYCHAIN_SCREENS_PREFIX = "keychain-screens/";

// Generous cap, not a real expected count -- just stops one malformed/
// abusive request from writing an unbounded array.
const MAX_SCREENS = 20;

function screensFile(bucket, tagId) {
  return bucket.file(KEYCHAIN_SCREENS_PREFIX + tagId + ".json");
}

// Real YouTube playlist IDs ("PL...", "UU...", "RD...", "OL...", etc.)
// are usually 13-34 chars of this exact character set -- kept a little
// looser than that on purpose (10-64) so this doesn't need updating if
// YouTube ever mints a new ID shape, while still being strict enough
// that nothing but a playlist-id-shaped string reaches the embed URL.
const PLAYLIST_ID_PATTERN = /^[A-Za-z0-9_-]{10,64}$/;

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);

// Accepts either a full YouTube URL with a list= param (a playlist page
// link, or a video+playlist combo link) or a bare playlist ID pasted
// directly. Anything else -- a non-YouTube URL, a video-only link with
// no list=, a malformed/garbage string -- returns null rather than
// guessing, same "fail loudly/degrade cleanly, never fabricate" pattern
// every other sanitizer in this codebase follows.
function extractYoutubePlaylistId(input) {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    if (!YOUTUBE_HOSTS.has(u.hostname.toLowerCase())) return null;
    const list = u.searchParams.get("list");
    return list && PLAYLIST_ID_PATTERN.test(list) ? list : null;
  } catch (err) {
    // Not a URL at all -- maybe a bare playlist ID was pasted.
    return PLAYLIST_ID_PATTERN.test(trimmed) ? trimmed : null;
  }
}

// One validator per gallery item type -- each takes the raw entry an
// "Add" submitted and either returns the sanitized, storage-ready
// version or null if it doesn't hold up. Adding a new gallery item type
// later means adding one more entry here (plus its own gallery card and
// 404.html panel) -- nothing else in sanitizeKeychainScreens/fetch/save
// below needs to change.
const SCREEN_VALIDATORS = {
  songList: (raw) => {
    const playlistId = extractYoutubePlaylistId(raw && raw.playlistId);
    return playlistId ? { type: "songList", playlistId } : null;
  }
};

// Validates and normalizes a whole screens array -- throws (with a
// message safe to show the caller) on the first entry that doesn't hold
// up, rather than silently dropping it, so a bad request never quietly
// loses part of what the customer already had saved. At most one entry
// per type is kept (the LAST one wins) -- every gallery item type today
// is a singleton (one Song List, not a queue of them), and the gallery
// page always resubmits the full array with its new/edited entry
// already in place, so "add" is really "upsert by type" from here.
function sanitizeKeychainScreens(rawScreens) {
  if (!Array.isArray(rawScreens)) throw new Error("screens must be an array");
  if (rawScreens.length > MAX_SCREENS) throw new Error("too many screens");
  const byType = new Map();
  for (const raw of rawScreens) {
    if (!raw || typeof raw.type !== "string") throw new Error("each screen needs a type");
    const validator = SCREEN_VALIDATORS[raw.type];
    if (!validator) throw new Error("unknown screen type: " + raw.type);
    const sanitized = validator(raw);
    if (!sanitized) throw new Error("invalid " + raw.type + " screen");
    byType.set(sanitized.type, sanitized);
  }
  return Array.from(byType.values());
}

// Mirrors fetchTideTag's own "malformed input/missing file never throws,
// just reads as empty" contract -- no screens added yet is the normal
// state for almost every tag, not an error.
async function fetchKeychainScreens(bucket, tagId) {
  if (!isValidTagId(tagId)) return [];
  try {
    const [buf] = await screensFile(bucket, tagId).download();
    const data = JSON.parse(buf.toString("utf8"));
    return Array.isArray(data.screens) ? data.screens : [];
  } catch (err) {
    if (err && err.code === 404) return [];
    throw err;
  }
}

// Always overwrites the whole file with exactly what's passed -- same
// "no precondition, last write wins" choice updateTideTag makes for its
// own re-savable record, since this is always a full replace from the
// gallery page's own already-fetched copy, not a partial patch.
async function saveKeychainScreens(bucket, tagId, screens) {
  if (!isValidTagId(tagId)) throw new Error("invalid tagId");
  const body = JSON.stringify({ screens, updatedAt: new Date().toISOString() });
  await screensFile(bucket, tagId).save(body, { contentType: "application/json" });
}

module.exports = {
  KEYCHAIN_SCREENS_PREFIX,
  MAX_SCREENS,
  PLAYLIST_ID_PATTERN,
  extractYoutubePlaylistId,
  sanitizeKeychainScreens,
  fetchKeychainScreens,
  saveKeychainScreens
};
