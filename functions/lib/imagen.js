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
// "3:2", "3:4", "4:3", "9:16", "16:9", "21:9") via `imageConfig`, none
// exactly matching the art area's own 792x224 (~3.5:1) -- the card below
// the banner (see BANNER_HEIGHT in dynamic.js). "21:9" (~2.33:1) is the
// closest available and the widest one offered, so it's the pick: a
// wide scene needs the LEAST cropping from ditheredArtCoverCanvas's
// cover-fit (which crops whatever overflows, never stretches) to fill
// the full-bleed art panel edge to edge. A live test of the earlier
// "1:1" version, composed and placed as a small centered panel, came
// back reading as a stamp-sized afterthought, not a real screen -- see
// drawBeachBuddyArtCard's own comment for the layout half of that fix.
const IMAGE_ASPECT_RATIO = "21:9";

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
// Rewritten AGAIN after a live test came back correctly posed and flat
// (the shading/scale fix below worked) but still only a small figure
// adrift in a wide "21:9" frame with empty white space on both sides --
// the composition wording still described a square close-up portrait,
// not the wide scene this aspect ratio actually asks for. This version
// asks for a full horizontal SCENE (Buddy plus simple beach setting)
// that reaches BOTH edges of the wide frame, rather than one centered
// figure surrounded by white -- ditheredArtCoverCanvas (dynamic.js)
// crops a wide source to fill the full-bleed art panel edge to edge, so
// empty margin here becomes empty margin on the actual screen.
//
// (Earlier still: a first live test came back tiny and shaded/scribbly
// instead of big and flat -- without explicit composition/texture
// constraints, the model is free to draw a small figure with fine
// shading detail, which is exactly what dithers into speckled noise at
// this display's resolution. This version keeps repeating the texture
// ("no shading/cross-hatching/gradients") constraint in more than one
// way, since a single mention was evidently not load-bearing enough to
// survive generation.)
//
// Rewritten a third time against a real reference image the user liked
// (a surfing Buddy in a bucket hat and sunglasses, bold outline on the
// figure but fine detailed curved linework inside the wave itself) --
// the earlier "no cross-hatching/no fine sketchy texture" wording banned
// exactly that wave texture along with the shading it was actually meant
// to prevent. The distinction that matters isn't "simple lines only" --
// it's real black linework (any thickness) vs. GRAY (halftone dots,
// smudged gradients, actual shading trying to fake a gray value), since
// only the latter dithers into noise. This version explicitly invites
// fine contrasting linework for texture (waves, hair, fabric) while
// still banning gray/gradients/halftone. Also gives Buddy one fixed
// signature outfit (bucket hat + round sunglasses) so the character
// reads as recognizably the same Buddy across different scenes and
// poses, which the model has no other memory of between calls.
//
// Rewritten a fourth time after a live "lounging" render came back as a
// chubby rounded mascot/bear-shaped character, not a stick figure --
// "a friendly, rounded human figure" was exactly specific enough to
// steer the model there. This whole feature has been a STICK FIGURE
// from its very first reference image onward (thin single-line limbs
// and torso, a simple circle head) -- that's Buddy's actual identity,
// not an incidental style choice, so this spells it out explicitly and
// says directly what to avoid (a rounded/chubby mascot body).
//
// Rewritten a fifth time comparing two live renders side by side: a
// surfing scene the user liked (bold, mostly-flat linework, only the
// wave itself carrying fine texture) against a lounging scene they
// didn't (heavy cross-hatching all over the umbrella/sand/chair, and
// Buddy's own body reading with real thickness/shading again instead
// of a clean stick figure) -- the earlier "fine contrasting linework
// for waves, water, sand" invited exactly that over-application. This
// version confines dense fine linework to wave crests specifically
// (sparingly, a few curling lines, not a fully hatched surface) and
// tells the model everything else in the scene should be bold, mostly
// flat outlines -- plus a stronger, more literal restatement of
// Buddy's stick-figure body (uniform thin line weight, no shape or
// volume at all, like a quick hand-drawn doodle).
//
// Rewritten a sixth time: the surfing (standing) pose reliably comes
// back as a clean stick figure, but the lounging (seated/reclining)
// pose keeps coming back with a filled, shirt-like torso shape again --
// a real live comparison confirmed the standing pose works while the
// same prompt's seated pose doesn't, so the model reads "reclining in
// a chair" as needing a real body shape to sit in it, previous
// "no shape/volume/shading" wording notwithstanding. This version spells
// out the actual stick-figure GEOMETRY literally (torso = one line from
// neck to hips, each limb = one line from joint to joint, small dots
// for joints, no wider shape connecting them) and explicitly says this
// holds in EVERY pose, seated or reclining included, plus explicitly
// forbids drawing any clothing on the body itself (shirt, vest, or
// otherwise) beyond the hat and sunglasses already on Jake's head.
//
// Renamed from "Buddy" to "Jake" at the user's request (Jake being a
// stick figure is still the load-bearing part -- see the STICK FIGURE
// wording above -- "Jake" is just his name now, same as "Buddy" was).
// This only renames the CHARACTER as it's sent to Gemini in the prompt
// text below -- the feature/product name "Beach Buddy" (the toolbar
// button, panel, layer kind "beachBuddy", function names throughout
// dynamic.js/index.html/design/index.html) is intentionally left alone,
// since renaming those would touch persisted dynamic.json data on real
// devices for no benefit; "Beach Buddy" is the tool's name, not the
// character's.
const STYLE_PREFIX =
  "A wide horizontal beach-scene illustration starring a single recurring stick-figure cartoon character named Jake, drawn large enough that the scene reaches both the left and right edges of the frame -- NOT a small centered figure floating in empty white space. Jake is a classic minimalist STICK FIGURE, drawn exactly like a quick hand-drawn doodle, in EVERY pose including seated or reclining ones: a simple circle for a head, one single thin line from the neck straight down to the hips for the torso, and each arm and leg is its own single thin line from one joint to the next (small dots at the joints/hands/feet are fine) -- there is no wider shape connecting these lines, no filled torso, no shirt, vest, or any clothing at all on the body itself (only the hat and sunglasses on the head). NOT a rounded, chubby, or bear-like mascot body, NOT a filled-in human silhouette, NOT a body shape sitting in a chair -- even when reclining, Jake is still just thin stick-figure lines bent at the joints. Jake wears a floppy bucket hat and round sunglasses on that circle head -- this exact outfit every time, it's what makes Jake recognizable as the same character scene to scene. Style: bold black ink line art, like a woodblock print or comic-strip panel, with thick, confident outlines throughout the whole scene -- clean and bold, not busy or fine. Cross-hatching and fine detail linework are used SPARINGLY and ONLY inside a wave's crest, as a handful of curling lines suggesting motion -- never densely covering an entire surface, and never on the sand, umbrella, chair, or any other prop, which stay simple bold outlines with flat solid black fills. STRICT rules, no exceptions: every mark is a real solid black line or solid black fill on a plain solid white background -- NO gray, NO gradients, and NO halftone dot/stipple shading used to fake a gray value. No color. No photographic detail. No text, no lettering, no words or numbers anywhere in the image. ";

// Short present-tense action fragments describing what Jake is doing,
// keyed by the same pose names STICK_POSES uses for the procedural
// fallback (see moodForBeachData in dynamic.js) -- so a mood picked by
// real weather/tide data drives the SAME scene idea whichever renderer
// ends up drawing it.
const IMAGEN_SCENE_HINTS = {
  umbrella: "Jake is holding a big beach umbrella overhead for shelter, smiling contentedly in the rain",
  windy: "Jake is leaning forward into a strong wind, bracing against it with a determined grin",
  // Rewritten against the reference image (see STYLE_PREFIX's comment):
  // explicitly calls out the cresting wave's own fine curved texture
  // lines, since that's the detail the earlier wording accidentally
  // banned.
  surfing: "Jake is crouched on a surfboard riding a cresting wave, the wave rendered with fine curved texture lines for motion and detail, arms out for balance, thrilled",
  // Rewritten again after a live call for this exact pose came back
  // safety-filtered (finishReason: IMAGE_SAFETY) -- the earlier wording
  // asked for "a small child... playing" in the same scene as Jake,
  // which directly conflicts with defaultGenerateImpl's own
  // `personGeneration: "ALLOW_ADULT"` (deliberately excludes minors);
  // asking for a child while telling the model not to generate one is
  // exactly the kind of prompt that gets blocked outright rather than
  // silently ignored. This version keeps the same "someone's been
  // playing here" feeling (from a second reference scene the user
  // liked: beach chair, umbrella, a kid in the sand) without depicting
  // a person to do it -- a built sandcastle with a toy pail and shovel
  // reads as evidence of play on its own. This pose already covers low
  // tide, a calm default day, AND stargazing at night (see
  // moodForBeachData), so it stays general enough to read fine as a
  // relaxed daytime OR evening beach scene.
  lounging: "Jake is relaxing in a low beach lounge chair, shaded by a large beach umbrella, completely at ease, with a freshly-built sandcastle and a toy pail and shovel sitting in the sand nearby",
  pointing: "Jake is standing at the shoreline pointing excitedly out at the ocean",
  standing: "Jake is standing happily on the beach, waving"
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
        aspectRatio: IMAGE_ASPECT_RATIO
        // personGeneration: "ALLOW_ADULT" was here (explicitly allowing
        // generation of adult-looking people, since Buddy is a
        // human-like figure) -- removed at the user's request. If
        // real calls start coming back safety-filtered again with no
        // obvious prompt-content cause (see the `lounging`/IMAGE_SAFETY
        // incident this was originally added to guard against, and to
        // fix), that field defaulting to something stricter than this
        // feature needs is the first thing to check.
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
