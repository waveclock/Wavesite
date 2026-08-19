// Pure rendering/packing logic for the daily "dynamic layer" regeneration
// job -- kept dependency-free (besides `canvas`) and separate from
// index.js so it can be unit-tested without a live Firebase project (see
// test/). Covers both dynamic-layer types published from design-v2:
// "countdown" (a target date) and "team" (a sports team's next game).
//
// IMPORTANT: daysUntil(), formatCountdownText(), and formatTeamText() are
// deliberately duplicated (not shared via a build step) in
// design-v2/index.html, which is the browser-side code that first
// renders/previews this same text at publish time. If any of these change
// here, they must change there too, or what a customer previewed at
// publish time won't match what the board shows once this job redraws it.
"use strict";

const { createCanvas, loadImage, registerFont } = require("canvas");
const path = require("path");

const CANVAS_WIDTH = 792;
const CANVAS_HEIGHT = 272;
const BIT_THRESHOLD = 180;

// fontKey (stored in designs/{id}-dynamic.json, set by the "Serif" /
// "Block" / "Pixel" buttons in design-v2) -> the family name registered
// below. Kept as a stable short key rather than storing a raw CSS
// font-family string, since browser font-family syntax ("'Bungee',
// sans-serif") isn't what registerFont() needs here.
const FONT_FAMILY = {
  serif: "WC Countdown Serif",
  block: "WC Countdown Block",
  pixel: "WC Countdown Pixel"
};

let fontsRegistered = false;
function ensureFontsRegistered() {
  if (fontsRegistered) return;
  const fontsDir = path.join(__dirname, "..", "fonts");
  registerFont(path.join(fontsDir, "PTSerif-Regular.ttf"), { family: FONT_FAMILY.serif, weight: "normal" });
  registerFont(path.join(fontsDir, "PTSerif-Bold.ttf"), { family: FONT_FAMILY.serif, weight: "bold" });
  registerFont(path.join(fontsDir, "Bungee-Regular.ttf"), { family: FONT_FAMILY.block });
  registerFont(path.join(fontsDir, "PressStart2P-Regular.ttf"), { family: FONT_FAMILY.pixel });
  fontsRegistered = true;
}

// ================= Countdown (target-date) type =================

// Calendar-date difference, ignoring time-of-day -- targetDateStr is
// "YYYY-MM-DD". `now` defaults to the function's own current time, in UTC
// (there's no single "local" timezone that makes sense for a server-side
// job covering devices nationwide -- see the design-v2 build notes for the
// known tradeoff this introduces: a device very close to its own local
// midnight can be briefly a day ahead/behind of this UTC-dated count).
function daysUntil(targetDateStr, now) {
  const [ty, tm, td] = targetDateStr.split("-").map(Number);
  const target = Date.UTC(ty, tm - 1, td);
  const at = now || new Date();
  const today = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  return Math.round((target - today) / 86400000);
}

function formatCountdownText(daysLeft, label) {
  const lbl = (label || "").trim().toUpperCase();
  if (daysLeft <= 0) return lbl ? lbl + " TODAY!" : "TODAY!";
  const unit = daysLeft === 1 ? "DAY" : "DAYS";
  return lbl ? daysLeft + " " + unit + " TO " + lbl : daysLeft + " " + unit;
}

// ================= Team (next-game) type =================
//
// Uses ESPN's unofficial "site API" -- not officially documented or
// supported, no key required, same URL shape across every league:
//   GET https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/teams/{teamId}/schedule
// Response shape (consistent across ESPN's whole site-API surface, widely
// relied on by community tooling, but never verified against a LIVE
// response from this codebase's own test environment -- network egress to
// ESPN was blocked in the sandbox this was built in. Worth a live
// smoke-test after this is deployed):
//   { events: [ { date: "2026-09-14T17:00Z", competitions: [ { competitors: [
//       { homeAway: "home"|"away", team: { id, abbreviation, shortDisplayName } },
//       { homeAway: "home"|"away", team: { ... } }
//   ] } ] } ] }

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports";

// Confirmed live: without an explicit seasontype, ESPN's schedule
// endpoint defaults to seasontype=1 (Preseason) -- fine for NFL (which
// has real preseason games), but college football doesn't play a
// preseason at all, so that bucket is just empty (events: []), which
// read as "no upcoming games" even mid-season. seasontype=2 (Regular
// Season) is what a "next game" lookup actually wants across every sport
// here. Known gap: this won't surface playoff/bowl games once a team's
// regular season has ended (those are seasontype=3) -- acceptable for
// now, not worth a second request just for that edge case yet.
function espnScheduleUrl(sport, league, teamId) {
  return ESPN_BASE + "/" + sport + "/" + league + "/teams/" + teamId + "/schedule?seasontype=2";
}

function espnTeamsUrl(sport, league) {
  return ESPN_BASE + "/" + sport + "/" + league + "/teams?limit=400";
}

// Finds the earliest event whose calendar date is today-or-later. Returns
// { nextGame: { homeAway, opponentAbbrev, dayUTC } | null, myAbbrev }.
// myAbbrev is captured from ANY event that includes this team -- even a
// past one -- specifically so a genuinely-empty upcoming schedule can
// still be labeled with the team's own name ("PHI: NO UPCOMING GAMES")
// instead of a bare, unattributed message. nextGame being null is a real,
// steady-state off-season case, NOT an error -- callers should render it
// normally, not treat it as a failure. Throws only on an actual
// fetch/parse failure, which callers should treat as "try again next
// run," not "the season is over."
async function findNextGame(events, teamId, now) {
  const at = now || new Date();
  const todayUTC = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  let best = null;
  let myAbbrev = null;
  for (const ev of events || []) {
    if (!ev) continue;
    const comp = ev.competitions && ev.competitions[0];
    const competitors = comp && comp.competitors;
    if (!competitors) continue;
    const me = competitors.find((c) => c && c.team && String(c.team.id) === String(teamId));
    if (!me) continue;
    if (!myAbbrev) {
      myAbbrev = (me.team.abbreviation || me.team.shortDisplayName || me.team.displayName || "").toUpperCase() || null;
    }

    if (!ev.date) continue;
    const evDate = new Date(ev.date);
    if (isNaN(evDate.getTime())) continue;
    const evDayUTC = Date.UTC(evDate.getUTCFullYear(), evDate.getUTCMonth(), evDate.getUTCDate());
    if (evDayUTC < todayUTC) continue; // already happened
    const opp = competitors.find((c) => c && c.team && String(c.team.id) !== String(teamId));
    if (!opp) continue;

    if (!best || evDayUTC < best.dayUTC) {
      best = {
        dayUTC: evDayUTC,
        homeAway: me.homeAway,
        opponentAbbrev: (opp.team.abbreviation || opp.team.shortDisplayName || opp.team.displayName || "TBD").toUpperCase()
      };
    }
  }
  return { nextGame: best, myAbbrev };
}

// `fetchImpl` is injectable so tests never make a real network call --
// defaults to the platform global (Node 20's built-in fetch in the actual
// Cloud Function, or a browser's fetch in design-v2).
async function fetchNextGame(sport, league, teamId, now, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const resp = await doFetch(espnScheduleUrl(sport, league, teamId));
  if (!resp.ok) throw new Error("ESPN schedule fetch failed: " + resp.status);
  const data = await resp.json();
  return findNextGame(data.events, teamId, now);
}

function formatTeamText(nextGame, myAbbrev) {
  if (!nextGame) return myAbbrev ? myAbbrev + ": NO UPCOMING GAMES" : "NO UPCOMING GAMES";
  const prefix = myAbbrev ? myAbbrev + " " : "";
  const vsOrAt = nextGame.homeAway === "home" ? "VS" : "@";
  const daysLeft = nextGame.daysLeft;
  if (daysLeft <= 0) return prefix + vsOrAt + " " + nextGame.opponentAbbrev + " TODAY!";
  const unit = daysLeft === 1 ? "DAY" : "DAYS";
  return prefix + vsOrAt + " " + nextGame.opponentAbbrev + " IN " + daysLeft + " " + unit;
}

// ================= Shared rendering/packing =================

// Mirrors design-v2/index.html's packTo1Bit exactly: row-major, MSB-first
// bit packing, threshold 180, with the black/white decision flipped (not
// the pixels themselves) when inverted.
function packTo1Bit(canvas, inverted) {
  const width = canvas.width, height = canvas.height;
  const ctx = canvas.getContext("2d");
  const imgData = ctx.getImageData(0, 0, width, height).data;
  const bytesPerRow = Math.ceil(width / 8);
  const packed = Buffer.alloc(bytesPerRow * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = imgData[i], g = imgData[i + 1], b = imgData[i + 2];
      const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
      const isBlack = inverted ? luminance > BIT_THRESHOLD : luminance <= BIT_THRESHOLD;
      if (isBlack) {
        const byteIndex = y * bytesPerRow + (x >> 3);
        const bitIndex = 7 - (x & 7);
        packed[byteIndex] |= (1 << bitIndex);
      }
    }
  }
  return packed;
}

// Mirrors the browser's `ctx.filter = "invert(1)"` used for the PUBLISHED
// PREVIEW png in design-v2/index.html -- a plain per-channel 255-v, alpha
// untouched. Returns a NEW canvas; doesn't mutate the one passed in, since
// packTo1Bit above needs the original (non-inverted) pixels.
function invertedCopy(canvas) {
  const out = createCanvas(canvas.width, canvas.height);
  const ctx = out.getContext("2d");
  ctx.drawImage(canvas, 0, 0);
  const imgData = ctx.getImageData(0, 0, out.width, out.height);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = 255 - d[i];
    d[i + 1] = 255 - d[i + 1];
    d[i + 2] = 255 - d[i + 2];
  }
  ctx.putImageData(imgData, 0, 0);
  return out;
}

function drawDynamicText(ctx, content, meta) {
  const family = FONT_FAMILY[meta.fontKey] || FONT_FAMILY.serif;
  ctx.font = "bold " + meta.size + "px \"" + family + "\"";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (meta.outline) {
    ctx.strokeStyle = "#000";
    ctx.lineWidth = Math.max(1, meta.size * 0.07);
    ctx.strokeText(content, meta.x, meta.y);
  } else {
    ctx.fillStyle = "#000";
    ctx.fillText(content, meta.x, meta.y);
  }
}

async function compositeAndPack(basePngBuffer, content, meta) {
  const baseImage = await loadImage(basePngBuffer);
  const composite = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
  const ctx = composite.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  ctx.drawImage(baseImage, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  drawDynamicText(ctx, content, meta);

  const binBuffer = packTo1Bit(composite, !!meta.inverted);
  const previewCanvas = meta.inverted ? invertedCopy(composite) : composite;
  const pngBuffer = previewCanvas.toBuffer("image/png");
  return { binBuffer, pngBuffer, content };
}

// Builds the finished .bin + .png for one device from its base.png buffer
// and dynamic.json metadata, for the given "now".
//
// Returns null ONLY for a countdown whose target date has passed --
// callers should treat that as "this dynamic layer has concluded, clean
// it up and stop touching this device" (see index.js).
//
// Throws on a genuine failure (bad meta.type, or -- for "team" -- an ESPN
// fetch/parse error). Callers should treat a throw as "leave the device
// alone and try again on the next scheduled run," NOT as "clean up" --
// unlike a concluded countdown, a team's schedule is perpetual/renews
// every season, so a transient fetch failure is never a reason to give up
// on a device.
async function renderDynamicDesign(basePngBuffer, meta, now, fetchImpl) {
  ensureFontsRegistered();

  if (meta.type === "countdown") {
    const daysLeft = daysUntil(meta.targetDate, now);
    if (daysLeft < 0) return null;
    const content = formatCountdownText(daysLeft, meta.label);
    const result = await compositeAndPack(basePngBuffer, content, meta);
    return Object.assign(result, { daysLeft });
  }

  if (meta.type === "team") {
    const { nextGame: rawNextGame, myAbbrev } = await fetchNextGame(meta.sport, meta.league, meta.teamId, now, fetchImpl);
    const nextGame = rawNextGame && Object.assign({}, rawNextGame, {
      daysLeft: Math.round((rawNextGame.dayUTC - Date.UTC((now || new Date()).getUTCFullYear(), (now || new Date()).getUTCMonth(), (now || new Date()).getUTCDate())) / 86400000)
    });
    const content = formatTeamText(nextGame, myAbbrev);
    const result = await compositeAndPack(basePngBuffer, content, meta);
    return Object.assign(result, { nextGame, myAbbrev });
  }

  throw new Error("Unknown dynamic layer type: " + meta.type);
}

module.exports = {
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  FONT_FAMILY,
  daysUntil,
  formatCountdownText,
  formatTeamText,
  findNextGame,
  fetchNextGame,
  espnScheduleUrl,
  espnTeamsUrl,
  packTo1Bit,
  invertedCopy,
  drawDynamicText,
  renderDynamicDesign,
  ensureFontsRegistered
};
