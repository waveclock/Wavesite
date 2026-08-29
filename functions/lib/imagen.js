// Image generation (via Firebase AI Logic / Vertex AI, now "Gemini
// Enterprise Agent Platform") for the "Beach Buddy" dynamic layer --
// kept in its own file, separate from dynamic.js's pure rendering/
// packing logic, the same way astro.js and teamsnap.js are their own
// modules: this is the one piece of the Beach Buddy feature that makes a
// real network call and needs real GCP credentials, so it needs to be
// easy to mock out in tests without pulling the SDK into every test
// file.
"use strict";

// Confirmed LIVE against a real deployed `imagenProxy` call (2026): the
// standalone Imagen model this originally called,
// "imagen-4.0-generate-001" via `ai.models.generateImages(...)`, 404'd
// with "Publisher model ... was not found or your project does not have
// access to it" -- Model Garden search for "Imagen 4" turned up no
// standalone Imagen card at all; image generation now lives on Gemini's
// own multimodal model instead, reached through the ordinary
// `generateContent` call every other Gemini request uses, not a
// separate Imagen-specific method. "gemini-2.5-flash-image" is Model
// Garden's current Google-recommended model for this
// (nicknamed "Nano Banana" there) -- if this ever 404s the same way,
// check Model Garden's own search for "image generation" again, since
// Google has already renamed/relocated this once.
const IMAGEN_MODEL = "gemini-2.5-flash-image";

// Requesting IMAGE (and only IMAGE) output -- see generateBeachBuddyArt,
// which reads the result back off GenerateContentResponse's own `.data`
// convenience getter (the concatenation of any inline-data parts in the
// first candidate), rather than the TEXT response the same model would
// give with a plain chat-style call.
const RESPONSE_MODALITIES = ["IMAGE"];

// This model supports a real fixed set of aspect ratios ("1:1", "2:3",
// "3:2", "3:4", "4:3", "9:16", "16:9", "21:9") via `imageConfig`, same
// idea as the standalone Imagen API this replaced -- still none of them
// close to this display's own 792x272 (~2.9:1) strip. Rather than
// stretch/crop a generated image to an unnatural ratio, this asks for a
// normal-looking "1:1" portrait illustration and lets
// drawBeachBuddyArtCard (in dynamic.js) place it as a modest centered
// panel below the headline, with clean white margin on either side --
// closer to how Life is Good's own designs actually compose a small
// character illustration with text, not an edge-to-edge background fill.
const IMAGE_ASPECT_RATIO = "1:1";

// One fixed style prefix, unchanged across every single call -- the ONE
// thing that keeps "Buddy" reading as the same recurring character day
// to day instead of a new random illustration each time (the model has
// no built-in "same character as yesterday" memory across separate
// requests). Flat 2-color linework (no gradients/shading, which a 1-bit
// luminance threshold would mangle into noise) mirrors the same
// reasoning the design tool's own dithered-logo handling already uses
// for photographic assets, just aimed upstream at the prompt instead of
// downstream at the pixels. Explicitly asks for NO text: no current
// image model can reliably render small precise lettering, so
// drawBeachBuddyArtCard draws the real, legible headline itself
// afterward, in code, on top -- see its own comment for why that split
// is load-bearing, not optional.
//
// Rewritten after a live test came back tiny and shaded/scribbly
// instead of big and flat -- without explicit composition/texture
// constraints, the model is free to draw a small figure with fine
// shading detail, which is exactly what dithers into speckled noise at
// this display's resolution. This version repeats the composition
// ("fills most of the frame") and texture ("no shading/cross-hatching/
// gradients") constraints in more than one way, since a single mention
// of each was evidently not load-bearing enough to survive generation.
const STYLE_PREFIX =
  "A close-up, full-body portrait of a single recurring cartoon character named Buddy, filling most of the frame -- large and centered, not small or far away. Buddy is a friendly, rounded human figure with a big warm smile. Style: a simple flat black-and-white line-art icon, like a clean vector clipart sticker, a woodblock print, or a rubber-stamp illustration -- thick, bold, smooth, confident outlines, the way a children's book character or a simple logo mascot is drawn. STRICT rules, no exceptions: solid black ink outlines and solid black fills only, on a plain solid white background. No gray. No shading. No cross-hatching. No stippling. No fine sketchy texture. No gradients. No color. No photographic detail. No background scenery or clutter. No text, no lettering, no words or numbers anywhere in the image. ";

// Short present-tense action fragments describing what Buddy is doing,
// keyed by the same pose names STICK_POSES uses for the procedural
// fallback (see moodForBeachData in dynamic.js) -- so a mood picked by
// real weather/tide data drives the SAME scene idea whichever renderer
// ends up drawing it.
const IMAGEN_SCENE_HINTS = {
  umbrella: "Buddy is holding a big beach umbrella overhead for shelter, smiling contentedly in the rain",
  windy: "Buddy is leaning forward into a strong wind, bracing against it with a determined grin",
  surfing: "Buddy is crouched on a surfboard riding a cresting wave, arms out for balance, thrilled",
  lounging: "Buddy is relaxing in a beach lounge chair, arms behind head, completely at ease",
  pointing: "Buddy is standing at the shoreline pointing excitedly out at the ocean",
  standing: "Buddy is standing happily on the beach, waving"
};

function buildPrompt(mood) {
  const hint = IMAGEN_SCENE_HINTS[mood && mood.pose] || IMAGEN_SCENE_HINTS.standing;
  return STYLE_PREFIX + hint + ".";
}

// `generateImpl`, when given, replaces the real Vertex AI call --
// injected by tests so they never need real GCP credentials, same
// convention as `fetchImpl` throughout dynamic.js/astro.js. Takes just
// the prompt string and returns whatever shape the real SDK call
// returns (a GenerateContentResponse-like object), so a test double can
// be a plain object literal instead of a mocked class.
function defaultGenerateImpl(project, location) {
  const { GoogleGenAI } = require("@google/genai");
  // `enterprise: true`, not the older `vertexai: true` -- same
  // underlying REST API (Google renamed "Vertex AI" to "Gemini
  // Enterprise Agent Platform" partway through this SDK's life; both
  // flags route to the exact same endpoint and accept the same
  // project/location, but @google/genai's own type defs now say
  // `enterprise` is "recommended instead"). No apiKey: in this mode on a
  // Node runtime, the SDK uses Application Default Credentials -- the
  // Cloud Function's own service account, already used for everything
  // else here (Storage, Firestore-free as this project is). That service
  // account needs the IAM role granting `aiplatform.user` -- shown in
  // the Console as "Agent Platform User" (confirmed live, 2026; used to
  // be "Vertex AI User") -- and the API enabled on this project for
  // this to work -- see functions/README.md's "Beach Buddy" setup
  // section; neither of those can be done from code.
  const ai = new GoogleGenAI({ enterprise: true, project, location });
  return (prompt) => ai.models.generateContent({
    model: IMAGEN_MODEL,
    contents: prompt,
    config: {
      responseModalities: RESPONSE_MODALITIES,
      imageConfig: {
        aspectRatio: IMAGE_ASPECT_RATIO,
        // Buddy is drawn as a simple human-like figure (see
        // STYLE_PREFIX), so image generation needs to be allowed to
        // depict a person at all -- the model's default is stricter
        // than this feature needs. Confirmed live: this field takes
        // "ALLOW_ALL"/"ALLOW_ADULT"/"ALLOW_NONE" here (uppercase,
        // under `imageConfig`) -- a DIFFERENT shape from the
        // lowercase `"allow_adult"` the old standalone Imagen
        // `generateImages` config took at the top level, easy to get
        // wrong copying from that API's own examples.
        personGeneration: "ALLOW_ADULT"
      }
    }
  });
}

// Generates one Buddy illustration for `mood` and returns its raw image
// bytes (PNG). Throws on ANY failure -- no image, a safety-filtered
// result, a network/auth error -- callers (renderDynamicDesign in
// dynamic.js) are expected to catch this and fall back to the
// procedural stick-figure card rather than fail the whole render, since
// unlike a genuine tide-data failure, a bad art generation is exactly
// the kind of thing that should degrade gracefully, not take the board
// down for the day.
async function generateBeachBuddyArt(mood, { project, location, generateImpl } = {}) {
  const prompt = buildPrompt(mood);
  const generate = generateImpl || defaultGenerateImpl(project, location);
  const response = await generate(prompt);
  // `.data` is GenerateContentResponse's own convenience getter: the
  // concatenation of any inline-data parts in the response's first
  // candidate (a plain string property on the test doubles used here,
  // a real getter on the SDK's own class -- property access reads the
  // same either way).
  const base64 = response && response.data;
  if (!base64) {
    const candidate = response && response.candidates && response.candidates[0];
    const reason = candidate && candidate.finishReason;
    throw new Error("Gemini returned no image" + (reason ? " (finishReason: " + reason + ")" : ""));
  }
  return Buffer.from(base64, "base64");
}

module.exports = {
  IMAGEN_MODEL,
  IMAGE_ASPECT_RATIO,
  RESPONSE_MODALITIES,
  STYLE_PREFIX,
  IMAGEN_SCENE_HINTS,
  buildPrompt,
  generateBeachBuddyArt
};
