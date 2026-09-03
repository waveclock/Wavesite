"use strict";

// Exercises lib/beachflag.js with a stubbed fetch (no live 30a.com or
// NOAA/Open-Meteo call) -- see the header comment in lib/beachflag.js for
// why the real page couldn't be inspected live from this sandbox; these
// fixtures are built from an actual screenshot of the live page, not a
// guess at its markup.

const assert = require("assert");
const { createCanvas } = require("canvas");
const {
  stripHtml,
  parseBeachFlagText,
  fetchBeachFlagStatus,
  fetchBeachFlagCardData,
  beachFlagBannerTitle,
  drawBeachFlagCard
} = require("../lib/beachflag");
const dynamic = require("../lib/dynamic");
dynamic.ensureFontsRegistered();

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

// A rough approximation of the real page's markup around the flag status
// block, built from the actual rendered screenshot (heading + hazard
// paragraph + refresh timestamps), not the real HTML source -- this
// sandbox can't fetch 30a.com to confirm exact tag structure. stripHtml
// only depends on visible text surviving tag removal, so this is enough
// to test the text-level parser without claiming to mirror their DOM.
const SAMPLE_PAGE_HTML = `<!DOCTYPE html><html><body>
  <h1>CURRENT BEACH CONDITIONS</h1>
  <script>var x = "GREEN: ignored inside script";</script>
  <div class="flag-status">
    <h2>YELLOW: MEDIUM HAZARD</h2>
    <p>PURPLE: Marine Pests Present. Purple can also be used in context
    with other flags to indicate pest conditions.</p>
  </div>
  <p>Last Refreshed: 09/02/2026 6:05 pm CDT<br>Last Changed: 09/01/2026 10:49 am</p>
  <p>Seaside, Florida, United States</p>
</body></html>`;

function mockBeachFlagFetch(html) {
  return async (url) => {
    const u = new URL(url);
    if (u.hostname !== "30a.com") throw new Error("unexpected host in test: " + u.hostname);
    return { ok: true, status: 200, text: async () => html };
  };
}

// Routes by hostname so one fetchImpl covers 30a.com + NOAA + both
// Open-Meteo hosts for fetchBeachFlagCardData's combined fetch, mirroring
// astro.test.js's own mockAllApisFetch. Any other host throws.
function mockCombinedFetch({ html, noaa = {}, weatherHourly = null, marineHourly = null }) {
  return async (url) => {
    const u = new URL(url);
    if (u.hostname === "30a.com") return { ok: true, status: 200, text: async () => html };
    if (u.hostname === "api.tidesandcurrents.noaa.gov") {
      const interval = u.searchParams.get("interval");
      return { json: async () => ({ predictions: noaa[interval] || [] }) };
    }
    if (u.hostname === "api.open-meteo.com") {
      return { json: async () => ({ hourly: weatherHourly || { time: [] } }) };
    }
    if (u.hostname === "marine-api.open-meteo.com") {
      return { json: async () => ({ hourly: marineHourly || { time: [] } }) };
    }
    throw new Error("unexpected host in test: " + u.hostname);
  };
}

function whiteCanvas(w, h) {
  const c = createCanvas(w, h);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  return c;
}

function hasInkInRegion(canvas, x, y, w, h) {
  const data = canvas.getContext("2d").getImageData(x, y, w, h).data;
  for (let i = 0; i < data.length; i += 4) { if (data[i] < 200) return true; }
  return false;
}

(async () => {
  console.log("stripHtml");
  await test("removes tags, script/style blocks, and collapses whitespace", () => {
    const text = stripHtml(SAMPLE_PAGE_HTML);
    assert.ok(!text.includes("<"), "expected no HTML tags left: " + text);
    assert.ok(!text.includes("ignored inside script"), "expected <script> content to be stripped");
    assert.ok(text.includes("YELLOW: MEDIUM HAZARD"));
    assert.ok(!/\s{2,}/.test(text), "expected whitespace collapsed to single spaces");
  });

  console.log("parseBeachFlagText");
  await test("parses a single flag with no trailing period before the next field", () => {
    const r = parseBeachFlagText("GREEN: LOW HAZARD Last Refreshed: 09/03/2026 7:00 am CDT");
    assert.deepStrictEqual(r.flags, [{ color: "GREEN", label: "LOW HAZARD" }]);
    assert.strictEqual(r.lastRefreshedText, "09/03/2026 7:00 am CDT");
  });
  await test("parses two simultaneous flags (hazard color + purple marine-pest notice)", () => {
    const r = parseBeachFlagText(stripHtml(SAMPLE_PAGE_HTML));
    assert.deepStrictEqual(r.flags, [
      { color: "YELLOW", label: "MEDIUM HAZARD" },
      { color: "PURPLE", label: "Marine Pests Present" }
    ]);
  });
  await test("DOUBLE RED matches as one color, not RED with a dangling DOUBLE", () => {
    const r = parseBeachFlagText("DOUBLE RED: WATER CLOSED TO PUBLIC Last Refreshed: 09/03/2026 7:00 am CDT");
    assert.strictEqual(r.flags.length, 1);
    assert.strictEqual(r.flags[0].color, "DOUBLE RED");
  });
  await test("an N/A label is dropped rather than shown as a real hazard line", () => {
    const r = parseBeachFlagText("PURPLE: N/A Last Refreshed: 09/03/2026 7:00 am CDT");
    assert.strictEqual(r.flags.length, 0);
  });
  await test("no recognizable color word at all yields zero flags, not a false match", () => {
    const r = parseBeachFlagText("Beach conditions are currently being updated.");
    assert.strictEqual(r.flags.length, 0);
  });

  console.log("beachFlagBannerTitle");
  await test("joins multiple active colors with a plus sign", () => {
    assert.strictEqual(
      beachFlagBannerTitle([{ color: "YELLOW", label: "x" }, { color: "PURPLE", label: "y" }]),
      "YELLOW + PURPLE"
    );
  });
  await test("falls back to a generic title when nothing is flying", () => {
    assert.strictEqual(beachFlagBannerTitle([]), "BEACH FLAGS");
  });

  console.log("fetchBeachFlagStatus");
  await test("fetches and parses the real page shape end-to-end", async () => {
    const status = await fetchBeachFlagStatus(mockBeachFlagFetch(SAMPLE_PAGE_HTML));
    assert.strictEqual(status.flags.length, 2);
    assert.strictEqual(status.lastRefreshedText, "09/02/2026 6:05 pm CDT");
  });
  await test("a fetch failure throws -- flag status is the whole point of this card, never silently blank", async () => {
    await assert.rejects(() => fetchBeachFlagStatus(async () => ({ ok: false, status: 503 })));
  });
  await test("a page with no recognizable flag color throws rather than rendering an empty card", async () => {
    await assert.rejects(() => fetchBeachFlagStatus(mockBeachFlagFetch("<html><body>Site under maintenance.</body></html>")));
  });

  console.log("fetchBeachFlagCardData");
  await test("combines flag status with wave height / water temp from the same free tide pipeline", async () => {
    const now = new Date("2026-07-15T16:00:00Z");
    const fetchImpl = mockCombinedFetch({
      html: SAMPLE_PAGE_HTML,
      noaa: {
        h: [{ t: "2026-07-15 12:00", v: "2.00" }],
        hilo: [{ t: "2026-07-15 07:14", v: "0.60", type: "L" }, { t: "2026-07-15 13:22", v: "4.40", type: "H" }]
      },
      marineHourly: { time: ["2026-07-15T16:00"], wave_height: [1.5], wave_period: [7], sea_surface_temperature: [27.2] }
    });
    const data = await fetchBeachFlagCardData({ lat: 30.35, lon: -86.15, stationId: "8729210" }, now, fetchImpl);
    assert.strictEqual(data.flags.length, 2);
    assert.ok(data.waterTempF != null, "expected a water temp pulled from the tide pipeline");
    assert.strictEqual(data.ripRisk, "LOW", "1.5ft @ 7s is a calm, unremarkable swell reading");
  });
  await test("a tide-data hiccup degrades the stats row but does not fail the card -- the flag is the point, wave height is a bonus", async () => {
    const now = new Date("2026-07-15T16:00:00Z");
    const fetchImpl = async (url) => {
      const u = new URL(url);
      if (u.hostname === "30a.com") return { ok: true, status: 200, text: async () => SAMPLE_PAGE_HTML };
      throw new Error("NOAA/Open-Meteo unreachable");
    };
    const data = await fetchBeachFlagCardData({ lat: 30.35, lon: -86.15, stationId: "8729210" }, now, fetchImpl);
    assert.strictEqual(data.flags.length, 2);
    assert.strictEqual(data.swellHeightFt, null);
    assert.strictEqual(data.waterTempF, null);
    assert.strictEqual(data.ripRisk, null, "no swell reading means no risk estimate either, not a guess");
  });
  await test("skips the tide fetch entirely when no location is on the layer yet", async () => {
    const now = new Date("2026-07-15T16:00:00Z");
    const data = await fetchBeachFlagCardData({}, now, mockBeachFlagFetch(SAMPLE_PAGE_HTML));
    assert.strictEqual(data.flags.length, 2);
    assert.strictEqual(data.waterTempF, null);
    assert.strictEqual(data.townName, null, "no location means no townName either, not the caller's fallback");
  });
  await test("passes townName straight through from the caller -- it's never fetched here, just relayed", async () => {
    const now = new Date("2026-07-15T16:00:00Z");
    const data = await fetchBeachFlagCardData({ townName: "Santa Rosa Beach" }, now, mockBeachFlagFetch(SAMPLE_PAGE_HTML));
    assert.strictEqual(data.townName, "Santa Rosa Beach");
  });

  console.log("drawBeachFlagCard");
  await test("draws the banner headline and a flag icon without throwing", () => {
    const c = whiteCanvas(792, 272);
    drawBeachFlagCard(c.getContext("2d"), {
      flags: [{ color: "YELLOW", label: "MEDIUM HAZARD" }, { color: "PURPLE", label: "Marine Pests Present" }],
      lastRefreshedText: "09/02/2026 6:05 pm CDT",
      swellHeightFt: 1.5,
      waterTempF: 78
    });
    assert.ok(hasInkInRegion(c, 0, 0, 792, 48), "expected the black banner to be drawn");
    assert.ok(hasInkInRegion(c, 40, 60, 90, 60), "expected a flag icon to be drawn on the left");
  });
  await test("DOUBLE RED stacks two pennants without the color label overlapping the second flag", () => {
    const c = whiteCanvas(792, 272);
    drawBeachFlagCard(c.getContext("2d"), {
      flags: [{ color: "DOUBLE RED", label: "WATER CLOSED TO PUBLIC" }],
      lastRefreshedText: "09/03/2026 7:00 am CDT",
      swellHeightFt: 4.5,
      waterTempF: 79
    });
    // Measured directly off a real render (not derived from the layout
    // constants, which are easy to get subtly wrong by hand): the second
    // pennant's own ink ends by y=219, the "DOUBLE RED" label's glyph ink
    // doesn't start until y=233, so y=222..228 is genuine clear space
    // between them -- the pre-fix version had the label overlapping the
    // flag directly.
    const belowSecondFlag = c.getContext("2d").getImageData(60, 222, 60, 6).data;
    let allWhite = true;
    for (let i = 0; i < belowSecondFlag.length; i += 4) { if (belowSecondFlag[i] < 200) allWhite = false; }
    assert.ok(allWhite, "expected clear space between the stacked flags and their label, not overlapping ink");
  });
  await test("no active flags falls back to a green 'no advisory' card instead of an empty one", () => {
    const c = whiteCanvas(792, 272);
    drawBeachFlagCard(c.getContext("2d"), { flags: [], lastRefreshedText: null, swellHeightFt: null, waterTempF: null });
    assert.ok(hasInkInRegion(c, 40, 60, 90, 60), "expected a fallback flag icon even with zero active flags");
  });
  await test("townName and ripRisk both draw without overlapping the primary hazard label", () => {
    const c = whiteCanvas(792, 272);
    drawBeachFlagCard(c.getContext("2d"), {
      flags: [{ color: "YELLOW", label: "MEDIUM HAZARD" }],
      lastRefreshedText: "09/02/2026 6:05 pm CDT",
      townName: "Santa Rosa Beach",
      swellHeightFt: 4.5,
      waterTempF: 78,
      ripRisk: "HIGH"
    });
    assert.ok(hasInkInRegion(c, 340, 92, 160, 10), "expected the town name row to have ink");
    // Measured off a real render: the town name's own ink ends by y=105,
    // the primary hazard label's glyph ink doesn't start until y=117 --
    // y=106..116 is genuine clear space between them.
    const gapRow = c.getContext("2d").getImageData(340, 107, 160, 8).data;
    let allWhite = true;
    for (let i = 0; i < gapRow.length; i += 4) { if (gapRow[i] < 200) allWhite = false; }
    assert.ok(allWhite, "expected clear space between the town name and the primary hazard label");
    assert.ok(hasInkInRegion(c, 340, 233, 300, 18), "expected the stat line (including Rip Risk) to have ink");
  });

  console.log("\n" + passed + " passed, " + failed + " failed");
  if (failed > 0) process.exit(1);
})();
