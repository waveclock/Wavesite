"use strict";

// Exercises lib/keychainScreens.js directly (extraction/validation logic
// plus a fully in-memory fake bucket for the fetch/save round trip) --
// no live Storage call.

const assert = require("assert");
const {
  extractYoutubeMusicRef,
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
  console.log("extractYoutubeMusicRef -- playlists");
  await test("a full playlist page URL yields a playlist ref", () => {
    assert.deepStrictEqual(
      extractYoutubeMusicRef("https://youtube.com/playlist?list=PLmXxqSJJq-yXrCPGIT2gn8b34JjOrl4Xf&si=AoSfvgW48QuCSSE7"),
      { kind: "playlist", id: "PLmXxqSJJq-yXrCPGIT2gn8b34JjOrl4Xf" }
    );
  });
  await test("www./m./music. subdomains are all accepted", () => {
    assert.deepStrictEqual(extractYoutubeMusicRef("https://www.youtube.com/playlist?list=PLabc123def456"), { kind: "playlist", id: "PLabc123def456" });
    assert.deepStrictEqual(extractYoutubeMusicRef("https://m.youtube.com/playlist?list=PLabc123def456"), { kind: "playlist", id: "PLabc123def456" });
    assert.deepStrictEqual(extractYoutubeMusicRef("https://music.youtube.com/playlist?list=PLabc123def456"), { kind: "playlist", id: "PLabc123def456" });
  });
  await test("a bare playlist id (no URL at all) is accepted directly", () => {
    assert.deepStrictEqual(extractYoutubeMusicRef("PLmXxqSJJq-yXrCPGIT2gn8b34JjOrl4Xf"), { kind: "playlist", id: "PLmXxqSJJq-yXrCPGIT2gn8b34JjOrl4Xf" });
  });

  console.log("extractYoutubeMusicRef -- single videos (the feature this adds)");
  await test("a plain youtu.be share link yields a video ref", () => {
    assert.deepStrictEqual(extractYoutubeMusicRef("https://youtu.be/djV11Xbc914?is=T_NBkF_Dk0XCcdQT"), { kind: "video", id: "djV11Xbc914" });
  });
  await test("a youtube.com/watch?v= link yields a video ref", () => {
    assert.deepStrictEqual(extractYoutubeMusicRef("https://www.youtube.com/watch?v=djV11Xbc914"), { kind: "video", id: "djV11Xbc914" });
  });
  await test("a Shorts link yields a video ref", () => {
    assert.deepStrictEqual(extractYoutubeMusicRef("https://www.youtube.com/shorts/djV11Xbc914"), { kind: "video", id: "djV11Xbc914" });
  });
  await test("a bare 11-char video id (no URL at all) is accepted directly as a video, not a playlist", () => {
    assert.deepStrictEqual(extractYoutubeMusicRef("djV11Xbc914"), { kind: "video", id: "djV11Xbc914" });
  });
  await test("a watch link that ALSO carries a list= (YouTube's auto-attached mix) still resolves to the video, not the list", () => {
    assert.deepStrictEqual(extractYoutubeMusicRef("https://www.youtube.com/watch?v=djV11Xbc914&list=RDdjV11Xbc914"), { kind: "video", id: "djV11Xbc914" });
  });
  await test("a youtu.be link that ALSO carries a list= still resolves to the video, not the list", () => {
    assert.deepStrictEqual(extractYoutubeMusicRef("https://youtu.be/djV11Xbc914?list=PLabc123def456"), { kind: "video", id: "djV11Xbc914" });
  });

  console.log("extractYoutubeMusicRef -- rejections");
  await test("a non-YouTube URL is rejected even with a list= param", () => {
    assert.strictEqual(extractYoutubeMusicRef("https://evil.example.com/playlist?list=PLabc123def456"), null);
  });
  await test("garbage input yields null, not a thrown error", () => {
    assert.strictEqual(extractYoutubeMusicRef(""), null);
    assert.strictEqual(extractYoutubeMusicRef("not a url or an id!!"), null);
    assert.strictEqual(extractYoutubeMusicRef(null), null);
    assert.strictEqual(extractYoutubeMusicRef(undefined), null);
  });

  console.log("sanitizeKeychainScreens");
  await test("a valid playlist songList entry passes through unchanged", () => {
    const out = sanitizeKeychainScreens([{ type: "songList", kind: "playlist", id: "PLabc123def456" }]);
    assert.deepStrictEqual(out, [{ type: "songList", kind: "playlist", id: "PLabc123def456" }]);
  });
  await test("a valid video songList entry passes through unchanged", () => {
    const out = sanitizeKeychainScreens([{ type: "songList", kind: "video", id: "djV11Xbc914" }]);
    assert.deepStrictEqual(out, [{ type: "songList", kind: "video", id: "djV11Xbc914" }]);
  });
  await test("non-array input throws", () => {
    assert.throws(() => sanitizeKeychainScreens("nope"));
    assert.throws(() => sanitizeKeychainScreens(null));
  });
  await test("an entry with no type throws", () => {
    assert.throws(() => sanitizeKeychainScreens([{ kind: "playlist", id: "PLabc123def456" }]));
  });
  await test("an unknown type throws", () => {
    assert.throws(() => sanitizeKeychainScreens([{ type: "weatherRadar" }]));
  });
  await test("an invalid songList entry (bad id shape) throws", () => {
    assert.throws(() => sanitizeKeychainScreens([{ type: "songList", kind: "playlist", id: "not a playlist" }]));
  });
  await test("a kind/id mismatch (playlist-shaped id claimed as a video) throws, not silently accepted", () => {
    assert.throws(() => sanitizeKeychainScreens([{ type: "songList", kind: "video", id: "PLabc123def456" }]));
  });
  await test("a valid liveVideo entry passes through unchanged (no kind field, unlike songList)", () => {
    const out = sanitizeKeychainScreens([{ type: "liveVideo", id: "djV11Xbc914" }]);
    assert.deepStrictEqual(out, [{ type: "liveVideo", id: "djV11Xbc914" }]);
  });
  await test("an invalid liveVideo entry (playlist-shaped id) throws", () => {
    assert.throws(() => sanitizeKeychainScreens([{ type: "liveVideo", id: "PLabc123def456" }]));
  });
  await test("liveVideo and songList coexist -- different types, both singletons, neither displaces the other", () => {
    const out = sanitizeKeychainScreens([
      { type: "songList", kind: "video", id: "djV11Xbc914" },
      { type: "liveVideo", id: "abc12345678" }
    ]);
    assert.deepStrictEqual(out, [
      { type: "songList", kind: "video", id: "djV11Xbc914" },
      { type: "liveVideo", id: "abc12345678" }
    ]);
  });
  await test("more than MAX_SCREENS entries throws", () => {
    const many = Array.from({ length: 21 }, () => ({ type: "songList", kind: "playlist", id: "PLabc123def456" }));
    assert.throws(() => sanitizeKeychainScreens(many));
  });
  await test("two songList entries collapse to one (last wins) -- each type is a singleton", () => {
    const out = sanitizeKeychainScreens([
      { type: "songList", kind: "playlist", id: "PLabc123def456" },
      { type: "songList", kind: "video", id: "djV11Xbc914" }
    ]);
    assert.deepStrictEqual(out, [{ type: "songList", kind: "video", id: "djV11Xbc914" }]);
  });

  console.log("fetchKeychainScreens / saveKeychainScreens");
  await test("a tag with nothing saved yet reads as an empty array, not an error", async () => {
    const bucket = makeFakeBucket();
    const screens = await fetchKeychainScreens(bucket, T1);
    assert.deepStrictEqual(screens, []);
  });
  await test("save then fetch round-trips the exact array", async () => {
    const bucket = makeFakeBucket();
    await saveKeychainScreens(bucket, T1, [{ type: "songList", kind: "video", id: "djV11Xbc914" }]);
    const screens = await fetchKeychainScreens(bucket, T1);
    assert.deepStrictEqual(screens, [{ type: "songList", kind: "video", id: "djV11Xbc914" }]);
  });
  await test("a malformed tagId never touches storage -- reads empty, save throws", async () => {
    const bucket = makeFakeBucket();
    assert.deepStrictEqual(await fetchKeychainScreens(bucket, "short"), []);
    await assert.rejects(() => saveKeychainScreens(bucket, "short", []));
  });

  console.log(passed + " passed, " + failed + " failed");
  if (failed > 0) process.exit(1);
})();
