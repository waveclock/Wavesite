"use strict";

const assert = require("assert");
const { createCanvas, loadImage } = require("canvas");
const {
  daysUntil,
  formatCountdownText,
  formatTeamText,
  formatGameDateTime,
  findNextGame,
  fetchNextGame,
  extractLogoUrl,
  extractVenueName,
  packTo1Bit,
  invertedCopy,
  drawGameDayCard,
  toGrayscale,
  ditherAtkinson,
  ditheredLogoCanvas,
  fetchDitheredLogo,
  newsFeedUrl,
  parseRssHeadlines,
  fetchHeadlines,
  formatNewsFallbackText,
  truncateToWidth,
  drawNewsCard,
  formatShortDate,
  renderDynamicDesign,
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  LOGO_SIZE
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

  console.log("formatGameDateTime");
  await test("formats an ISO date in Eastern time, matching US broadcast convention", () => {
    // 2026-10-24 17:30Z = 1:30 PM ET (EDT, UTC-4) that day.
    const text = formatGameDateTime("2026-10-24T17:30Z");
    assert.strictEqual(text, "SAT OCT 24 · 1:30 PM ET");
  });
  await test("returns null for an unparseable date instead of showing garbage", () => {
    assert.strictEqual(formatGameDateTime("not-a-date"), null);
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

  console.log("drawGameDayCard");
  await test("draws a title banner, headline, and days label onto an otherwise-blank canvas", () => {
    const c = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
    const ctx = c.getContext("2d");
    drawGameDayCard(ctx, { headline: "ME VS OPP", daysLabel: "IN 3 DAYS", dateTimeLabel: null, venue: null, myLogo: null, oppLogo: null });
    const d = ctx.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT).data;
    let sawInk = false;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] < 250) { sawInk = true; break; }
    }
    assert.ok(sawInk, "expected the border/headline/days-label to leave some non-white pixels");
  });
  await test("draws provided logo canvases without throwing, and skips date/venue lines cleanly when absent", () => {
    const c = whiteCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
    const ctx = c.getContext("2d");
    const logo = ditheredLogoCanvas(whiteCanvas(20, 20), LOGO_SIZE);
    assert.doesNotThrow(() => {
      drawGameDayCard(ctx, {
        headline: "ME VS OPP", daysLabel: "TODAY!",
        dateTimeLabel: "SAT OCT 24 · 1:30 PM ET", venue: "Beaver Stadium",
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

  console.log("fetchHeadlines / formatNewsFallbackText");
  await test("fetchHeadlines throws on a non-ok response (caller should skip-and-retry, not clean up)", async () => {
    await assert.rejects(
      () => fetchHeadlines({ location: "Nowhere" }, 3, fakeFetchText("", false)),
      /RSS feed fetch failed/
    );
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
    assert.strictEqual(result.headlines.length, 3);
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
