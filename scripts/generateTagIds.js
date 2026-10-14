#!/usr/bin/env node
"use strict";

// Mints a batch of short, random tag IDs for the NFC keychain flow and
// prints them as a CSV of id,url -- for writing each tag's URL with
// NFC Tools (or feeding NXP TagWriter's UID-mirror batch mode). Not a
// deployed Cloud Function, not run automatically -- a one-off local
// tool you run by hand whenever you're about to program a new batch of
// physical keychains:
//
//   node scripts/generateTagIds.js 50 > batch-2026-10-14.csv
//
// The charset and length here MUST match TAG_ID_PATTERN in
// functions/lib/tideTag.js exactly (same "no build step, keep each
// piece self-contained" duplication this whole project already uses --
// see that file's own comment) -- a mismatch would mint IDs the backend
// then refuses to register. Excludes 0/O/1/I so an ID etched small,
// printed, or read off a phone screen in bright sun can't be misread
// into a DIFFERENT valid-looking ID.
//
// IDs only need to be unique within ONE batch -- there's no need to
// check against the server's existing registrations, since an
// unregistered ID (new or old) is simply the normal, expected state for
// a tag nobody's tapped yet; a second script run drawing the same
// 32^N-sized space again is astronomically unlikely to repeat an
// already-written physical tag's ID, and even if it somehow did, the
// backend's own atomic create-only write (see saveTideTag) means
// whichever tag gets tapped FIRST simply wins that ID -- never silently
// overwrites another keychain's registration.

const crypto = require("crypto");

const CHARSET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // must match TAG_ID_PATTERN
const BASE_URL = "https://waveclock.net/t/";
const DEFAULT_LENGTH = 4;
const MIN_LENGTH = 4, MAX_LENGTH = 6; // must match TAG_ID_PATTERN's {4,6}

function parseArgs(argv) {
  const positional = [];
  let length = DEFAULT_LENGTH;
  let out = null;
  for (const arg of argv) {
    if (arg.startsWith("--length=")) {
      length = Number(arg.slice("--length=".length));
    } else if (arg.startsWith("--out=")) {
      out = arg.slice("--out=".length);
    } else {
      positional.push(arg);
    }
  }
  const count = Number(positional[0]);
  return { count, length, out };
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
  // The charset/length space (32^4 = 1,048,576 at the default length) is
  // large enough that a collision is rare even for a big batch -- this
  // just regenerates on the rare hit rather than ever emitting a
  // duplicate within the same CSV.
  while (ids.size < count) {
    ids.add(randomTagId(length));
  }
  return Array.from(ids);
}

function main() {
  const { count, length, out } = parseArgs(process.argv.slice(2));

  if (!Number.isInteger(count) || count < 1) {
    process.stderr.write("Usage: node generateTagIds.js <count> [--length=4] [--out=file.csv]\n");
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
}

if (require.main === module) {
  main();
}

module.exports = { CHARSET, randomTagId, generateBatch };
