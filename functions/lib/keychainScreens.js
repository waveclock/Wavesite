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
//
// Song List and Live Video Feed aren't strictly opt-in anymore -- every
// keychain shows WaveClock's own default for whichever of these it
// hasn't set its own entry for (see DEFAULT_SCREENS/withDefaultScreens
// below), so every visitor sees SOMETHING instead of a blank/missing
// panel, with a clear path to replace it with their own pick.
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
// Video IDs, unlike playlist IDs, are always exactly 11 characters --
// this is what makes a bare pasted ID (no URL at all) unambiguous
// between the two down in extractYoutubeMusicRef below.
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);

// Accepts a YouTube playlist link, a single video link (watch, youtu.be,
// Shorts, or /live/ -- YouTube's own share-link format for an active
// live stream), or a bare ID of either pasted directly -- "kind" tells
// the caller which. A watch/youtu.be/Shorts/live link that ALSO happens
// to carry a list= param (YouTube auto-attaches one to almost any watch
// link, often an auto-generated "mix" that was never the customer's
// real intent) is still treated as the single video -- video wins
// whenever one is present, playlist only applies to an actual
// .../playlist?list= link or a bare playlist ID. Anything else -- a
// non-YouTube URL, a malformed/garbage string -- returns null rather
// than guessing, same "fail loudly/degrade cleanly, never fabricate"
// pattern every other sanitizer in this codebase follows.
function extractYoutubeMusicRef(input) {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    const host = u.hostname.toLowerCase();
    if (!YOUTUBE_HOSTS.has(host)) return null;
    const pathVideo = host === "youtu.be" ? u.pathname.slice(1).split("/")[0]
      : /^\/(shorts|live)\//.test(u.pathname) ? u.pathname.split("/")[2]
      : null;
    const v = u.searchParams.get("v");
    const videoId = pathVideo && VIDEO_ID_PATTERN.test(pathVideo) ? pathVideo
      : v && VIDEO_ID_PATTERN.test(v) ? v
      : null;
    if (videoId) return { kind: "video", id: videoId };
    const list = u.searchParams.get("list");
    return list && PLAYLIST_ID_PATTERN.test(list) ? { kind: "playlist", id: list } : null;
  } catch (err) {
    // Not a URL at all -- maybe a bare ID was pasted.
    if (VIDEO_ID_PATTERN.test(trimmed)) return { kind: "video", id: trimmed };
    return PLAYLIST_ID_PATTERN.test(trimmed) ? { kind: "playlist", id: trimmed } : null;
  }
}

// One validator per gallery item type -- each takes the raw entry an
// "Add" submitted and either returns the sanitized, storage-ready
// version or null if it doesn't hold up. Adding a new gallery item type
// later means adding one more entry here (plus its own gallery card and
// 404.html panel) -- nothing else in sanitizeKeychainScreens/fetch/save
// below needs to change.
//
// The gallery page already ran extractYoutubeMusicRef (its own
// duplicated copy) on whatever the customer pasted, so raw.kind/raw.id
// here is already a clean {kind, id} pair, not a raw URL -- this just
// re-confirms id's shape actually matches the claimed kind, the same
// "never trust the client, but don't redo work it already did
// correctly" split astroProxy's own validation uses for its query params.
const SCREEN_VALIDATORS = {
  songList: (raw) => {
    if (!raw || typeof raw.id !== "string") return null;
    if (raw.kind === "video" && VIDEO_ID_PATTERN.test(raw.id)) return { type: "songList", kind: "video", id: raw.id };
    if (raw.kind === "playlist" && PLAYLIST_ID_PATTERN.test(raw.id)) return { type: "songList", kind: "playlist", id: raw.id };
    return null;
  },
  // Always a single video (a live stream's own video ID doesn't change
  // while it's live) -- no kind field needed, unlike songList, since
  // there's no playlist equivalent here.
  liveVideo: (raw) => {
    if (!raw || typeof raw.id !== "string") return null;
    return VIDEO_ID_PATTERN.test(raw.id) ? { type: "liveVideo", id: raw.id } : null;
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

// WaveClock's own pick for a keychain that hasn't set its own yet -- one
// per type, keyed the same way SCREEN_VALIDATORS is. Real links, run
// through extractYoutubeMusicRef the same as any customer paste would
// be (see that function's own comment on the /live/ share-link shape):
// https://www.youtube.com/live/EChjekRKsKU and
// https://youtube.com/playlist?list=PLmXxqSJJq-yXrCPGIT2gn8b34JjOrl4Xf
const DEFAULT_SCREENS = {
  songList: { type: "songList", kind: "playlist", id: "PLmXxqSJJq-yXrCPGIT2gn8b34JjOrl4Xf" },
  liveVideo: { type: "liveVideo", id: "EChjekRKsKU" }
};

// Fills in WaveClock's own default for any type the customer hasn't set
// their own entry for yet, flagged `preset: true` so a caller (the
// gallery page, specifically) can tell "this is just what we show by
// default" apart from "the customer actually chose this" -- 404.html's
// own panels don't need to care either way, they just play whatever
// comes back. Never mutates the real saved array; this is purely a
// GET-time view, PUT/saveKeychainScreens above are completely untouched
// by it, so a preset is never accidentally written to storage as if it
// had been chosen.
function withDefaultScreens(screens) {
  const present = new Set((screens || []).map((s) => s && s.type));
  const merged = (screens || []).slice();
  for (const type of Object.keys(DEFAULT_SCREENS)) {
    if (!present.has(type)) merged.push(Object.assign({ preset: true }, DEFAULT_SCREENS[type]));
  }
  return merged;
}

module.exports = {
  KEYCHAIN_SCREENS_PREFIX,
  MAX_SCREENS,
  PLAYLIST_ID_PATTERN,
  VIDEO_ID_PATTERN,
  DEFAULT_SCREENS,
  extractYoutubeMusicRef,
  sanitizeKeychainScreens,
  fetchKeychainScreens,
  saveKeychainScreens,
  withDefaultScreens
};
