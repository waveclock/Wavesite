"use strict";

// Exercises lib/keychainScreens.js directly (extraction/validation logic
// plus a fully in-memory fake bucket for the fetch/save round trip) --
// no live Storage call.

const assert = require("assert");
const {
  extractYoutubePlaylistId,
  sanitizeKeychainScreens,
  fetchKeychainScreens,
  saveKeychainScreens
} = require("../lib/keychainScreens");

const T1 = "AAAAAAAAAABBBBBBBBBB"; // 20 chars, valid tagId shape

function makeFakeBucket(initialFiles) {
  const store = new Map(Object.entries(initialFiles || {}));
  function fileHandle(path) {
    return {
      path,
      async download() {
        if (!store.has(path)) {
          const err = new Error("not found");
          err.code = 404;
          throw err;
        }
        return [Buffer.from(store.get(path), "utf8")];
      },
      async save(data) { store.set(path, data); }
    };
  }
  return { file: fileHandle, _store: store };
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ok - " + name);
  } catch (err) {
    failed++;
    console.log("  FAIL - " + name);
    console.log("    " + err.message);
  }
}

(async () => {
  console.log("extractYoutubePlaylistId");
  await test("a full playlist page URL yields its list id", () => {
    assert.strictEqual(
      extractYoutubePlaylistId("https://youtube.com/playlist?list=PLmXxqSJJq-yXrCPGIT2gn8b34JjOrl4Xf&si=AoSfvgW48QuCSSE7"),
      "PLmXxqSJJq-yXrCPGIT2gn8b34JjOrl4Xf"
    );
  });
  await test("a video+playlist combo URL (youtu.be) yields the list id, not the video id", () => {
    assert.strictEqual(extractYoutubePlaylistId("https://youtu.be/djV11Xbc914?list=PLabc123def456"), "PLabc123def456");
  });
  await test("www./m./music. subdomains are all accepted", () => {
    assert.strictEqual(extractYoutubePlaylistId("https://www.youtube.com/playlist?list=PLabc123def456"), "PLabc123def456");
    assert.strictEqual(extractYoutubePlaylistId("https://m.youtube.com/playlist?list=PLabc123def456"), "PLabc123def456");
    assert.strictEqual(extractYoutubePlaylistId("https://music.youtube.com/playlist?list=PLabc123def456"), "PLabc123def456");
  });
  await test("a bare playlist id (no URL at all) is accepted directly", () => {
    assert.strictEqual(extractYoutubePlaylistId("PLmXxqSJJq-yXrCPGIT2gn8b34JjOrl4Xf"), "PLmXxqSJJq-yXrCPGIT2gn8b34JjOrl4Xf");
  });
  await test("a single-video link with no list= is rejected, not guessed", () => {
    assert.strictEqual(extractYoutubePlaylistId("https://youtu.be/djV11Xbc914?is=T_NBkF_Dk0XCcdQT"), null);
  });
  await test("a non-YouTube URL is rejected even with a list= param", () => {
    assert.strictEqual(extractYoutubePlaylistId("https://evil.example.com/playlist?list=PLabc123def456"), null);
  });
  await test("garbage input yields null, not a thrown error", () => {
    assert.strictEqual(extractYoutubePlaylistId(""), null);
    assert.strictEqual(extractYoutubePlaylistId("not a url or an id!!"), null);
    assert.strictEqual(extractYoutubePlaylistId(null), null);
    assert.strictEqual(extractYoutubePlaylistId(undefined), null);
  });

  console.log("sanitizeKeychainScreens");
  await test("a valid songList entry round-trips unchanged (plus whatever extraction normalizes)", () => {
    const out = sanitizeKeychainScreens([{ type: "songList", playlistId: "https://youtube.com/playlist?list=PLabc123def456" }]);
    assert.deepStrictEqual(out, [{ type: "songList", playlistId: "PLabc123def456" }]);
  });
  await test("non-array input throws", () => {
    assert.throws(() => sanitizeKeychainScreens("nope"));
    assert.throws(() => sanitizeKeychainScreens(null));
  });
  await test("an entry with no type throws", () => {
    assert.throws(() => sanitizeKeychainScreens([{ playlistId: "PLabc123def456" }]));
  });
  await test("an unknown type throws", () => {
    assert.throws(() => sanitizeKeychainScreens([{ type: "weatherRadar" }]));
  });
  await test("an invalid songList entry (bad playlist link) throws", () => {
    assert.throws(() => sanitizeKeychainScreens([{ type: "songList", playlistId: "not a playlist" }]));
  });
  await test("more than MAX_SCREENS entries throws", () => {
    const many = Array.from({ length: 21 }, () => ({ type: "songList", playlistId: "PLabc123def456" }));
    assert.throws(() => sanitizeKeychainScreens(many));
  });
  await test("two songList entries collapse to one (last wins) -- each type is a singleton", () => {
    const out = sanitizeKeychainScreens([
      { type: "songList", playlistId: "PLabc123def456" },
      { type: "songList", playlistId: "PLxyz789uvw012" }
    ]);
    assert.deepStrictEqual(out, [{ type: "songList", playlistId: "PLxyz789uvw012" }]);
  });

  console.log("fetchKeychainScreens / saveKeychainScreens");
  await test("a tag with nothing saved yet reads as an empty array, not an error", async () => {
    const bucket = makeFakeBucket();
    const screens = await fetchKeychainScreens(bucket, T1);
    assert.deepStrictEqual(screens, []);
  });
  await test("save then fetch round-trips the exact array", async () => {
    const bucket = makeFakeBucket();
    await saveKeychainScreens(bucket, T1, [{ type: "songList", playlistId: "PLabc123def456" }]);
    const screens = await fetchKeychainScreens(bucket, T1);
    assert.deepStrictEqual(screens, [{ type: "songList", playlistId: "PLabc123def456" }]);
  });
  await test("a malformed tagId never touches storage -- reads empty, save throws", async () => {
    const bucket = makeFakeBucket();
    assert.deepStrictEqual(await fetchKeychainScreens(bucket, "short"), []);
    await assert.rejects(() => saveKeychainScreens(bucket, "short", []));
  });

  console.log(passed + " passed, " + failed + " failed");
  if (failed > 0) process.exit(1);
})();
