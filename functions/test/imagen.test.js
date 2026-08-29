"use strict";

// Unit tests for lib/imagen.js -- the Gemini image-generation call for
// the "Beach Buddy" dynamic layer. `generateImpl` is always injected
// here, so none of this ever makes a real Vertex AI call or needs real
// GCP credentials -- same convention as fetchImpl throughout
// dynamic.js/astro.js. The response shape mocked below (`.data`,
// `.candidates[0].finishReason`) mirrors @google/genai's
// GenerateContentResponse -- confirmed against a real deployed call
// (see imagen.js's own header comment for why this isn't the standalone
// Imagen API this originally called).

const assert = require("assert");
const {
  IMAGEN_MODEL,
  IMAGE_ASPECT_RATIO,
  STYLE_PREFIX,
  IMAGEN_SCENE_HINTS,
  buildPrompt,
  generateBeachBuddyArt
} = require("../lib/imagen");

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
  await test("buildPrompt always starts with the fixed style prefix, so the character stays visually consistent day to day", () => {
    Object.keys(IMAGEN_SCENE_HINTS).forEach((pose) => {
      const prompt = buildPrompt({ pose });
      assert.ok(prompt.startsWith(STYLE_PREFIX), pose + "'s prompt doesn't start with the shared style prefix");
      assert.ok(prompt.includes(IMAGEN_SCENE_HINTS[pose]), pose + "'s prompt is missing its own scene hint");
    });
  });
  await test("an unknown/missing pose falls back to the standing hint instead of producing a broken prompt", () => {
    assert.ok(buildPrompt({ pose: "not-a-real-pose" }).includes(IMAGEN_SCENE_HINTS.standing));
    assert.ok(buildPrompt({}).includes(IMAGEN_SCENE_HINTS.standing));
  });
  await test("the prompt explicitly asks for no text/lettering -- Imagen can't reliably render small precise text, so the real headline is drawn separately in code", () => {
    assert.ok(/no text/i.test(STYLE_PREFIX));
  });
  await test("IMAGEN_MODEL and IMAGE_ASPECT_RATIO are non-empty strings (sanity check against a typo breaking every call)", () => {
    assert.strictEqual(typeof IMAGEN_MODEL, "string");
    assert.ok(IMAGEN_MODEL.length > 0);
    assert.ok(["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"].includes(IMAGE_ASPECT_RATIO), "IMAGE_ASPECT_RATIO must be one the model actually supports");
  });

  await test("generateBeachBuddyArt returns the decoded image bytes from a successful call", async () => {
    const fakeBytes = Buffer.from("not a real png, just bytes for the test", "utf8");
    const generateImpl = async (prompt) => {
      assert.ok(prompt.startsWith(STYLE_PREFIX));
      return { data: fakeBytes.toString("base64"), candidates: [{ finishReason: "STOP" }] };
    };
    const result = await generateBeachBuddyArt({ pose: "surfing" }, { generateImpl });
    assert.ok(Buffer.isBuffer(result));
    assert.ok(result.equals(fakeBytes));
  });
  await test("throws when the response has no inline image data at all", async () => {
    const generateImpl = async () => ({ data: undefined, candidates: [{ finishReason: "STOP" }] });
    await assert.rejects(() => generateBeachBuddyArt({ pose: "standing" }, { generateImpl }));
  });
  await test("throws when the image was safety-filtered, including the finish reason in the message", async () => {
    const generateImpl = async () => ({ data: undefined, candidates: [{ finishReason: "SAFETY" }] });
    await assert.rejects(
      () => generateBeachBuddyArt({ pose: "standing" }, { generateImpl }),
      /SAFETY/
    );
  });
  await test("throws when the underlying call itself throws (network/auth failure) -- propagates rather than swallowing it", async () => {
    const generateImpl = async () => { throw new Error("Vertex AI unreachable"); };
    await assert.rejects(() => generateBeachBuddyArt({ pose: "standing" }, { generateImpl }), /Vertex AI unreachable/);
  });

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
