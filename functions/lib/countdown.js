// Pure rendering/packing logic for the daily countdown regeneration job --
// kept dependency-free (besides `canvas`) and separate from index.js so it
// can be unit-tested without a live Firebase project (see test/).
//
// IMPORTANT: daysUntil() and formatCountdownText() are deliberately
// duplicated (not shared via a build step) in design-v2/index.html, which
// is the browser-side code that first renders/previews this same text at
// publish time. If the format changes here, it must change there too, or
// what a customer previewed at publish time won't match what the board
// shows once this job redraws it the next day.
"use strict";

const { createCanvas, loadImage, registerFont } = require("canvas");
const path = require("path");

const CANVAS_WIDTH = 792;
const CANVAS_HEIGHT = 272;
const BIT_THRESHOLD = 180;

// fontKey (stored in designs/{id}-countdown.json, set by the "Serif" /
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

function drawCountdownText(ctx, content, meta) {
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

// Builds the finished .bin + .png for one device from its base.png buffer
// and countdown.json metadata, for the given "now". Returns null if the
// countdown has already passed (daysLeft < 0) -- callers should treat that
// as "stop touching this device" (see index.js).
async function renderCountdownDesign(basePngBuffer, meta, now) {
  ensureFontsRegistered();
  const daysLeft = daysUntil(meta.targetDate, now);
  if (daysLeft < 0) return null;

  const baseImage = await loadImage(basePngBuffer);
  const composite = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
  const ctx = composite.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  ctx.drawImage(baseImage, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  const content = formatCountdownText(daysLeft, meta.label);
  drawCountdownText(ctx, content, meta);

  const binBuffer = packTo1Bit(composite, !!meta.inverted);
  const previewCanvas = meta.inverted ? invertedCopy(composite) : composite;
  const pngBuffer = previewCanvas.toBuffer("image/png");

  return { binBuffer, pngBuffer, content, daysLeft };
}

module.exports = {
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  FONT_FAMILY,
  daysUntil,
  formatCountdownText,
  packTo1Bit,
  invertedCopy,
  drawCountdownText,
  renderCountdownDesign,
  ensureFontsRegistered
};
