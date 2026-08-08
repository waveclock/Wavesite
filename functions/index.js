const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const logger = require("firebase-functions/logger");

initializeApp();
const db = getFirestore();

const FAL_KEY = defineSecret("FAL_KEY");

// Synchronous fal.ai endpoint -- schnell is fast enough that we don't need
// the async queue/webhook flow fal.ai uses for slower models.
const FAL_ENDPOINT = "https://fal.run/fal-ai/flux/schnell";

const STYLE_SUFFIX =
  "black and white line art, clean bold outlines, high contrast, " +
  "white background, minimalist ink drawing, coloring book style";

const MAX_PROMPT_LENGTH = 300;
const IMAGES_PER_GENERATION = 4;

// A device's design "session" doesn't really reset -- it's the whole
// lifetime of that link -- so this is a lifetime cap per device, not a
// daily one. IP is a secondary, daily-resetting backstop against someone
// cycling through fake ?id= values to bypass the per-device cap.
const DEVICE_LIFETIME_CAP = 8;
const IP_DAILY_CAP = 20;

// Deliberately basic, as scoped: a substring blocklist against a
// lowercased, accent-stripped prompt. This is the first of two layers --
// enable_safety_checker below is the second, screening the actual
// generated output on fal.ai's side regardless of how the prompt was
// phrased.
const BLOCKED_TERMS = [
  "nude", "naked", "nsfw", "porn", "pornographic", "sex", "sexual", "explicit",
  "genital", "penis", "vagina", "breast", "fetish", "erotic",
  "nigger", "nigga", "faggot", "retard", "kike", "chink", "spic", "tranny",
  "nazi", "hitler", "kill yourself", "kys",
  "gore", "gory", "decapitat", "mutilat", "corpse", "suicide", "self harm", "self-harm",
  "child porn", "loli", "underage", "minor sex",
];

function normalize(text) {
  return text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function isBlocked(prompt) {
  const normalized = normalize(prompt);
  return BLOCKED_TERMS.some((term) => normalized.includes(term));
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

// Runs inside a transaction so concurrent requests from the same
// device/IP can't race past the cap. resetDaily=true rolls the counter
// over at UTC midnight; false makes it a lifetime cap.
async function checkAndIncrement(docId, cap, resetDaily) {
  const ref = db.collection("aiGenerationLimits").doc(docId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : null;
    const today = todayKey();

    let count = 0;
    if (data) {
      count = (resetDaily && data.date !== today) ? 0 : (data.count || 0);
    }

    if (count >= cap) {
      return false;
    }

    tx.set(ref, { count: count + 1, date: today, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return true;
  });
}

exports.generateDesignImages = onCall(
  { secrets: [FAL_KEY], cors: true },
  async (request) => {
    const prompt = ((request.data && request.data.prompt) || "").trim();
    const deviceId = ((request.data && request.data.deviceId) || "").trim();
    // Cloud Functions/Cloud Run sits behind Google's load balancer, which
    // populates this correctly for the real client IP -- verify after
    // deploy if IP-based limiting looks off.
    const ip = (request.rawRequest && request.rawRequest.ip) || "unknown";

    if (!prompt) {
      throw new HttpsError("invalid-argument", "Enter a prompt first.");
    }
    if (prompt.length > MAX_PROMPT_LENGTH) {
      throw new HttpsError("invalid-argument", "Prompt's too long -- keep it under " + MAX_PROMPT_LENGTH + " characters.");
    }
    if (!deviceId) {
      throw new HttpsError("failed-precondition", "No device ID found in link.");
    }
    if (isBlocked(prompt)) {
      throw new HttpsError("invalid-argument", "That prompt isn't allowed -- try describing something else.");
    }

    const deviceOk = await checkAndIncrement("device_" + deviceId, DEVICE_LIFETIME_CAP, false);
    if (!deviceOk) {
      throw new HttpsError("resource-exhausted", "This Wave Clock has used up its AI generations.");
    }
    const ipOk = await checkAndIncrement("ip_" + ip, IP_DAILY_CAP, true);
    if (!ipOk) {
      throw new HttpsError("resource-exhausted", "Too many generations from this connection today -- try again tomorrow.");
    }

    const wrappedPrompt = prompt + ", " + STYLE_SUFFIX;

    let response;
    try {
      response = await fetch(FAL_ENDPOINT, {
        method: "POST",
        headers: {
          "Authorization": "Key " + FAL_KEY.value(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: wrappedPrompt,
          // Close to the design panel's 792:272 (~2.91:1) ratio; the
          // frontend still does an exact cover-crop to 792x272 on
          // whatever comes back, so this just minimizes wasted crop.
          image_size: { width: 1024, height: 352 },
          num_images: IMAGES_PER_GENERATION,
          enable_safety_checker: true,
        }),
      });
    } catch (err) {
      logger.error("fal.ai request failed", err);
      throw new HttpsError("unavailable", "Couldn't reach the image generator -- try again in a moment.");
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      logger.error("fal.ai returned an error", response.status, body);
      throw new HttpsError("internal", "Image generation failed -- try again in a moment.");
    }

    const result = await response.json();
    const images = (result.images || []).map((img) => img.url).filter(Boolean);

    if (!images.length) {
      throw new HttpsError("internal", "No images came back -- try a different prompt.");
    }

    return { images };
  }
);
