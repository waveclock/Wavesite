"use strict";

const assert = require("assert");
const { createCanvas, loadImage } = require("canvas");
const {
  daysUntil,
  formatCountdownText,
  formatTeamText,
  findNextGame,
  fetchNextGame,
  packTo1Bit,
  invertedCopy,
  renderDynamicDesign,
  CANVAS_WIDTH,
  CANVAS_HEIGHT
} = require("../lib/dynamic");

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

// Builds a synthetic ESPN-shaped schedule response for tests -- see
// lib/dynamic.js's comment above fetchNextGame for the (unverified
// against a live response, but well-established/widely-documented) shape
// this is modeled on.
function espnSchedule(myTeamId, games) {
  return {
    events: games.map((g, i) => ({
      id: "evt" + i,
      date: g.date,
      competitions: [{
        competitors: [
          { homeAway: g.homeAway, team: { id: myTeamId, abbreviation: "ME" } },
          { homeAway: g.homeAway === "home" ? "away" : "home", team: { id: "opp" + i, abbreviation: g.opponentAbbrev } }
        ]
      }]
    }))
  };
}

function fakeFetchJson(payload, ok) {
  return async () => ({
    ok: ok !== false,
    status: ok === false ? 503 : 200,
    async json() { return payload; }
  });
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

  console.log("findNextGame / formatTeamText");
  await test("picks the earliest upcoming game, ignoring past ones", async () => {
    const now = new Date(Date.UTC(2026, 8, 1)); // 2026-09-01
    const schedule = espnSchedule("5", [
      { date: "2026-08-20T17:00Z", homeAway: "home", opponentAbbrev: "OLD" },
      { date: "2026-09-14T17:00Z", homeAway: "away", opponentAbbrev: "LATE" },
      { date: "2026-09-07T17:00Z", homeAway: "home", opponentAbbrev: "NEXT" }
    ]);
    const { nextGame, myAbbrev } = await findNextGame(schedule.events, "5", now);
    assert.ok(nextGame);
    assert.strictEqual(nextGame.opponentAbbrev, "NEXT");
    assert.strictEqual(nextGame.homeAway, "home");
    assert.strictEqual(myAbbrev, "ME");
  });
  await test("nextGame is null when every game is in the past (off-season), but myAbbrev is still captured", async () => {
    const now = new Date(Date.UTC(2026, 8, 1));
    const schedule = espnSchedule("5", [
      { date: "2026-01-10T17:00Z", homeAway: "home", opponentAbbrev: "OLD" }
    ]);
    const { nextGame, myAbbrev } = await findNextGame(schedule.events, "5", now);
    assert.strictEqual(nextGame, null);
    assert.strictEqual(myAbbrev, "ME");
  });
  await test("today's game counts as upcoming (0 days)", async () => {
    const now = new Date(Date.UTC(2026, 8, 1, 3, 0, 0));
    const schedule = espnSchedule("5", [
      { date: "2026-09-01T23:00Z", homeAway: "away", opponentAbbrev: "TON" }
    ]);
    const { nextGame } = await findNextGame(schedule.events, "5", now);
    assert.ok(nextGame);
    assert.strictEqual(nextGame.opponentAbbrev, "TON");
  });
  await test("myAbbrev is null when the team never appears in the schedule at all", async () => {
    const now = new Date(Date.UTC(2026, 8, 1));
    const { nextGame, myAbbrev } = await findNextGame([], "5", now);
    assert.strictEqual(nextGame, null);
    assert.strictEqual(myAbbrev, null);
  });
  await test("format: home game, with team prefix", () => {
    assert.strictEqual(formatTeamText({ homeAway: "home", opponentAbbrev: "EAGLES", daysLeft: 5 }, "PHI"), "PHI VS EAGLES IN 5 DAYS");
  });
  await test("format: away game, with team prefix", () => {
    assert.strictEqual(formatTeamText({ homeAway: "away", opponentAbbrev: "CHIEFS", daysLeft: 1 }, "KC"), "KC @ CHIEFS IN 1 DAY");
  });
  await test("format: game today, with team prefix", () => {
    assert.strictEqual(formatTeamText({ homeAway: "home", opponentAbbrev: "EAGLES", daysLeft: 0 }, "PHI"), "PHI VS EAGLES TODAY!");
  });
  await test("format: no upcoming games, with team prefix", () => {
    assert.strictEqual(formatTeamText(null, "PHI"), "PHI: NO UPCOMING GAMES");
  });
  await test("format: no team prefix available falls back to the old bare format", () => {
    assert.strictEqual(formatTeamText({ homeAway: "home", opponentAbbrev: "EAGLES", daysLeft: 5 }, null), "VS EAGLES IN 5 DAYS");
    assert.strictEqual(formatTeamText(null, null), "NO UPCOMING GAMES");
  });
  await test("fetchNextGame throws on a non-ok response (caller should skip-and-retry, not clean up)", async () => {
    await assert.rejects(
      () => fetchNextGame("football", "nfl", "21", new Date(), fakeFetchJson({}, false)),
      /ESPN schedule fetch failed/
    );
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

  console.log("renderDynamicDesign (type: countdown)");
  await test("renders a real design at the full device resolution", async () => {
    const base = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT).toBuffer("image/png");
    const now = new Date(Date.UTC(2026, 5, 1));
    const meta = { type: "countdown", targetDate: "2026-06-15", label: "Trip", x: 396, y: 136, size: 48, fontKey: "block", outline: true, inverted: false };
    const result = await renderDynamicDesign(base, meta, now);
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
  await test("returns null once the target date has passed (caller should clean up)", async () => {
    const base = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT).toBuffer("image/png");
    const now = new Date(Date.UTC(2026, 5, 1));
    const meta = { type: "countdown", targetDate: "2026-05-20", label: "", x: 396, y: 136, size: 48, fontKey: "serif", outline: false, inverted: false };
    const result = await renderDynamicDesign(base, meta, now);
    assert.strictEqual(result, null);
  });
  await test("renders on target day itself as TODAY! (daysLeft 0 is NOT treated as expired)", async () => {
    const base = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT).toBuffer("image/png");
    const now = new Date(Date.UTC(2026, 5, 1));
    const meta = { type: "countdown", targetDate: "2026-06-01", label: "", x: 396, y: 136, size: 48, fontKey: "pixel", outline: false, inverted: false };
    const result = await renderDynamicDesign(base, meta, now);
    assert.ok(result);
    assert.strictEqual(result.content, "TODAY!");
  });
  await test("inverted design still packs to the correct byte length", async () => {
    const base = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT).toBuffer("image/png");
    const now = new Date(Date.UTC(2026, 5, 1));
    const meta = { type: "countdown", targetDate: "2026-06-10", label: "", x: 396, y: 136, size: 48, fontKey: "serif", outline: false, inverted: true };
    const result = await renderDynamicDesign(base, meta, now);
    assert.strictEqual(result.binBuffer.length, 26928);
  });

  console.log("renderDynamicDesign (type: team)");
  await test("renders the next game using an injected fetch (never touches the real network)", async () => {
    const base = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT).toBuffer("image/png");
    const now = new Date(Date.UTC(2026, 8, 1));
    const schedule = espnSchedule("21", [{ date: "2026-09-08T17:00Z", homeAway: "home", opponentAbbrev: "COWBOYS" }]);
    const meta = { type: "team", sport: "football", league: "nfl", teamId: "21", x: 396, y: 136, size: 48, fontKey: "block", outline: true, inverted: false };
    const result = await renderDynamicDesign(base, meta, now, fakeFetchJson(schedule));
    assert.ok(result);
    assert.strictEqual(result.content, "ME VS COWBOYS IN 7 DAYS");
    assert.strictEqual(result.myAbbrev, "ME");
    assert.ok(result.binBuffer.some((b) => b !== 0));
  });
  await test("off-season (no upcoming games) renders normally with the team labeled, does NOT return null", async () => {
    const base = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT).toBuffer("image/png");
    const now = new Date(Date.UTC(2026, 8, 1));
    const schedule = espnSchedule("21", [{ date: "2026-01-10T17:00Z", homeAway: "home", opponentAbbrev: "OLD" }]);
    const meta = { type: "team", sport: "football", league: "nfl", teamId: "21", x: 396, y: 136, size: 48, fontKey: "serif", outline: false, inverted: false };
    const result = await renderDynamicDesign(base, meta, now, fakeFetchJson(schedule));
    assert.ok(result, "team layers should never return null -- they're perpetual, not cleaned up");
    assert.strictEqual(result.content, "ME: NO UPCOMING GAMES");
  });
  await test("a real ESPN failure throws instead of returning null (must not be cleaned up)", async () => {
    const base = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT).toBuffer("image/png");
    const now = new Date(Date.UTC(2026, 8, 1));
    const meta = { type: "team", sport: "football", league: "nfl", teamId: "21", x: 396, y: 136, size: 48, fontKey: "serif", outline: false, inverted: false };
    await assert.rejects(() => renderDynamicDesign(base, meta, now, fakeFetchJson({}, false)));
  });

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
