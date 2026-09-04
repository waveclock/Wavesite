// Full pipeline: fetch both Ocean City, NJ event sources, merge/dedup them,
// curate with Claude, and publish the result to Cloud Storage as the JSON
// file WaveClock's "Local Info" custom screens poll.
//
// Ported from the customer-provided run_pipeline.py (2 Sep 2026 handoff),
// adapted to run inside a Cloud Function instead of a standalone cron job:
//   - Output/cache files become Storage objects (data/ocnj-events.json,
//     data/ocnj-events-cache.json) instead of local disk -- Cloud
//     Functions don't persist local files between invocations.
//   - The original's own pipeline_log.json is dropped in favor of this
//     repo's existing Cloud Logging convention (logger.info/warn/error,
//     same as every other lib/*.js source in this codebase) -- Cloud
//     Functions already gives every run's logs a searchable home, so a
//     second hand-rolled log file would just be a second thing to fetch.
//
// TWO SOURCES, MERGED:
//   - ocnj.us's annual PDF        (ocnjCalendar.js)
//   - oceancityvacation.com's ICS (ocnjIcs.js)
// merged and deduped by ocnjMerge.js before curation. The two source
// fetches are wrapped independently -- if one source is down or its layout
// changed, the pipeline still runs on whichever source succeeded, rather
// than an all-or-nothing failure. Total silence from BOTH sources (or a
// suspiciously small merged result) is what triggers the cache fallback.
"use strict";

const logger = require("firebase-functions/logger");
const { parseCalendar } = require("./ocnjCalendar");
const { fetchRange } = require("./ocnjIcs");
const { mergeSources } = require("./ocnjMerge");
const { curate } = require("./ocnjCurate");

const ICS_WEEKS_AHEAD = 4; // how far out to pull from the Chamber's weekly ICS feed
const OUTPUT_PATH = "data/ocnj-events.json";
const CACHE_PATH = "data/ocnj-events-cache.json";

// Minimum *merged* events expected if both sources are working. Landing
// below this means assume something broke rather than trusting a
// suspiciously-empty result -- see failWithFallback().
const MIN_EXPECTED_EVENTS = 15;

function pdfSourceUrl(year) {
  return "https://www.ocnj.us/media/Events/" + year + "CalendarOfEvents.pdf";
}

// Swap-in point for the raw PDF -> text extraction step. Uses pdf-parse
// (a pure-JS wrapper around pdfjs-dist) rather than shelling out to a
// native tool, since this runs inside a Cloud Function.
async function fetchPdfText(url, fetchImpl) {
  const pdfParse = require("pdf-parse");
  const doFetch = fetchImpl || fetch;
  const resp = await doFetch(url);
  if (!resp.ok) throw new Error("PDF fetch failed: " + resp.status);
  const arrayBuffer = await resp.arrayBuffer();
  const { text } = await pdfParse(Buffer.from(arrayBuffer));
  return text;
}

async function loadJsonFile(file) {
  try {
    const [buf] = await file.download();
    return JSON.parse(buf.toString("utf8"));
  } catch (err) {
    if (err && err.code === 404) return null;
    throw err;
  }
}

async function saveJsonFile(file, data) {
  await file.save(JSON.stringify(data, null, 2), { contentType: "application/json" });
}

// bucket: an @google-cloud/storage Bucket (admin.storage().bucket() in
// real runs; a fake with the same file()/download()/save() surface in
// tests). fetchImpl/apiKey are threaded through the same way the rest of
// this codebase does for stubbing network calls in tests.
// fetchPdfTextImpl/curateCallImpl, when given, replace the real PDF
// extraction and Anthropic API calls respectively -- same injectable-impl
// convention as imagen.js's generateImpl, since neither pdf-parse's binary
// decode nor a real LLM call is something a unit test should depend on.
async function runOcnjEventsPipeline({ bucket, fetchImpl, apiKey, now, fetchPdfTextImpl, curateCallImpl }) {
  const outputFile = bucket.file(OUTPUT_PATH);
  const cacheFile = bucket.file(CACHE_PATH);
  const year = (now || new Date()).getFullYear();
  const pdfUrl = pdfSourceUrl(year);

  let pdfEvents = [];
  let icsEvents = [];
  const sourceNotes = [];
  let sourceLastUpdated = null;

  // --- Source 1: town PDF ---
  try {
    const rawText = fetchPdfTextImpl ? await fetchPdfTextImpl(pdfUrl) : await fetchPdfText(pdfUrl, fetchImpl);
    const parsedPdf = parseCalendar(rawText, year);
    pdfEvents = parsedPdf.singleDateEvents;
    sourceLastUpdated = parsedPdf.sourceLastUpdated;
    sourceNotes.push("ocnj.us: " + pdfEvents.length + " events");
  } catch (err) {
    sourceNotes.push("ocnj.us: FAILED (" + err.message + ")");
  }

  // --- Source 2: Chamber ICS feed ---
  try {
    const icsResult = await fetchRange(now || new Date(), ICS_WEEKS_AHEAD, fetchImpl);
    icsEvents = icsResult.events;
    sourceNotes.push("oceancityvacation.com: " + icsEvents.length + " events");
    if (icsResult.errors.length) {
      sourceNotes.push("oceancityvacation.com partial errors: " + JSON.stringify(icsResult.errors));
    }
  } catch (err) {
    sourceNotes.push("oceancityvacation.com: FAILED (" + err.message + ")");
  }

  const merged = mergeSources(pdfEvents, icsEvents);

  // Both sources failing (or both returning near-nothing) is the real
  // failure condition -- one source having a bad day is tolerated above.
  if (merged.length < MIN_EXPECTED_EVENTS) {
    return failWithFallback(
      "only " + merged.length + " merged events found (expected >= " + MIN_EXPECTED_EVENTS + "). " +
        "Source status: " + sourceNotes.join("; "),
      cacheFile,
      outputFile
    );
  }

  let curated;
  try {
    curated = await curate(merged, apiKey, curateCallImpl);
  } catch (err) {
    return failWithFallback("LLM curation failed: " + err.message, cacheFile, outputFile);
  }

  const output = {
    generated_at: new Date().toISOString(),
    sources: [pdfUrl, "oceancityvacation.com (weekly ICS)"],
    source_last_updated: sourceLastUpdated,
    merged_event_count: merged.length,
    days: curated.days
  };

  await saveJsonFile(outputFile, output);
  await saveJsonFile(cacheFile, output); // this run becomes tomorrow's fallback

  logger.info("ocnj-events: " + sourceNotes.join("; ") + "; " + merged.length + " merged, curated");
  return { status: "ok", output };
}

async function failWithFallback(reason, cacheFile, outputFile) {
  const cache = await loadJsonFile(cacheFile);
  if (cache) {
    await saveJsonFile(outputFile, cache);
    logger.warn("ocnj-events: " + reason + ". Served cached data from " + cache.generated_at + ".");
    return { status: "fallback", reason, output: cache };
  }
  logger.error("ocnj-events: " + reason + ". No cache available -- device will see no events today.");
  return { status: "error", reason };
}

module.exports = {
  runOcnjEventsPipeline,
  pdfSourceUrl,
  fetchPdfText,
  OUTPUT_PATH,
  CACHE_PATH,
  MIN_EXPECTED_EVENTS,
  ICS_WEEKS_AHEAD
};
