"use strict";

const assert = require("assert");
const { createCanvas, loadImage } = require("canvas");
const {
  daysUntil,
  formatCountdownText,
  formatTeamText,
  formatGameDateTimeParts,
  findNextGame,
  fetchNextGame,
  extractLogoUrl,
  extractVenueName,
  gameDayBannerTitle,
  fitBannerFontSize,
  packTo1Bit,
  invertedCopy,
  drawGameDayCard,
  drawGameLine,
  toGrayscale,
  ditherAtkinson,
  ditheredLogoCanvas,
  fetchDitheredLogo,
  isPrivateOrLinkLocalHostname,
  isSafeFetchUrl,
  newsFeedUrl,
  parseRssHeadlines,
  fetchHeadlines,
  formatNewsFallbackText,
  truncateToWidth,
  wrapToLines,
  drawNewsCard,
  formatShortDate,
  renderDynamicDesign,
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  LOGO_SIZE,
  OUTBOUND_FETCH_HEADERS
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

function fakeFetchText(text, ok) {
  return async () => ({
    ok: ok !== false,
    status: ok === false ? 503 : 200,
    async text() { return text; }
  });
}

const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>Example Feed</title>
<item><title><![CDATA[Boardwalk reconstruction to begin after Labor Day]]></title><link>https://example.com/1</link></item>
<item><title>Council approves &amp; celebrates new beach tag pricing</title><link>https://example.com/2</link></item>
<item><title>Local surf shop wins &quot;small business&quot; award &#39;again&#39;</title><link>https://example.com/3</link></item>
<item><title>A fourth headline that should be cut off by maxItems</title><link>https://example.com/4</link></item>
</channel></rss>`;

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
  await test("fetchNextGame does NOT send a custom User-Agent -- this endpoint is currently working live without one, left alone while fixing the still-broken RSS fetch", async () => {
    let capturedOptions = null;
    const fetchImpl = async (url, options) => {
      capturedOptions = options;
      return { ok: true, status: 200, async json() { return { events: [] }; } };
    };
    await fetchNextGame("football", "nfl", "21", new Date(), fetchImpl);
    assert.strictEqual(capturedOptions, undefined);
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

  console.log("formatGameDateTimeParts");
  await test("splits an ISO date into a dateLabel + timeLabel in Eastern time, matching US broadcast convention", () => {
    // 2026-10-24 17:30Z = 1:30 PM ET (EDT, UTC-4) that day.
    const parts = formatGameDateTimeParts("2026-10-24T17:30Z");
    assert.deepStrictEqual(parts, { dateLabel: "SAT OCT 24", timeLabel: "1:30 PM ET" });
  });
  await test("returns null for an unparseable date instead of showing garbage", () => {
    assert.strictEqual(formatGameDateTimeParts("not-a-date"), null);
  });

  console.log("extractLogoUrl / extractVenueName");
  await test("prefers a plain .logo string when present", () => {
    assert.strictEqual(extractLogoUrl({ logo: "https://example.com/a.png", logos: [{ href: "https://example.com/b.png" }] }), "https://example.com/a.png");
  });
  await test("falls back to logos[0].href", () => {
    assert.strictEqual(extractLogoUrl({ logos: [{ href: "https://example.com/b.png" }] }), "https://example.com/b.png");
  });
  await test("returns null when no team or no logo field is present", () => {
    assert.strictEqual(extractLogoUrl(null), null);
    assert.strictEqual(extractLogoUrl({}), null);
  });
  await test("reads venue.fullName, falling back to venue.name, then null", () => {
    assert.strictEqual(extractVenueName({ venue: { fullName: "Beaver Stadium" } }), "Beaver Stadium");
    assert.strictEqual(extractVenueName({ venue: { name: "The Vault" } }), "The Vault");
    assert.strictEqual(extractVenueName({ venue: {} }), null);
    assert.strictEqual(extractVenueName({}), null);
  });

  console.log("findNextGame (logo/venue capture for the Game Day card)");
  await test("captures myLogo, opponentLogo, venue, and gameDateISO on the chosen game", async () => {
    const now = new Date(Date.UTC(2026, 8, 1));
    const events = [{
      date: "2026-09-07T17:00Z",
      competitions: [{
        venue: { fullName: "Beaver Stadium" },
        competitors: [
          { homeAway: "home", team: { id: "213", abbreviation: "PSU", logo: "https://example.com/psu.png" } },
          { homeAway: "away", team: { id: "99", abbreviation: "OPP", logo: "https://example.com/opp.png" } }
        ]
      }]
    }];
    const { nextGame, myAbbrev, myLogo } = await findNextGame(events, "213", now);
    assert.ok(nextGame);
    assert.strictEqual(myAbbrev, "PSU");
    assert.strictEqual(myLogo, "https://example.com/psu.png");
    assert.strictEqual(nextGame.opponentLogo, "https://example.com/opp.png");
    assert.strictEqual(nextGame.venue, "Beaver Stadium");
    assert.strictEqual(nextGame.gameDateISO, "2026-09-07T17:00Z");
  });
  await test("prefers shortDisplayName ('Marshall') over the raw abbreviation ('MRSH') for both teams -- confirmed live, the abbreviation reads as cryptic on the actual card", async () => {
    const now = new Date(Date.UTC(2026, 8, 1));
    const events = [{
      date: "2026-09-07T17:00Z",
      competitions: [{
        competitors: [
          { homeAway: "home", team: { id: "213", abbreviation: "PSU", shortDisplayName: "Penn State" } },
          { homeAway: "away", team: { id: "276", abbreviation: "MRSH", shortDisplayName: "Marshall" } }
        ]
      }]
    }];
    const { nextGame, myAbbrev } = await findNextGame(events, "213", now);
    assert.strictEqual(myAbbrev, "PENN STATE");
    assert.strictEqual(nextGame.opponentAbbrev, "MARSHALL");
  });

  console.log("dithering (toGrayscale / ditherAtkinson / ditheredLogoCanvas / fetchDitheredLogo)");
  await test("toGrayscale collapses RGB to luminance, ignoring alpha", () => {
    const imgData = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 128]);
    const gray = toGrayscale(imgData, 2, 1);
    assert.strictEqual(gray[0], 0);
    assert.strictEqual(gray[1], 255);
  });
  await test("ditherAtkinson maps a solid black square to all-on bits, solid white to all-off", () => {
    const black = new Float32Array(16).fill(0);
    const bitsBlack = ditherAtkinson(black, 4, 4);
    assert.ok(Array.from(bitsBlack).every((b) => b === 1));
    const white = new Float32Array(16).fill(255);
    const bitsWhite = ditherAtkinson(white, 4, 4);
    assert.ok(Array.from(bitsWhite).every((b) => b === 0));
  });
  await test("ditheredLogoCanvas returns an opaque size x size canvas with some ink from a non-white source", () => {
    const src = createCanvas(40, 40);
    const sctx = src.getContext("2d");
    sctx.fillStyle = "#000";
    sctx.fillRect(0, 0, 40, 40);
    const out = ditheredLogoCanvas(src, 60);
    assert.strictEqual(out.width, 60);
    assert.strictEqual(out.height, 60);
    const d = out.getContext("2d").getImageData(0, 0, 60, 60).data;
    let sawBlack = false, sawOpaque = true;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] === 0) sawBlack = true;
      if (d[i + 3] !== 255) sawOpaque = false;
    }
    assert.ok(sawBlack, "expected some black pixels from a solid-black source logo");
    assert.ok(sawOpaque, "expected a fully opaque canvas (no transparency needed server-side)");
  });
  await test("fetchDitheredLogo returns null for a missing URL without fetching", async () => {
    const result = await fetchDitheredLogo(null, LOGO_SIZE, async () => { throw new Error("should never be called"); });
    assert.strictEqual(result, null);
  });
  await test("fetchDitheredLogo returns null (not a throw) on a failed fetch", async () => {
    const result = await fetchDitheredLogo("https://example.com/missing.png", LOGO_SIZE, async () => ({ ok: false, status: 404 }));
    assert.strictEqual(result, null);
  });
  await test("fetchDitheredLogo decodes, dithers, and sizes a real image buffer", async () => {
    const src = createCanvas(40, 40);
    const sctx = src.getContext("2d");
    sctx.fillStyle = "#000";
    sctx.fillRect(0, 0, 40, 40);
    const pngBuffer = src.toBuffer("image/png");
    const fakeFetch = async () => ({
      ok: true,
      async arrayBuffer() { return pngBuffer.buffer.slice(pngBuffer.byteOffset, pngBuffer.byteOffset + pngBuffer.byteLength); }
    });
    const out = await fetchDitheredLogo("https://example.com/logo.png", 60, fakeFetch);
    assert.ok(out);
    assert.strictEqual(out.width, 60);
  });
  await test("fetchDitheredLogo sends the same browser-like User-Agent as ESPN requests", async () => {
    const src = createCanvas(10, 10);
    src.getContext("2d").fillRect(0, 0, 10, 10);
    const pngBuffer = src.toBuffer("image/png");
    let capturedOptions = null;
    const fetchImpl = async (url, options) => {
      capturedOptions = options;
      return { ok: true, async arrayBuffer() { return pngBuffer.buffer.slice(pngBuffer.byteOffset, pngBuffer.byteOffset + pngBuffer.byteLength); } };
    };
    await fetchDitheredLogo("https://a.espncdn.com/logo.png", 60, fetchImpl);
    assert.strictEqual(capturedOptions.headers, OUTBOUND_FETCH_HEADERS);
  });

  console.log("gameDayBannerTitle / fitBannerFontSize");
  await test("builds a '{LEAGUE} GAME DAY' banner title for each mapped league", () => {
    assert.strictEqual(gameDayBannerTitle("football", "nfl"), "NFL GAME DAY");
    assert.strictEqual(gameDayBannerTitle("football", "college-football"), "COLLEGE FOOTBALL GAME DAY");
    assert.strictEqual(gameDayBannerTitle("basketball", "nba"), "NBA GAME DAY");
    assert.strictEqual(gameDayBannerTitle("baseball", "mlb"), "MLB GAME DAY");
    assert.strictEqual(gameDayBannerTitle("hockey", "nhl"), "NHL GAME DAY");
  });
  await test("falls back to a bare 'GAME DAY' for an unmapped sport/league", () => {
    assert.strictEqual(gameDayBannerTitle("football", "xfl"), "GAME DAY");
  });
  await test("fitBannerFontSize returns the max size when the text already fits", () => {
    const c = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
    const ctx = c.getContext("2d");
    const size = fitBannerFontSize(ctx, "NFL GAME DAY", 700, "sans-serif", 24, 14);
    assert.strictEqual(size, 24);
  });
  await test("fitBannerFontSize shrinks a long title until it fits, never truncating it", () => {
    const c = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
    const ctx = c.getContext("2d");
    const text = "COLLEGE FOOTBALL GAME DAY";
    const size = fitBannerFontSize(ctx, text, 300, "sans-serif", 24, 14);
    ctx.font = size + "px sans-serif";
    assert.ok(size < 24);
    assert.ok(size >= 14);
    assert.ok(ctx.measureText(text).width <= 300);
  });
  await test("fitBannerFontSize stops at minSize even if the text still doesn't fit", () => {
    const c = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
    const ctx = c.getContext("2d");
    const size = fitBannerFontSize(ctx, "AN IMPOSSIBLY LONG BANNER TITLE THAT NEVER FITS", 10, "sans-serif", 24, 14);
    assert.strictEqual(size, 14);
  });

  console.log("drawGameLine (bottom line: date, venue at a larger size, time -- all one line)");
  await test("centers the assembled line, with the venue segment measurably taller than the date/time segments", () => {
    const c = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
    const ctx = c.getContext("2d");
    drawGameLine(ctx, "SAT SEP 5", "Beaver Stadium", "3:30 PM ET", CANVAS_WIDTH - 48, 150);
    const d = ctx.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT).data;
    let minX = CANVAS_WIDTH, maxX = 0;
    for (let y = 0; y < CANVAS_HEIGHT; y++) {
      for (let x = 0; x < CANVAS_WIDTH; x++) {
        if (d[(y * CANVAS_WIDTH + x) * 4] < 250) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    }
    const center = (minX + maxX) / 2;
    assert.ok(Math.abs(center - CANVAS_WIDTH / 2) < 3, "expected the whole line centered, got center=" + center);
  });
  await test("shrinks a too-long line to fit maxWidth rather than overflowing it", () => {
    const c = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
    const ctx = c.getContext("2d");
    const maxWidth = 300;
    drawGameLine(ctx, "SAT OCTOBER 24", "Los Angeles Memorial Coliseum", "10:30 PM ET", maxWidth, 150);
    const d = ctx.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT).data;
    let minX = CANVAS_WIDTH, maxX = 0;
    for (let y = 0; y < CANVAS_HEIGHT; y++) {
      for (let x = 0; x < CANVAS_WIDTH; x++) {
        if (d[(y * CANVAS_WIDTH + x) * 4] < 250) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    }
    assert.ok(maxX - minX <= maxWidth, "expected the shrunk line to fit within " + maxWidth + "px, got " + (maxX - minX) + "px");
  });
  await test("falls back to just date + time (2 segments) when there's no venue", () => {
    const c = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
    const ctx = c.getContext("2d");
    assert.doesNotThrow(() => {
      drawGameLine(ctx, "SAT SEP 5", null, "3:30 PM ET", CANVAS_WIDTH - 48, 150);
    });
  });

  console.log("drawGameDayCard");
  await test("keeps an equal gap between the number and 'IN' above it vs 'DAY(S)' below it, regardless of digit count", () => {
    function blankGapsAroundNumber(daysLeft) {
      const c = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
      const ctx = c.getContext("2d");
      drawGameDayCard(ctx, { bannerTitle: "NFL GAME DAY", headline: "ME VS OPP", daysLeft, daysUnit: "DAYS", venue: null, dateLabel: null, timeLabel: null, myLogo: null, oppLogo: null });
      const d = ctx.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT).data;
      // Scoped to the days-block's vertical neighborhood only -- well
      // clear of the banner/headline above it, so their ink can't be
      // mistaken for part of this measurement.
      const rowHasInk = [];
      for (let y = 85; y < 235; y++) {
        let ink = false;
        for (let x = 0; x < CANVAS_WIDTH; x++) {
          if (d[(y * CANVAS_WIDTH + x) * 4] < 250) { ink = true; break; }
        }
        rowHasInk.push(ink);
      }
      const gaps = [];
      let blankStart = null, sawFirstInk = false;
      for (let i = 0; i < rowHasInk.length; i++) {
        if (rowHasInk[i]) {
          sawFirstInk = true;
          if (blankStart !== null) { gaps.push(i - blankStart); blankStart = null; }
        } else if (sawFirstInk && blankStart === null) {
          blankStart = i;
        }
      }
      return gaps;
    }
    for (const daysLeft of [1, 17, 128]) {
      const gaps = blankGapsAroundNumber(daysLeft);
      assert.strictEqual(gaps.length, 2, daysLeft + " days: expected 2 gaps (above/below the number), got " + gaps.length + " (" + gaps + ")");
      assert.ok(Math.abs(gaps[0] - gaps[1]) <= 2, daysLeft + " days: expected roughly equal gaps, got " + gaps[0] + "px and " + gaps[1] + "px");
    }
  });
  await test("draws a title banner, headline, and days count onto an otherwise-blank canvas", () => {
    const c = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
    const ctx = c.getContext("2d");
    drawGameDayCard(ctx, { bannerTitle: "NFL GAME DAY", headline: "ME VS OPP", daysLeft: 3, daysUnit: "DAYS", venue: null, dateLabel: null, timeLabel: null, myLogo: null, oppLogo: null });
    const d = ctx.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT).data;
    let sawInk = false;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] < 250) { sawInk = true; break; }
    }
    assert.ok(sawInk, "expected the banner/headline/days-count to leave some non-white pixels");
  });
  await test("falls back to a bare 'GAME DAY' banner when bannerTitle is missing", () => {
    const c = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
    const ctx = c.getContext("2d");
    assert.doesNotThrow(() => {
      drawGameDayCard(ctx, { headline: "ME VS OPP", daysLeft: 3, daysUnit: "DAYS", venue: null, dateLabel: null, timeLabel: null, myLogo: null, oppLogo: null });
    });
  });
  await test("draws a single big 'TODAY!' instead of the 3-line count when daysLeft is 0 or negative", () => {
    const c = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
    const ctx = c.getContext("2d");
    assert.doesNotThrow(() => {
      drawGameDayCard(ctx, { bannerTitle: "NFL GAME DAY", headline: "ME VS OPP", daysLeft: 0, daysUnit: "DAYS", venue: null, dateLabel: null, timeLabel: null, myLogo: null, oppLogo: null });
    });
  });
  await test("draws the one-line date/venue/time footer (venue larger, mid-line) when provided, without throwing", () => {
    const c = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
    const ctx = c.getContext("2d");
    assert.doesNotThrow(() => {
      drawGameDayCard(ctx, {
        bannerTitle: "COLLEGE FOOTBALL GAME DAY",
        headline: "PENN STATE VS MARSHALL", daysLeft: 17, daysUnit: "DAYS",
        venue: "Beaver Stadium", dateLabel: "SAT SEP 5", timeLabel: "3:30 PM ET",
        myLogo: null, oppLogo: null
      });
    });
  });
  await test("draws provided logo canvases without throwing, and skips the footer cleanly when absent", () => {
    const c = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
    const ctx = c.getContext("2d");
    const logo = ditheredLogoCanvas(whiteCanvas(20, 20), LOGO_SIZE);
    assert.doesNotThrow(() => {
      drawGameDayCard(ctx, {
        bannerTitle: "COLLEGE FOOTBALL GAME DAY",
        headline: "ME VS OPP", daysLeft: 0, daysUnit: "DAYS",
        venue: null, dateLabel: null, timeLabel: null,
        myLogo: logo, oppLogo: logo
      });
    });
  });

  console.log("renderDynamicDesign (type: team, Game Day card with logos)");
  await test("hasMyLogo/hasOppLogo are true when both logos fetch successfully, card includes date/venue", async () => {
    const base = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT).toBuffer("image/png");
    const now = new Date(Date.UTC(2026, 8, 1));
    const logoSrc = createCanvas(10, 10);
    logoSrc.getContext("2d").fillRect(0, 0, 10, 10);
    const logoPng = logoSrc.toBuffer("image/png");
    const schedule = {
      events: [{
        date: "2026-09-08T17:00Z",
        competitions: [{
          venue: { fullName: "Lincoln Financial Field" },
          competitors: [
            { homeAway: "home", team: { id: "21", abbreviation: "ME", logo: "https://example.com/me.png" } },
            { homeAway: "away", team: { id: "99", abbreviation: "COWBOYS", logo: "https://example.com/opp.png" } }
          ]
        }]
      }]
    };
    const meta = { type: "team", sport: "football", league: "nfl", teamId: "21", x: 396, y: 136, size: 48, fontKey: "block", outline: true, inverted: false };
    const fetchImpl = async (url) => {
      if (String(url).includes("espn.com")) return { ok: true, status: 200, async json() { return schedule; } };
      return { ok: true, async arrayBuffer() { return logoPng.buffer.slice(logoPng.byteOffset, logoPng.byteOffset + logoPng.byteLength); } };
    };
    const result = await renderDynamicDesign(base, meta, now, fetchImpl);
    assert.ok(result);
    assert.strictEqual(result.hasMyLogo, true);
    assert.strictEqual(result.hasOppLogo, true);
    assert.strictEqual(result.nextGame.venue, "Lincoln Financial Field");
    assert.ok(result.binBuffer.some((b) => b !== 0));
  });
  await test("renders the long 'COLLEGE FOOTBALL GAME DAY' banner title without throwing", async () => {
    const base = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT).toBuffer("image/png");
    const now = new Date(Date.UTC(2026, 8, 1));
    const schedule = espnSchedule("213", [{ date: "2026-09-08T17:00Z", homeAway: "home", opponentAbbrev: "OSU" }]);
    const meta = { type: "team", sport: "football", league: "college-football", teamId: "213", x: 396, y: 136, size: 48, fontKey: "block", outline: true, inverted: false };
    const result = await renderDynamicDesign(base, meta, now, fakeFetchJson(schedule));
    assert.ok(result);
    assert.ok(result.binBuffer.some((b) => b !== 0));
  });
  await test("hasMyLogo/hasOppLogo are false (card still renders) when logos are missing from the schedule", async () => {
    const base = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT).toBuffer("image/png");
    const now = new Date(Date.UTC(2026, 8, 1));
    const schedule = espnSchedule("21", [{ date: "2026-09-08T17:00Z", homeAway: "home", opponentAbbrev: "COWBOYS" }]);
    const meta = { type: "team", sport: "football", league: "nfl", teamId: "21", x: 396, y: 136, size: 48, fontKey: "block", outline: true, inverted: false };
    const result = await renderDynamicDesign(base, meta, now, fakeFetchJson(schedule));
    assert.ok(result);
    assert.strictEqual(result.hasMyLogo, false);
    assert.strictEqual(result.hasOppLogo, false);
    assert.strictEqual(result.nextGame.venue, null);
  });

  console.log("isPrivateOrLinkLocalHostname / isSafeFetchUrl (SSRF guard)");
  await test("flags loopback, RFC1918, and link-local IPv4 literals as private", () => {
    assert.strictEqual(isPrivateOrLinkLocalHostname("127.0.0.1"), true);
    assert.strictEqual(isPrivateOrLinkLocalHostname("10.0.0.5"), true);
    assert.strictEqual(isPrivateOrLinkLocalHostname("172.16.0.1"), true);
    assert.strictEqual(isPrivateOrLinkLocalHostname("172.31.255.255"), true);
    assert.strictEqual(isPrivateOrLinkLocalHostname("192.168.1.1"), true);
  });
  await test("flags the cloud metadata endpoint specifically (169.254.169.254)", () => {
    assert.strictEqual(isPrivateOrLinkLocalHostname("169.254.169.254"), true);
  });
  await test("flags localhost and 0.0.0.0 by name", () => {
    assert.strictEqual(isPrivateOrLinkLocalHostname("localhost"), true);
    assert.strictEqual(isPrivateOrLinkLocalHostname("LOCALHOST"), true);
    assert.strictEqual(isPrivateOrLinkLocalHostname("0.0.0.0"), true);
  });
  await test("does not flag ordinary public hostnames or IPs", () => {
    assert.strictEqual(isPrivateOrLinkLocalHostname("news.google.com"), false);
    assert.strictEqual(isPrivateOrLinkLocalHostname("8.8.8.8"), false);
    assert.strictEqual(isPrivateOrLinkLocalHostname("172.32.0.1"), false); // just outside the RFC1918 172.16-31 range
  });
  await test("isSafeFetchUrl accepts ordinary http(s) URLs", () => {
    assert.strictEqual(isSafeFetchUrl("https://example.com/feed.xml"), true);
    assert.strictEqual(isSafeFetchUrl("http://example.com/feed.xml"), true);
  });
  await test("isSafeFetchUrl rejects non-http(s) protocols and unparseable strings", () => {
    assert.strictEqual(isSafeFetchUrl("file:///etc/passwd"), false);
    assert.strictEqual(isSafeFetchUrl("ftp://example.com/feed.xml"), false);
    assert.strictEqual(isSafeFetchUrl("not a url"), false);
  });
  await test("isSafeFetchUrl rejects the cloud metadata endpoint even with a path/port", () => {
    assert.strictEqual(isSafeFetchUrl("http://169.254.169.254/computeMetadata/v1/"), false);
    assert.strictEqual(isSafeFetchUrl("http://169.254.169.254:80/latest/meta-data/"), false);
  });

  console.log("newsFeedUrl");
  await test("builds a Google News search URL from a free-text location", () => {
    const url = newsFeedUrl({ location: "Ocean City, NJ" });
    assert.strictEqual(url, "https://news.google.com/rss/search?q=Ocean%20City%2C%20NJ&hl=en-US&gl=US&ceid=US:en");
  });
  await test("a custom feedUrl always overrides the location search", () => {
    const url = newsFeedUrl({ location: "Ocean City, NJ", feedUrl: "https://example.com/feed.xml" });
    assert.strictEqual(url, "https://example.com/feed.xml");
  });
  await test("an empty/missing location still builds a (empty-query) search URL rather than throwing", () => {
    const url = newsFeedUrl({});
    assert.strictEqual(url, "https://news.google.com/rss/search?q=&hl=en-US&gl=US&ceid=US:en");
  });
  await test("an unsafe custom feedUrl (SSRF attempt) is ignored, falling back to the location search", () => {
    const url = newsFeedUrl({ location: "Ocean City, NJ", feedUrl: "http://169.254.169.254/computeMetadata/v1/" });
    assert.strictEqual(url, "https://news.google.com/rss/search?q=Ocean%20City%2C%20NJ&hl=en-US&gl=US&ceid=US:en");
  });

  console.log("parseRssHeadlines");
  await test("extracts titles from both CDATA-wrapped and plain-encoded <item>s, decoding entities", () => {
    const headlines = parseRssHeadlines(SAMPLE_RSS, 3);
    assert.deepStrictEqual(headlines, [
      "Boardwalk reconstruction to begin after Labor Day",
      "Council approves & celebrates new beach tag pricing",
      "Local surf shop wins \"small business\" award 'again'"
    ]);
  });
  await test("respects maxItems even when the feed has more entries", () => {
    const headlines = parseRssHeadlines(SAMPLE_RSS, 2);
    assert.strictEqual(headlines.length, 2);
  });
  await test("returns an empty array for a feed with no <item>s", () => {
    assert.deepStrictEqual(parseRssHeadlines("<rss><channel><title>Empty</title></channel></rss>", 3), []);
  });
  await test("skips an <item> with no <title> instead of pushing a blank/garbled headline", () => {
    const xml = "<rss><channel><item><link>https://example.com/no-title</link></item></channel></rss>";
    assert.deepStrictEqual(parseRssHeadlines(xml, 3), []);
  });
  await test("strips a Google-News-style trailing \" - Source Name\" so the card's one line goes to the headline, not attribution", () => {
    const xml = "<rss><channel><item><title>Wildwood Beach Patrol warns of rip currents - The Press of Atlantic City</title></item></channel></rss>";
    assert.deepStrictEqual(parseRssHeadlines(xml, 1), ["Wildwood Beach Patrol warns of rip currents"]);
  });
  await test("leaves a headline with no \" - \" separator alone", () => {
    const xml = "<rss><channel><item><title>Council approves new beach tag pricing</title></item></channel></rss>";
    assert.deepStrictEqual(parseRssHeadlines(xml, 1), ["Council approves new beach tag pricing"]);
  });
  await test("only the LAST \" - \" is treated as the source separator -- an earlier, mid-headline \" - \" is preserved", () => {
    const xml = "<rss><channel><item><title>Council debates plan - opponents say it's too costly - Shore Weekly</title></item></channel></rss>";
    assert.deepStrictEqual(parseRssHeadlines(xml, 1), ["Council debates plan - opponents say it's too costly"]);
  });

  console.log("fetchHeadlines / formatNewsFallbackText");
  await test("fetchHeadlines throws on a non-ok response (caller should skip-and-retry, not clean up)", async () => {
    await assert.rejects(
      () => fetchHeadlines({ location: "Nowhere" }, 3, fakeFetchText("", false)),
      /RSS feed fetch failed/
    );
  });
  await test("fetchHeadlines does NOT send a custom User-Agent -- matches ESPN's headerless fetch, which is what's currently working live", async () => {
    let capturedOptions = null;
    const fetchImpl = async (url, options) => {
      capturedOptions = options;
      return { ok: true, status: 200, async text() { return SAMPLE_RSS; } };
    };
    await fetchHeadlines({ location: "Ocean City, NJ" }, 3, fetchImpl);
    assert.strictEqual(capturedOptions, undefined);
  });
  await test("fetchHeadlines parses a real fetched response", async () => {
    const headlines = await fetchHeadlines({ location: "Ocean City, NJ" }, 3, fakeFetchText(SAMPLE_RSS));
    assert.strictEqual(headlines.length, 3);
  });
  await test("fallback text includes the location when present, and degrades gracefully without one", () => {
    assert.strictEqual(formatNewsFallbackText({ location: "Ocean City, NJ" }), "OCEAN CITY, NJ: NO HEADLINES FOUND");
    assert.strictEqual(formatNewsFallbackText({}), "NO HEADLINES FOUND");
  });

  console.log("truncateToWidth / drawNewsCard / formatShortDate");
  await test("truncateToWidth leaves short text untouched", () => {
    const c = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
    const ctx = c.getContext("2d");
    ctx.font = "16px sans-serif";
    assert.strictEqual(truncateToWidth(ctx, "short", 1000), "short");
  });
  await test("truncateToWidth shortens long text and appends an ellipsis", () => {
    const c = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
    const ctx = c.getContext("2d");
    ctx.font = "26px sans-serif";
    const result = truncateToWidth(ctx, "A very long headline that will not fit in a small width", 200);
    assert.ok(result.endsWith("…"));
    assert.ok(ctx.measureText(result).width <= 200);
  });
  await test("wrapToLines leaves short text as a single line", () => {
    const c = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
    const ctx = c.getContext("2d");
    ctx.font = "26px sans-serif";
    assert.deepStrictEqual(wrapToLines(ctx, "Short headline", 1000, 2), ["Short headline"]);
  });
  await test("wrapToLines breaks at a word boundary onto a 2nd line instead of truncating", () => {
    const c = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
    const ctx = c.getContext("2d");
    ctx.font = "26px sans-serif";
    const text = "Wildwood Beach Patrol warns of dangerous rip currents this weekend";
    const width = ctx.measureText(text).width * 0.6; // forces a wrap, but comfortably fits in 2 lines
    const lines = wrapToLines(ctx, text, width, 2);
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(lines.join(" "), text, "expected every word preserved across the 2 lines, none dropped or ellipsized");
    for (const line of lines) assert.ok(ctx.measureText(line).width <= width, "line overflowed maxWidth: " + line);
  });
  await test("wrapToLines truncates the LAST line (not silently dropping words) when text still doesn't fit after maxLines", () => {
    const c = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
    const ctx = c.getContext("2d");
    ctx.font = "26px sans-serif";
    const text = "Council approves new beach tag pricing structure after months of public debate and several contentious meetings";
    const width = ctx.measureText(text).width * 0.3; // too narrow to fit even in 2 lines
    const lines = wrapToLines(ctx, text, width, 2);
    assert.strictEqual(lines.length, 2);
    assert.ok(lines[1].endsWith("…"), "expected the 2nd (last) line truncated with an ellipsis, got: " + lines[1]);
    for (const line of lines) assert.ok(ctx.measureText(line).width <= width, "line overflowed maxWidth: " + line);
  });
  await test("formatShortDate renders a short Eastern-time month/day", () => {
    const now = new Date(Date.UTC(2026, 7, 19, 12, 0, 0)); // 2026-08-19
    assert.strictEqual(formatShortDate(now), "AUG 19");
  });
  await test("drawNewsCard draws a title banner, header, and headlines onto an otherwise-blank canvas", () => {
    const c = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
    const ctx = c.getContext("2d");
    drawNewsCard(ctx, { headerLabel: "OCEAN CITY, NJ", headlines: ["Headline one", "Headline two"], updatedLabel: "UPDATED AUG 19" });
    const d = ctx.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT).data;
    let sawInk = false;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] < 250) { sawInk = true; break; }
    }
    assert.ok(sawInk, "expected the border/header/headlines to leave some non-white pixels");
  });
  await test("drawNewsCard tolerates a missing headerLabel/updatedLabel without throwing", () => {
    const c = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
    const ctx = c.getContext("2d");
    assert.doesNotThrow(() => drawNewsCard(ctx, { headerLabel: "", headlines: ["Only one headline"], updatedLabel: null }));
  });

  console.log("renderDynamicDesign (type: news)");
  await test("renders a news card from real fetched headlines", async () => {
    const base = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT).toBuffer("image/png");
    const now = new Date(Date.UTC(2026, 7, 19));
    const meta = { type: "news", location: "Ocean City, NJ", x: 396, y: 136, size: 48, fontKey: "serif", outline: false, inverted: false };
    const result = await renderDynamicDesign(base, meta, now, fakeFetchText(SAMPLE_RSS));
    assert.ok(result);
    assert.strictEqual(result.headlines.length, 2);
    assert.ok(result.binBuffer.some((b) => b !== 0));
    const decoded = await loadImage(result.pngBuffer);
    assert.strictEqual(decoded.width, CANVAS_WIDTH);
    assert.strictEqual(decoded.height, CANVAS_HEIGHT);
  });
  await test("an empty feed (reachable, but no headlines) renders the fallback text, does NOT return null", async () => {
    const base = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT).toBuffer("image/png");
    const now = new Date(Date.UTC(2026, 7, 19));
    const meta = { type: "news", location: "Nowhere", x: 396, y: 136, size: 48, fontKey: "serif", outline: false, inverted: false };
    const emptyRss = "<rss><channel></channel></rss>";
    const result = await renderDynamicDesign(base, meta, now, fakeFetchText(emptyRss));
    assert.ok(result, "news layers should never return null -- they're perpetual, not cleaned up");
    assert.strictEqual(result.content, "NOWHERE: NO HEADLINES FOUND");
  });
  await test("a real feed-fetch failure throws instead of returning null (must not be cleaned up)", async () => {
    const base = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT).toBuffer("image/png");
    const now = new Date(Date.UTC(2026, 7, 19));
    const meta = { type: "news", location: "Ocean City, NJ", x: 396, y: 136, size: 48, fontKey: "serif", outline: false, inverted: false };
    await assert.rejects(() => renderDynamicDesign(base, meta, now, fakeFetchText("", false)));
  });
  await test("a custom feedUrl is used instead of the location search", async () => {
    const base = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT).toBuffer("image/png");
    const now = new Date(Date.UTC(2026, 7, 19));
    let requestedUrl = null;
    const fetchImpl = async (url) => { requestedUrl = url; return { ok: true, async text() { return SAMPLE_RSS; } }; };
    const meta = { type: "news", location: "Ocean City, NJ", feedUrl: "https://example.com/custom-feed.xml", x: 396, y: 136, size: 48, fontKey: "serif", outline: false, inverted: false };
    await renderDynamicDesign(base, meta, now, fetchImpl);
    assert.strictEqual(requestedUrl, "https://example.com/custom-feed.xml");
  });

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
