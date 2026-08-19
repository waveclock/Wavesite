"use strict";

const assert = require("assert");
const { createCanvas, loadImage } = require("canvas");
const {
  daysUntil,
  formatCountdownText,
  packTo1Bit,
  invertedCopy,
  renderCountdownDesign,
  CANVAS_WIDTH,
  CANVAS_HEIGHT
} = require("../lib/countdown");

let passed = 0, failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ok - " + name);
  } catch (err) {
    failed++;
    console.log("  FAIL - " + name);
    console.log("    " + err.message);
  }
}

function whiteCanvas(w, h) {
  const c = createCanvas(w, h);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  return c;
}

(async () => {
  console.log("daysUntil / formatCountdownText");
  await test("5 days out counts as 5", () => {
    const now = new Date(Date.UTC(2026, 5, 1)); // 2026-06-01
    assert.strictEqual(daysUntil("2026-06-06", now), 5);
  });
  await test("same day counts as 0", () => {
    const now = new Date(Date.UTC(2026, 5, 1));
    assert.strictEqual(daysUntil("2026-06-01", now), 0);
  });
  await test("past date is negative", () => {
    const now = new Date(Date.UTC(2026, 5, 1));
    assert.strictEqual(daysUntil("2026-05-20", now), -12);
  });
  await test("time-of-day on 'now' doesn't shift the calendar-date diff", () => {
    const morning = new Date(Date.UTC(2026, 5, 1, 1, 0, 0));
    const night = new Date(Date.UTC(2026, 5, 1, 23, 59, 0));
    assert.strictEqual(daysUntil("2026-06-06", morning), 5);
    assert.strictEqual(daysUntil("2026-06-06", night), 5);
  });
  await test("format: plain count, no label", () => {
    assert.strictEqual(formatCountdownText(5, ""), "5 DAYS");
  });
  await test("format: singular DAY at 1", () => {
    assert.strictEqual(formatCountdownText(1, ""), "1 DAY");
  });
  await test("format: with label", () => {
    assert.strictEqual(formatCountdownText(5, "wedding"), "5 DAYS TO WEDDING");
  });
  await test("format: today, no label", () => {
    assert.strictEqual(formatCountdownText(0, ""), "TODAY!");
  });
  await test("format: today, with label", () => {
    assert.strictEqual(formatCountdownText(0, "launch"), "LAUNCH TODAY!");
  });

  console.log("packTo1Bit");
  await test("packs a fully-black canvas to all-1 bits", () => {
    const c = createCanvas(16, 8);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, 16, 8);
    const packed = packTo1Bit(c, false);
    assert.strictEqual(packed.length, Math.ceil(16 / 8) * 8);
    for (const byte of packed) assert.strictEqual(byte, 0xff);
  });
  await test("packs a fully-white canvas to all-0 bits", () => {
    const c = whiteCanvas(16, 8);
    const packed = packTo1Bit(c, false);
    for (const byte of packed) assert.strictEqual(byte, 0x00);
  });
  await test("inverted flips a white canvas to all-1 bits", () => {
    const c = whiteCanvas(16, 8);
    const packed = packTo1Bit(c, true);
    for (const byte of packed) assert.strictEqual(byte, 0xff);
  });
  await test("output size matches the device's known .bin size at 792x272", () => {
    const c = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
    const packed = packTo1Bit(c, false);
    assert.strictEqual(packed.length, 99 * 272); // bytesPerRow=ceil(792/8)=99
    assert.strictEqual(packed.length, 26928);
  });

  console.log("invertedCopy");
  await test("flips RGB per-channel, leaves alpha untouched", () => {
    const c = createCanvas(2, 1);
    const ctx = c.getContext("2d");
    const imgData = ctx.createImageData(2, 1);
    imgData.data.set([10, 20, 30, 255, 200, 210, 220, 128]);
    ctx.putImageData(imgData, 0, 0);
    const out = invertedCopy(c);
    const outData = out.getContext("2d").getImageData(0, 0, 2, 1).data;
    assert.deepStrictEqual(Array.from(outData), [245, 235, 225, 255, 55, 45, 35, 128]);
  });
  await test("does not mutate the original canvas", () => {
    const c = whiteCanvas(4, 4);
    invertedCopy(c);
    const d = c.getContext("2d").getImageData(0, 0, 4, 4).data;
    assert.strictEqual(d[0], 255);
  });

  console.log("renderCountdownDesign");
  await test("renders a real design at the full device resolution", async () => {
    const base = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT).toBuffer("image/png");
    const now = new Date(Date.UTC(2026, 5, 1));
    const meta = { targetDate: "2026-06-15", label: "Trip", x: 396, y: 136, size: 48, fontKey: "block", outline: true, inverted: false };
    const result = await renderCountdownDesign(base, meta, now);
    assert.ok(result);
    assert.strictEqual(result.content, "14 DAYS TO TRIP");
    assert.strictEqual(result.daysLeft, 14);
    assert.strictEqual(result.binBuffer.length, 26928);
    // Some pixels should now be ink (text was drawn) -- a blank white
    // base would pack to all-zero bytes, same check as the pure-white
    // test above, so any non-zero byte proves real content got drawn.
    assert.ok(result.binBuffer.some((b) => b !== 0), "expected some black pixels from the drawn text");
    // PNG must decode back cleanly at the right dimensions.
    const decoded = await loadImage(result.pngBuffer);
    assert.strictEqual(decoded.width, CANVAS_WIDTH);
    assert.strictEqual(decoded.height, CANVAS_HEIGHT);
  });
  await test("returns null once the target date has passed (caller should stop updating)", async () => {
    const base = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT).toBuffer("image/png");
    const now = new Date(Date.UTC(2026, 5, 1));
    const meta = { targetDate: "2026-05-20", label: "", x: 396, y: 136, size: 48, fontKey: "serif", outline: false, inverted: false };
    const result = await renderCountdownDesign(base, meta, now);
    assert.strictEqual(result, null);
  });
  await test("renders on target day itself as TODAY! (daysLeft 0 is NOT treated as expired)", async () => {
    const base = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT).toBuffer("image/png");
    const now = new Date(Date.UTC(2026, 5, 1));
    const meta = { targetDate: "2026-06-01", label: "", x: 396, y: 136, size: 48, fontKey: "pixel", outline: false, inverted: false };
    const result = await renderCountdownDesign(base, meta, now);
    assert.ok(result);
    assert.strictEqual(result.content, "TODAY!");
  });
  await test("inverted design still packs to the correct byte length", async () => {
    const base = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT).toBuffer("image/png");
    const now = new Date(Date.UTC(2026, 5, 1));
    const meta = { targetDate: "2026-06-10", label: "", x: 396, y: 136, size: 48, fontKey: "serif", outline: false, inverted: true };
    const result = await renderCountdownDesign(base, meta, now);
    assert.strictEqual(result.binBuffer.length, 26928);
  });

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
