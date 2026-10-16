#!/usr/bin/env node
"use strict";

// Mints a batch of random tag IDs for the NFC keychain flow and prints
// them as a CSV of id,url -- for writing each tag's URL with NFC Tools
// (or feeding NXP TagWriter's UID-mirror batch mode). Not a deployed
// Cloud Function itself, not run automatically -- a one-off local tool
// you run by hand whenever you're about to program a new batch of
// physical keychains:
//
//   WAVECLOCK_MINT_SECRET=... node scripts/generateTagIds.js 50 > batch-2026-10-14.csv
//
// The charset and length here MUST match TAG_ID_PATTERN in
// functions/lib/tideTag.js exactly (same "no build step, keep each
// piece self-contained" duplication this whole project already uses --
// see that file's own comment) -- a mismatch would mint IDs the backend
// then refuses to register. Excludes 0/O/1/I so an ID etched small,
// printed, or read off a phone screen in bright sun can't be misread
// into a DIFFERENT valid-looking ID -- kept even though nothing here
// gets printed or hand-typed anymore, since it's still harmless and
// still helps if an ID is ever read aloud for support.
//
// Default length is 20, not a short, memorable 4-6 -- these IDs only
// ever live inside an NFC tag's own NDEF record (plenty of room: see
// functions/README.md's own numbers), never printed or typed by a
// person, so there's no reason to keep them short. Long IDs are what
// make guessing -- or sweeping the ENTIRE id space against the open GET
// endpoint to discover which ones are real, live customer tags --
// computationally infeasible (32^20 vs. 32^4's ~1 million).
//
// Length alone doesn't stop someone from simply inventing their OWN
// new ID and registering it for free, though -- nothing about a random
// string is harder to invent than to guess. THAT's what the registration
// call below actually closes: every ID generated here gets POSTed to
// the live mintTideTagBatch endpoint (see functions/index.js), which
// marks it as real/issued -- the registration backend's own POST/PUT
// now refuse any tagId that was never minted this way, no matter how
// well-formed. Skippable with --no-register for a dry run (e.g. testing
// the CSV output itself) -- those IDs simply won't work on a real tag
// until a later run mints them for real.
//
// IDs only need to be unique within ONE batch -- there's no need to
// check against the server's existing registrations, since an
// unregistered ID (new or old) is simply the normal, expected state for
// a tag nobody's tapped yet; a second script run drawing the same
// 32^N-sized space again is astronomically unlikely to repeat an
// already-written physical tag's ID, and even if it somehow did, the
// backend's own atomic create-only write (see saveTideTag) means
// whichever tag gets tapped FIRST simply wins that ID -- never silently
// overwrites another keychain's registration. mintTagIds (see
// lib/tideTag.js) is separately idempotent for the same reason, so
// re-running registration against an already-minted batch is harmless.

const crypto = require("crypto");

const CHARSET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // must match TAG_ID_PATTERN
const BASE_URL = "https://waveclock.net/t/";
const MINT_ENDPOINT = "https://us-central1-waveclock.cloudfunctions.net/mintTideTagBatch";
const DEFAULT_LENGTH = 20;
const MIN_LENGTH = 16, MAX_LENGTH = 32; // must match TAG_ID_PATTERN's {16,32}

function parseArgs(argv) {
  const positional = [];
  let length = DEFAULT_LENGTH;
  let out = null;
  let register = true;
  for (const arg of argv) {
    if (arg.startsWith("--length=")) {
      length = Number(arg.slice("--length=".length));
    } else if (arg.startsWith("--out=")) {
      out = arg.slice("--out=".length);
    } else if (arg === "--no-register") {
      register = false;
    } else {
      positional.push(arg);
    }
  }
  const count = Number(positional[0]);
  return { count, length, out, register };
}

// Marks this batch as real/issued so the live registration endpoint will
// actually accept these IDs (see this file's own top comment for why).
// Failure here doesn't throw/exit non-zero -- the CSV this script's
// whole JOB is to produce has already been written by the time this
// runs, and a batch minted later (once the secret's sorted out, or
// network's back) is exactly as valid as one minted immediately; there's
// no reason to make that block getting usable tag URLs out today.
async function registerBatch(ids, secret) {
  const res = await fetch(MINT_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mint-secret": secret },
    body: JSON.stringify({ ids })
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error("mintTideTagBatch returned " + res.status + ": " + (body && body.error || "unknown error"));
  }
  return body;
}

function randomTagId(length) {
  let id = "";
  for (let i = 0; i < length; i++) {
    id += CHARSET[crypto.randomInt(CHARSET.length)];
  }
  return id;
}

function generateBatch(count, length) {
  const ids = new Set();
  // The charset/length space (32^20 at the default length -- astronomically
  // larger than any batch this would ever generate) is large enough that
  // a collision is rare even for a huge batch -- this just regenerates
  // on the rare hit rather than ever emitting a duplicate within the
  // same CSV.
  while (ids.size < count) {
    ids.add(randomTagId(length));
  }
  return Array.from(ids);
}

async function main() {
  const { count, length, out, register } = parseArgs(process.argv.slice(2));

  if (!Number.isInteger(count) || count < 1) {
    process.stderr.write("Usage: WAVECLOCK_MINT_SECRET=... node generateTagIds.js <count> [--length=20] [--out=file.csv] [--no-register]\n");
    process.exit(1);
  }
  if (!Number.isInteger(length) || length < MIN_LENGTH || length > MAX_LENGTH) {
    process.stderr.write("--length must be an integer between " + MIN_LENGTH + " and " + MAX_LENGTH + "\n");
    process.exit(1);
  }

  const ids = generateBatch(count, length);
  const lines = ["id,url", ...ids.map((id) => id + "," + BASE_URL + id)];
  const csv = lines.join("\n") + "\n";

  if (out) {
    require("fs").writeFileSync(out, csv);
    process.stderr.write("Wrote " + ids.length + " tag IDs to " + out + "\n");
  } else {
    process.stdout.write(csv);
  }

  if (!register) {
    process.stderr.write("--no-register: skipped minting -- these IDs won't work on a real tag until a later run registers them.\n");
    return;
  }
  const secret = process.env.WAVECLOCK_MINT_SECRET;
  if (!secret) {
    process.stderr.write("WAVECLOCK_MINT_SECRET isn't set -- skipped minting. These IDs won't work on a real tag until you re-run with it set (or pass --no-register to silence this).\n");
    return;
  }
  try {
    const result = await registerBatch(ids, secret);
    process.stderr.write("Minted " + result.minted + " new tag ID(s)" + (result.alreadyMinted ? " (" + result.alreadyMinted + " already minted)" : "") + " -- ready to write to real tags.\n");
  } catch (err) {
    process.stderr.write("Minting failed: " + err.message + "\n  The CSV above is still valid, but these IDs won't work on a real tag until minting succeeds -- fix the issue and re-run (safe to repeat; minting is idempotent).\n");
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { CHARSET, randomTagId, generateBatch, registerBatch };
