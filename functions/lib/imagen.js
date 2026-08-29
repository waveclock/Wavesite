// Imagen (via Firebase AI Logic / Vertex AI) art generation for the
// "Beach Buddy" dynamic layer -- kept in its own file, separate from
// dynamic.js's pure rendering/packing logic, the same way astro.js and
// teamsnap.js are their own modules: this is the one piece of the Beach
// Buddy feature that makes a real network call and needs real GCP
// credentials, so it needs to be easy to mock out in tests without
// pulling the Vertex AI SDK into every test file.
"use strict";

// Confirmed against @google/genai's own published usage example
// (its README/type defs, as of the version pinned in package.json) --
// NOT confirmed against a live Vertex AI response from this project,
// since that needs real GCP credentials this development sandbox
// doesn't have. Same "needs a live smoke test after deploy" caveat as
// NOAA/ESPN/RSS elsewhere in this codebase (see functions/README.md).
// Google renames/deprecates Imagen model versions periodically -- if
// this ever 404s, check Vertex AI's current model list for this project.
const IMAGEN_MODEL = "imagen-4.0-generate-001";

// Imagen only supports a fixed set of aspect ratios ("1:1", "3:4", "4:3",
// "9:16", "16:9") -- none of them are anywhere close to this display's
// own 792x272 (~2.9:1) strip. Rather than stretch/crop a generated image
// to an unnatural ratio, this asks for a normal-looking "1:1" portrait
// illustration and lets drawBeachBuddyArtCard (in dynamic.js) place it
// as a modest centered panel below the headline, with clean white margin
// on either side -- closer to how Life is Good's own designs actually
// compose a small character illustration with text, not an edge-to-edge
// background fill.
const IMAGE_ASPECT_RATIO = "1:1";

// One fixed style prefix, unchanged across every single call -- the ONE
// thing that keeps "Buddy" reading as the same recurring character day
// to day instead of a new random illustration each time (Imagen has no
// built-in "same character as yesterday" memory). Flat 2-color linework
// (no gradients/shading, which a 1-bit luminance threshold would mangle
// into noise) mirrors the same reasoning the design tool's own dithered-
// logo handling already uses for photographic assets, just aimed
// upstream at the prompt instead of downstream at the pixels. Explicitly
// asks for NO text: Imagen (like every current image model) can't
// reliably render small precise lettering, so drawBeachBuddyArtCard
// draws the real, legible headline itself afterward, in code, on top --
// see its own comment for why that split is load-bearing, not optional.
const STYLE_PREFIX =
  "A single warm, cheerful, minimalist line-art illustration of a recurring beach-themed cartoon character named Buddy -- a simple, friendly, rounded human figure with a big warm smile, drawn in bold confident black ink linework on a plain solid white background. Flat two-color only: pure black and white, no gray, no gradients, no shading, no color, no background scenery clutter, no text, no lettering, no words or numbers anywhere in the image. Clean, uncluttered, joyful, in the spirit of simple hand-drawn beach-lifestyle character art. ";

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
// returns (a GenerateImagesResponse-like object), so a test double can
// be a plain object literal instead of a mocked class.
function defaultGenerateImpl(project, location) {
  const { GoogleGenAI } = require("@google/genai");
  // No apiKey: in `vertexai: true` mode on a Node runtime, the SDK uses
  // Application Default Credentials -- the Cloud Function's own service
  // account, already used for everything else here (Storage, Firestore-
  // free as this project is). That service account needs the "Vertex AI
  // User" IAM role and the Vertex AI API enabled on this project for
  // this to work -- see functions/README.md's "Beach Buddy" setup
  // section; neither of those can be done from code.
  const ai = new GoogleGenAI({ vertexai: true, project, location });
  return (prompt) => ai.models.generateImages({
    model: IMAGEN_MODEL,
    prompt,
    config: {
      numberOfImages: 1,
      aspectRatio: IMAGE_ASPECT_RATIO,
      outputMimeType: "image/png",
      // Buddy is drawn as a simple human-like figure (see STYLE_PREFIX),
      // so image generation needs to be allowed to depict a person at
      // all -- Imagen's default is stricter than this feature needs.
      personGeneration: "allow_adult"
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
  const generated = response && response.generatedImages && response.generatedImages[0];
  const imageBytes = generated && generated.image && generated.image.imageBytes;
  if (!imageBytes) {
    const reason = generated && generated.raiFilteredReason;
    throw new Error("Imagen returned no image" + (reason ? " (" + reason + ")" : ""));
  }
  return Buffer.from(imageBytes, "base64");
}

module.exports = {
  IMAGEN_MODEL,
  IMAGE_ASPECT_RATIO,
  STYLE_PREFIX,
  IMAGEN_SCENE_HINTS,
  buildPrompt,
  generateBeachBuddyArt
};
