// Stage 2 of the pipeline: hand the messy, regex-extracted events to
// Claude to clean up titles and pick the most interesting ones per day.
//
// This runs on a scheduled Cloud Function, calling the Anthropic API
// directly with a fixed prompt and a fixed output contract -- an
// automatable step, not a chat session asking Claude to "go check a
// website". Ported from the customer-provided curate_with_llm.py (2 Sep
// 2026 handoff); the model id in that script (claude-sonnet-4-6) doesn't
// match any currently available Claude model, so this uses the current
// Sonnet instead.
"use strict";

const MAX_PER_DAY = 6;
const CURATION_MODEL = "claude-sonnet-5";

const SYSTEM_PROMPT = `You clean and curate event listings for a small e-paper desk clock display in Ocean City, NJ. The display can show at most 6 events per day, each as a short title, a time, and a location.

The input has already been merged and deduped across two sources (a town PDF and the Chamber of Commerce's calendar feed) -- you will NOT see the same real-world event twice. Some entries have clean, pre-extracted "time" and "location" fields already (trust these as-is); others only have a "title" and free-text "description" where a time/location may be embedded in the prose (extract it from there instead). A "seenInSources" field with more than one source is a signal the event is well-confirmed, not something to display -- ignore that field except as a tie-breaker when choosing among close calls for the 6-per-day cap.

For each date in the input:
1. Produce a clean, accurate title (<=32 characters if possible, never invented -- if a title looks cut off or fragment-like, reconstruct it from the description).
2. Use the given "time" field if present; otherwise extract a start time from the description, else null.
3. Use the given "location" field if present; otherwise extract one from the description, else null.
4. Drop pure noise (page numbers, headers like "Calendar of Events", the "Updated:" footer line).
5. If a date has more than 6 events, keep the 6 most interesting to a mix of visitors and locals -- favor one-time/unique events (concerts, festivals, fireworks, parades) over routine recurring ones (weekly farmers markets, standing exercise classes) unless nothing else exists that day.

Return ONLY valid JSON, no commentary, no markdown fences, in this exact shape:
{"days": [{"date": "YYYY-MM-DD", "events": [{"title": "...", "time": "..." or null, "location": "..." or null}]}]}`;

// `callImpl`, when given, replaces the real Anthropic API call -- injected
// by tests so they never need a real API key, same convention as
// imagen.js's `generateImpl`. Takes the request body and returns whatever
// shape the real SDK call returns (a Message-like object with
// `.content[0].text`), so a test double can be a plain object literal
// instead of a mocked class.
function defaultCallImpl(apiKey) {
  const { Anthropic } = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });
  return (body) => client.messages.create(body);
}

// mergedEvents: mergeSources()'s output list. apiKey is passed explicitly
// (rather than read from process.env in here) so the Cloud Function's
// Secret Manager-bound value flows straight through without this module
// needing to know where it came from.
async function curate(mergedEvents, apiKey, callImpl) {
  const call = callImpl || defaultCallImpl(apiKey);

  const response = await call({
    model: CURATION_MODEL,
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: JSON.stringify(mergedEvents) }]
  });

  let text = response.content[0].text.trim();
  // Defensive: strip accidental code fences even though the prompt forbids them.
  if (text.startsWith("```json")) text = text.slice(7);
  else if (text.startsWith("```")) text = text.slice(3);
  if (text.endsWith("```")) text = text.slice(0, -3);
  text = text.trim();

  try {
    const parsed = JSON.parse(text);
    for (const day of parsed.days || []) {
      day.events = (day.events || []).slice(0, MAX_PER_DAY);
    }
    return parsed;
  } catch (e) {
    // Never let a malformed LLM response reach the device -- caller
    // catches this and falls back to yesterday's cached JSON.
    throw new Error("LLM did not return valid JSON: " + e.message + "\nRaw: " + text.slice(0, 500));
  }
}

module.exports = { curate, MAX_PER_DAY, CURATION_MODEL, SYSTEM_PROMPT };
