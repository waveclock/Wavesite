// Pure rendering/packing logic for the daily "dynamic layer" regeneration
// job -- kept dependency-free (besides `canvas`) and separate from
// index.js so it can be unit-tested without a live Firebase project (see
// test/). Covers both dynamic-layer types published from design-v2:
// "countdown" (a target date) and "team" (a sports team's next game,
// rendered as a full "Game Day" card with logos when a game is found).
//
// IMPORTANT: daysUntil(), formatCountdownText(), formatTeamText(),
// findNextGame(), the dithering functions, and drawGameDayCard() are
// deliberately duplicated (not shared via a build step) in
// design-v2/index.html, which is the browser-side code that first
// renders/previews this same content at publish time. If any of these
// change here, they must change there too, or what a customer previewed
// at publish time won't match what the board shows once this job
// redraws it.
"use strict";

const { createCanvas, loadImage, registerFont } = require("canvas");
const path = require("path");

// Node's built-in fetch() has its OWN default headers when none are
// given -- verified directly (a local Node server, hit with a bare
// fetch(url), logging exactly what arrived): it sends
// "user-agent: node" and "accept-language: *". Neither is something any
// real browser has ever sent; "user-agent: node" in particular is about
// as plain a "this is a script" signal as exists, and is a common,
// basic thing for a site/CDN to block on by default -- no sophisticated
// fingerprinting required. An EARLIER attempt at this fix (adding a fake
// Chrome User-Agent) didn't help, and was then removed entirely on the
// theory that a mismatched fake-browser header was worse than sending
// none -- but "sending none" was never actually tested: Node's own
// defaults were still there the whole time, unexamined. `Accept` is left
// alone here since Node's own default ("*/*") already matches what a
// real browser's fetch() sends by default too -- that one was never the
// problem.
const OUTBOUND_FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9"
};

const CANVAS_WIDTH = 792;
const CANVAS_HEIGHT = 272;
const BIT_THRESHOLD = 180;
const LOGO_SIZE = 175;
const LOGO_MARGIN = 28;
// Both full-screen cards (Game Day, News) use a solid black title banner
// with white block-letter text instead of a drawn border -- the board's
// own physical bezel already frames the display, so a second drawn
// border was redundant.
const BANNER_HEIGHT = 48;

// fontKey (stored in designs/{id}-dynamic.json, set by the "Serif" /
// "Block" / "Pixel" buttons in design-v2's Countdown tool) -> the family
// name registered below. Kept as a stable short key rather than storing a
// raw CSS font-family string, since browser font-family syntax ("'Bungee',
// sans-serif") isn't what registerFont() needs here. The Game Day card
// (Team tool) doesn't use fontKey at all -- it's a fixed layout, always
// Block for the headline and Serif for everything else, matching the
// approved mockup.
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
// relied on by community tooling; the events/competitors/date/homeAway
// fields below ARE confirmed against live responses -- logo and venue
// field names are NOT, hence extractLogoUrl/extractVenueName trying a
// few plausible shapes and degrading to null rather than guessing wrong):
//   { events: [ { date: "2026-09-14T17:00Z", competitions: [ { venue: {...}, competitors: [
//       { homeAway: "home"|"away", team: { id, abbreviation, shortDisplayName, logo, logos } },
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

// Same 5 sport/league pairs design-v2's League dropdown offers (and
// ALLOWED_LEAGUES in index.js whitelists) -- used only for the Game Day
// card's banner title ("COLLEGE FOOTBALL GAME DAY" reads as a real
// section header; a bare "NEXT GAME" didn't feel like a hero title). An
// unmapped pair (shouldn't happen, since both sides share this list) just
// falls back to a bare "GAME DAY" rather than showing nothing.
const LEAGUE_DISPLAY_NAME = {
  "football/nfl": "NFL",
  "football/college-football": "COLLEGE FOOTBALL",
  "basketball/nba": "NBA",
  "baseball/mlb": "MLB",
  "hockey/nhl": "NHL"
};

function gameDayBannerTitle(sport, league) {
  const name = LEAGUE_DISPLAY_NAME[sport + "/" + league];
  return name ? name + " GAME DAY" : "GAME DAY";
}

// Unverified field names (see comment above) -- tries the shapes seen in
// ESPN's teams-list responses (a "logos" array of {href}) and a simpler
// possible "logo" string, falls back to null (no logo drawn) rather than
// guessing wrong and breaking image loading.
function extractLogoUrl(team) {
  if (!team) return null;
  if (typeof team.logo === "string" && team.logo) return team.logo;
  if (Array.isArray(team.logos) && team.logos[0] && team.logos[0].href) return team.logos[0].href;
  return null;
}

function extractVenueName(comp) {
  const v = comp && comp.venue;
  if (!v) return null;
  return v.fullName || v.name || null;
}

// Finds the earliest event whose calendar date is today-or-later. Returns
// { nextGame: {...} | null, myAbbrev, myLogo }. myAbbrev/myLogo are
// captured from ANY event that includes this team -- even a past one --
// specifically so a genuinely-empty upcoming schedule can still be
// labeled with the team's own name instead of a bare, unattributed
// message. nextGame being null is a real, steady-state off-season case,
// NOT an error -- callers should render it normally, not treat it as a
// failure. Throws only on an actual fetch/parse failure, which callers
// should treat as "try again next run," not "the season is over."
async function findNextGame(events, teamId, now) {
  const at = now || new Date();
  const todayUTC = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  let best = null;
  let myAbbrev = null;
  let myLogo = null;
  for (const ev of events || []) {
    if (!ev) continue;
    const comp = ev.competitions && ev.competitions[0];
    const competitors = comp && comp.competitors;
    if (!competitors) continue;
    const me = competitors.find((c) => c && c.team && String(c.team.id) === String(teamId));
    if (!me) continue;
    if (!myAbbrev) {
      // shortDisplayName ("Marshall", "Eagles") first, NOT abbreviation
      // ("MRSH", "PHI") -- confirmed live: the raw ESPN triCode reads as
      // cryptic on the actual card ("PSU VS MRSH"), where a real team name
      // doesn't need any explanation. abbreviation is still the fallback
      // for a team whose shortDisplayName ESPN doesn't provide.
      myAbbrev = (me.team.shortDisplayName || me.team.abbreviation || me.team.displayName || "").toUpperCase() || null;
    }
    if (!myLogo) myLogo = extractLogoUrl(me.team);

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
        opponentAbbrev: (opp.team.shortDisplayName || opp.team.abbreviation || opp.team.displayName || "TBD").toUpperCase(),
        opponentLogo: extractLogoUrl(opp.team),
        venue: extractVenueName(comp),
        gameDateISO: ev.date
      };
    }
  }
  return { nextGame: best, myAbbrev, myLogo };
}

// `fetchImpl` is injectable so tests never make a real network call --
// defaults to the platform global (Node 20's built-in fetch in the actual
// Cloud Function, or a browser's fetch in design-v2).
//
// Deliberately NOT sending OUTBOUND_FETCH_HEADERS here -- this endpoint
// is currently working live without it (headers were tried, then pulled
// off again, then it started working -- see the README timeline), so
// leaving it alone rather than risking a currently-working path while
// fixing a different, still-broken one (the RSS fetch below).
async function fetchNextGame(sport, league, teamId, now, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const resp = await doFetch(espnScheduleUrl(sport, league, teamId));
  if (!resp.ok) throw new Error("ESPN schedule fetch failed: " + resp.status);
  const data = await resp.json();
  return findNextGame(data.events, teamId, now);
}

// Plain single-line fallback -- used for the off-season case (no card,
// nothing to show logos/date/venue for) and kept around as the simplest
// possible rendering of a game.
function formatTeamText(nextGame, myAbbrev) {
  if (!nextGame) return myAbbrev ? myAbbrev + ": NO UPCOMING GAMES" : "NO UPCOMING GAMES";
  const prefix = myAbbrev ? myAbbrev + " " : "";
  const vsOrAt = nextGame.homeAway === "home" ? "VS" : "@";
  const daysLeft = nextGame.daysLeft;
  if (daysLeft <= 0) return prefix + vsOrAt + " " + nextGame.opponentAbbrev + " TODAY!";
  const unit = daysLeft === 1 ? "DAY" : "DAYS";
  return prefix + vsOrAt + " " + nextGame.opponentAbbrev + " IN " + daysLeft + " " + unit;
}

// "SAT SEP 5 · 3:30 PM ET" -- the card's edge-to-edge bottom line.
// Venue is deliberately NOT part of this -- it gets its own larger,
// centered line under the days-count instead (see drawGameDayCard),
// since a stadium name deserves more visual weight than a corner of a
// packed date/time line. Always Eastern time regardless of the device's
// own location, matching how US sports broadcasts/schedules
// conventionally list game times. Returns null on an unparseable date
// rather than showing garbage text.
function formatGameDateTime(isoString) {
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true
  }).formatToParts(d);
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || "";
  const weekday = get("weekday").toUpperCase();
  const month = get("month").toUpperCase();
  const day = get("day");
  const hour = get("hour");
  const minute = get("minute");
  const dayPeriod = get("dayPeriod").toUpperCase();
  if (!weekday || !month || !day || !hour || !minute) return null;
  return weekday + " " + month + " " + day + " · " + hour + ":" + minute + " " + dayPeriod + " ET";
}

// ================= News (RSS) type =================
//
// Unlike Countdown/Team, there's no single API that covers "news for any
// US town" -- so rather than maintaining a hand-picked feed per town (or
// even per state, which still wouldn't be genuinely local), the customer
// gives us EITHER a free-text location (we build a Google News RSS search
// URL from it, which works for essentially any place name) OR pastes a
// specific RSS feed URL of their own choosing (their local paper's,
// a Patch.com town feed, whatever) which overrides the location search.
// This is the same "give people the input, don't hardcode a lookup table
// we can't maintain" tradeoff, just resolved differently than ESPN's
// team-id lookup was.
//
// NEITHER of these has been confirmed against a live response the way
// ESPN's schedule shape was (see fetchNextGame's comment) -- this needs
// the same kind of live smoke test ESPN did (paste a real response back)
// before trusting it fully in production.

const GOOGLE_NEWS_RSS_BASE = "https://news.google.com/rss/search";
const MAX_NEWS_HEADLINES = 3; // as many as fit on one card at a legible size, see drawNewsCard

// meta.feedUrl is a URL the CUSTOMER types in, then this server fetches
// -- a textbook SSRF shape. The real-world risk that matters here isn't
// "reach some other website" (fetch() only ever speaks http/https, and
// there's nothing sensitive on the open Internet this function has that
// the customer doesn't already have), it's this Cloud Function reaching
// somewhere on Google Cloud's INTERNAL network that trusts requests
// simply for originating from inside it -- most importantly
// 169.254.169.254, the instance metadata endpoint, which can hand back
// this function's own service-account access token to whoever's able to
// make it issue that request. Blocking link-local/private-range IP
// literals closes that off. What this does NOT close off: a hostname
// (not an IP literal) whose DNS only resolves to a private IP at fetch
// time, after this check already passed ("DNS rebinding") -- doing that
// properly means resolving DNS here ourselves and pinning the checked IP
// for the actual request, which isn't implemented yet.
function isPrivateOrLinkLocalHostname(hostname) {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "0.0.0.0" || h === "::1" || h === "[::1]") return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]);
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata (169.254.169.254)
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT range, sometimes used internally
  return false;
}

function isSafeFetchUrl(urlString) {
  let u;
  try {
    u = new URL(urlString);
  } catch (err) {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (isPrivateOrLinkLocalHostname(u.hostname)) return false;
  return true;
}

// Builds the Google News RSS search URL for a free-text location, unless
// the customer pasted a specific feed URL of their own (which always
// wins, but ONLY if it passes isSafeFetchUrl -- an unsafe custom URL is
// treated the same as no custom URL at all, falling back to the location
// search, rather than fetching it anyway or hard-failing the card).
// encodeURIComponent handles the query string; hl/gl/ceid pin the
// results to US English, matching "any US beach town."
function newsFeedUrl(meta) {
  if (meta.feedUrl && isSafeFetchUrl(meta.feedUrl)) return meta.feedUrl;
  const q = encodeURIComponent(meta.location || "");
  return GOOGLE_NEWS_RSS_BASE + "?q=" + q + "&hl=en-US&gl=US&ceid=US:en";
}

// Just enough entity decoding for what actually shows up in real-world
// RSS titles -- not a general XML/HTML entity decoder.
function decodeXmlEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

// Google News RSS (and most other news feeds) format every title as
// "Headline text - Source Name" -- on a card this narrow, that trailing
// attribution eats into the one line a headline gets before
// truncateToWidth ellipsizes it, at the expense of the actual headline
// (confirmed live: e.g. "Wildwood Beach Patrol in Wildwood, New
// Jersey,..." was cut off well before the real news, with the source
// name is what got dropped instead). Only strips the LAST " - " split,
// and only if that leaves real text before it, so a hyphen that's
// actually part of the headline (rare, but possible near the end)
// doesn't get mistaken for the separator and eaten too.
function stripFeedSource(title) {
  const idx = title.lastIndexOf(" - ");
  if (idx <= 0) return title;
  return title.slice(0, idx);
}

// Dependency-free RSS 2.0 item/title extractor -- deliberately NOT a
// general XML parser (no dependency for this exists in functions/
// package.json, and RSS's <item>/<title> shape is simple and stable
// enough not to need one). Handles both CDATA-wrapped and plain-encoded
// titles, the two forms real-world feeds actually use. Skips any <item>
// with no title rather than surfacing an empty/garbled headline.
function parseRssHeadlines(xmlText, maxItems) {
  const headlines = [];
  const itemRe = /<item\b[\s\S]*?<\/item>/gi;
  const titleRe = /<title\b[^>]*>([\s\S]*?)<\/title>/i;
  const cdataRe = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/;
  const items = xmlText.match(itemRe) || [];
  for (const item of items) {
    if (headlines.length >= maxItems) break;
    const titleMatch = item.match(titleRe);
    if (!titleMatch) continue;
    const raw = titleMatch[1];
    const cdataMatch = raw.match(cdataRe);
    const decoded = decodeXmlEntities((cdataMatch ? cdataMatch[1] : raw).trim());
    if (decoded) headlines.push(stripFeedSource(decoded));
  }
  return headlines;
}

// `fetchImpl` is injectable so tests never make a real network call, same
// convention as fetchNextGame. Throws on a non-ok response so the caller
// treats it as "try again on the next scheduled run," not "no news" --
// same reasoning as a failed ESPN fetch.
async function fetchHeadlines(meta, maxItems, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const resp = await doFetch(newsFeedUrl(meta), { headers: OUTBOUND_FETCH_HEADERS });
  if (!resp.ok) throw new Error("RSS feed fetch failed: " + resp.status);
  const xmlText = await resp.text();
  return parseRssHeadlines(xmlText, maxItems);
}

function formatNewsFallbackText(meta) {
  const label = (meta.location || "").trim().toUpperCase();
  return label ? label + ": NO HEADLINES FOUND" : "NO HEADLINES FOUND";
}

// Steps the font size down (never truncating -- a banner title reads
// worse cut off than shrunk) until `text` fits maxWidth at family/weight,
// stopping at minSize even if it still doesn't quite fit. Used for both
// cards' banner titles, which vary a lot in length ("NFL GAME DAY" vs.
// "COLLEGE FOOTBALL GAME DAY", or a customer's own free-text location).
function fitBannerFontSize(ctx, text, maxWidth, family, maxSize, minSize) {
  for (let size = maxSize; size > minSize; size--) {
    ctx.font = size + "px \"" + family + "\"";
    if (ctx.measureText(text).width <= maxWidth) return size;
  }
  ctx.font = minSize + "px \"" + family + "\"";
  return minSize;
}

// Shrinks `text` (appending an ellipsis) until it fits maxWidth at ctx's
// current font -- headlines are free text of unbounded length, unlike
// everything else drawn on this display so far.
function truncateToWidth(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 0 && ctx.measureText(t + "…").width > maxWidth) {
    t = t.slice(0, -1);
  }
  return t + "…";
}

// Full-screen layout: solid black title banner ("{LOCATION} NEWS" in
// white block letters, or a bare "NEWS" if the customer used a custom
// feed URL with no location text -- no drawn border, the board's own
// bezel frames it), up to 3 bulleted headlines truncated to fit one line
// each, and a small "UPDATED {DATE}" footer -- mirrors drawGameDayCard.
function drawNewsCard(ctx, card) {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, CANVAS_WIDTH, BANNER_HEIGHT);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  const kicker = card.headerLabel ? card.headerLabel.toUpperCase() + " NEWS" : "NEWS";
  const kickerSize = fitBannerFontSize(ctx, kicker, CANVAS_WIDTH - 40, FONT_FAMILY.block, 22, 14);
  ctx.fillText(kicker, CANVAS_WIDTH / 2, BANNER_HEIGHT / 2 + Math.round(kickerSize * 0.35));

  ctx.fillStyle = "#000";
  const leftX = 34;
  const maxTextWidth = CANVAS_WIDTH - 34 - 34;
  let y = BANNER_HEIGHT + 40;
  const lineGap = 54;
  ctx.textAlign = "left";
  card.headlines.forEach((headline) => {
    ctx.font = "bold 26px \"" + FONT_FAMILY.serif + "\"";
    const bullet = "•  ";
    const bulletWidth = ctx.measureText(bullet).width;
    ctx.fillText(bullet, leftX, y);
    ctx.fillText(truncateToWidth(ctx, headline, maxTextWidth - bulletWidth), leftX + bulletWidth, y);
    y += lineGap;
  });

  if (card.updatedLabel) {
    ctx.textAlign = "right";
    ctx.font = "italic 16px \"" + FONT_FAMILY.serif + "\"";
    ctx.fillText(card.updatedLabel, CANVAS_WIDTH - 24, CANVAS_HEIGHT - 14);
  }
}

// "AUG 19" -- short enough for the card's footer corner.
function formatShortDate(now) {
  const at = now || new Date();
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" })
    .format(at)
    .toUpperCase();
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

// ================= Logo dithering =================
// Same Atkinson dither used by design-v2's "Normal Photo" tool (see
// stageDither/ditherAtkinson there) -- team logos are photo-like assets
// (gradients, fine detail, color-only contrast) that don't survive a
// naive black/white threshold, same reasoning as why photos get dithered
// instead of thresholded.

function toGrayscale(imgData, width, height) {
  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = imgData[i * 4], g = imgData[i * 4 + 1], b = imgData[i * 4 + 2];
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return gray;
}

function ditherAtkinson(gray, width, height) {
  const buf = Float32Array.from(gray);
  const bits = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const oldVal = buf[i];
      const newVal = oldVal < 128 ? 0 : 255;
      bits[i] = newVal === 0 ? 1 : 0;
      const err = (oldVal - newVal) / 8;
      if (x + 1 < width) buf[i + 1] += err;
      if (x + 2 < width) buf[i + 2] += err;
      if (y + 1 < height) {
        if (x > 0) buf[i + width - 1] += err;
        buf[i + width] += err;
        if (x + 1 < width) buf[i + width + 1] += err;
      }
      if (y + 2 < height) buf[i + 2 * width] += err;
    }
  }
  return bits;
}

// Pads sourceImage onto a white size x size square (preserving aspect
// ratio, same as design-v2 does for clip art) and dithers it. Returns an
// opaque white/black canvas -- unlike the client's version (which keeps
// ink-only pixels transparent so it can be layered over other content),
// this one doesn't need transparency since it's drawn directly onto the
// Game Day card's already-white background.
function ditheredLogoCanvas(sourceImage, size) {
  const padded = createCanvas(size, size);
  const pctx = padded.getContext("2d");
  pctx.fillStyle = "#fff";
  pctx.fillRect(0, 0, size, size);
  const pad = size * 0.08;
  const scale = Math.min((size - pad * 2) / sourceImage.width, (size - pad * 2) / sourceImage.height);
  const w = sourceImage.width * scale, h = sourceImage.height * scale;
  pctx.drawImage(sourceImage, (size - w) / 2, (size - h) / 2, w, h);

  const imgData = pctx.getImageData(0, 0, size, size).data;
  const gray = toGrayscale(imgData, size, size);
  const bits = ditherAtkinson(gray, size, size);

  const out = createCanvas(size, size);
  const octx = out.getContext("2d");
  const id = octx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const on = !!bits[i];
    const v = on ? 0 : 255;
    id.data[i * 4] = v; id.data[i * 4 + 1] = v; id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255;
  }
  octx.putImageData(id, 0, 0);
  return out;
}

// Fetches + dithers one team logo. Returns null on ANY failure (missing
// URL, network error, bad status, decode error) -- a broken/missing logo
// should never take down the whole card, just leave that side blank
// rather than showing a broken-image glyph or throwing.
async function fetchDitheredLogo(url, size, fetchImpl) {
  if (!url) return null;
  try {
    const doFetch = fetchImpl || fetch;
    const resp = await doFetch(url, { headers: OUTBOUND_FETCH_HEADERS });
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    const img = await loadImage(buf);
    return ditheredLogoCanvas(img, size);
  } catch (err) {
    return null;
  }
}

// ================= Game Day card =================
// Full-screen layout -- NOT a positioned stamp like drawDynamicText.
// meta.x/y/size/fontKey/outline don't apply here; the card always fills
// the whole canvas at fixed positions. No drawn border -- the board's own
// bezel already frames the display, so the banner alone marks the top
// instead. Four vertical bands, top to bottom:
//   1. banner: solid black, white block-letter league title (unchanged)
//   2. headline: "TEAM VS TEAM", edge-to-edge, auto-shrunk to fit --
//      moved up here (out of the logos' row) specifically so it isn't
//      squeezed into the gap between them and doesn't need abbreviating
//      to fit; long full team names ("PENN STATE VS MARSHALL") are the
//      normal case, not the exception.
//   3. logos either side + the days-left count between them, split
//      across 3 lines (IN / {number} / DAY(S)) with the number in a very
//      large font -- this is the card's single most important fact, so
//      it gets the most visual weight, sized to whatever room is left
//      between the logos rather than a fixed width.
//   4. gameLine: date + venue + kickoff time, edge-to-edge, auto-shrunk
//      to fit, one line instead of two stacked centered ones.
// Missing optional fields (no logo found, no gameLine because the date
// was unparseable or ESPN gave no venue) are simply skipped rather than
// leaving a gap or showing "undefined".
function drawGameDayCard(ctx, card) {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, CANVAS_WIDTH, BANNER_HEIGHT);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  const bannerTitle = card.bannerTitle || "GAME DAY";
  const bannerSize = fitBannerFontSize(ctx, bannerTitle, CANVAS_WIDTH - 40, FONT_FAMILY.block, 24, 14);
  ctx.fillText(bannerTitle, CANVAS_WIDTH / 2, BANNER_HEIGHT / 2 + Math.round(bannerSize * 0.35));

  ctx.fillStyle = "#000";
  // Tucked in tight under the banner (not vertically centered in its own
  // band, like the banner title is) -- the logos are back to their full
  // 175px size, which leaves very little clearance above them, so this
  // needs to sit as high as it can rather than claiming a fixed-height
  // band of its own.
  const headlineSize = fitBannerFontSize(ctx, card.headline, CANVAS_WIDTH - 40, FONT_FAMILY.block, 24, 16);
  ctx.fillText(card.headline, CANVAS_WIDTH / 2, BANNER_HEIGHT + 4 + headlineSize);

  const bodyMidY = BANNER_HEIGHT + (CANVAS_HEIGHT - BANNER_HEIGHT) / 2;
  if (card.myLogo) ctx.drawImage(card.myLogo, LOGO_MARGIN, bodyMidY - LOGO_SIZE / 2, LOGO_SIZE, LOGO_SIZE);
  if (card.oppLogo) ctx.drawImage(card.oppLogo, CANVAS_WIDTH - LOGO_MARGIN - LOGO_SIZE, bodyMidY - LOGO_SIZE / 2, LOGO_SIZE, LOGO_SIZE);

  // Constrained to the gap BETWEEN the logos, not the full card width --
  // unlike the headline/gameLine bands above/below, this (and the venue
  // line below it) needs to stay clear of the logos on either side.
  const daysMaxWidth = CANVAS_WIDTH - 2 * (LOGO_MARGIN + LOGO_SIZE) - 20;
  if (card.daysLeft <= 0) {
    const size = fitBannerFontSize(ctx, "TODAY!", daysMaxWidth, FONT_FAMILY.block, 56, 26);
    ctx.fillText("TODAY!", CANVAS_WIDTH / 2, bodyMidY - 6 + Math.round(size * 0.35));
  } else {
    ctx.font = "bold 20px \"" + FONT_FAMILY.serif + "\"";
    ctx.fillText("IN", CANVAS_WIDTH / 2, bodyMidY - 60);

    const numberText = String(card.daysLeft);
    const numberSize = fitBannerFontSize(ctx, numberText, daysMaxWidth, FONT_FAMILY.block, 92, 40);
    ctx.font = numberSize + "px \"" + FONT_FAMILY.block + "\"";
    ctx.fillText(numberText, CANVAS_WIDTH / 2, bodyMidY - 6 + Math.round(numberSize * 0.34));

    ctx.font = "bold 20px \"" + FONT_FAMILY.serif + "\"";
    ctx.fillText(card.daysUnit || "DAYS", CANVAS_WIDTH / 2, bodyMidY + 40);
  }

  // The venue, given more visual weight than a corner of the bottom
  // date/time line -- its own larger line, centered in the same
  // between-the-logos gap as the days-count directly above it.
  if (card.venue) {
    // Not bold -- fitBannerFontSize measures with the plain style, and
    // bold glyphs run wider than regular ones at the same size, so
    // drawing bold here could overrun the width it was just shrunk to
    // fit (same reasoning as the gameLine's italic note below).
    const venueSize = fitBannerFontSize(ctx, card.venue, daysMaxWidth, FONT_FAMILY.serif, 24, 14);
    ctx.font = venueSize + "px \"" + FONT_FAMILY.serif + "\"";
    ctx.fillText(card.venue, CANVAS_WIDTH / 2, bodyMidY + 68);
  }

  if (card.gameLine) {
    ctx.fillStyle = "#000";
    // Not italic -- fitBannerFontSize measures with the plain style, and
    // italic glyphs run slightly wider than upright ones at the same
    // size, so drawing italic here could overrun the width it was just
    // shrunk to fit.
    const gameLineSize = fitBannerFontSize(ctx, card.gameLine, CANVAS_WIDTH - 48, FONT_FAMILY.serif, 20, 13);
    ctx.font = "bold " + gameLineSize + "px \"" + FONT_FAMILY.serif + "\"";
    ctx.fillText(card.gameLine, CANVAS_WIDTH / 2, CANVAS_HEIGHT - 14);
  }
}

async function compositeAndPack(basePngBuffer, drawFn, meta) {
  const baseImage = await loadImage(basePngBuffer);
  const composite = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
  const ctx = composite.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  ctx.drawImage(baseImage, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  drawFn(ctx);

  const binBuffer = packTo1Bit(composite, !!meta.inverted);
  const previewCanvas = meta.inverted ? invertedCopy(composite) : composite;
  const pngBuffer = previewCanvas.toBuffer("image/png");
  return { binBuffer, pngBuffer };
}

// Builds the finished .bin + .png for one device from its base.png buffer
// and dynamic.json metadata, for the given "now".
//
// Returns null ONLY for a countdown whose target date has passed --
// callers should treat that as "this dynamic layer has concluded, clean
// it up and stop touching this device" (see index.js).
//
// Throws on a genuine failure (bad meta.type, or -- for "team" -- an ESPN
// schedule fetch/parse error; a failed LOGO fetch does NOT throw, see
// fetchDitheredLogo). Callers should treat a throw as "leave the device
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
    const result = await compositeAndPack(basePngBuffer, (ctx) => drawDynamicText(ctx, content, meta), meta);
    return Object.assign(result, { daysLeft, content });
  }

  if (meta.type === "team") {
    const { nextGame: rawNextGame, myAbbrev, myLogo: myLogoUrl } = await fetchNextGame(meta.sport, meta.league, meta.teamId, now, fetchImpl);

    if (!rawNextGame) {
      // Off-season: no game to build a card around -- fall back to the
      // simple centered message rather than an empty/broken-looking card.
      const content = formatTeamText(null, myAbbrev);
      const result = await compositeAndPack(basePngBuffer, (ctx) => drawDynamicText(ctx, content, meta), meta);
      return Object.assign(result, { nextGame: null, myAbbrev, content });
    }

    const at = now || new Date();
    const todayUTC = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
    const daysLeft = Math.round((rawNextGame.dayUTC - todayUTC) / 86400000);
    const vsOrAt = rawNextGame.homeAway === "home" ? "VS" : "@";

    const [myLogoCanvas, oppLogoCanvas] = await Promise.all([
      fetchDitheredLogo(myLogoUrl, LOGO_SIZE, fetchImpl),
      fetchDitheredLogo(rawNextGame.opponentLogo, LOGO_SIZE, fetchImpl)
    ]);

    const headline = (myAbbrev || "") + " " + vsOrAt + " " + rawNextGame.opponentAbbrev;
    const daysUnit = daysLeft === 1 ? "DAY" : "DAYS";
    // Kept as one string purely for the log-friendly `content` field
    // below -- drawGameDayCard takes daysLeft/daysUnit directly instead
    // of a pre-formatted label, since it renders them as 3 separate lines
    // now, not one.
    const daysLabel = daysLeft <= 0 ? "TODAY!" : "IN " + daysLeft + " " + daysUnit;
    const card = {
      bannerTitle: gameDayBannerTitle(meta.sport, meta.league),
      headline,
      daysLeft,
      daysUnit,
      venue: rawNextGame.venue,
      gameLine: formatGameDateTime(rawNextGame.gameDateISO),
      myLogo: myLogoCanvas,
      oppLogo: oppLogoCanvas
    };

    const result = await compositeAndPack(basePngBuffer, (ctx) => drawGameDayCard(ctx, card), meta);
    const nextGame = Object.assign({}, rawNextGame, { daysLeft });
    return Object.assign(result, {
      nextGame, myAbbrev,
      content: headline + " " + daysLabel,
      hasMyLogo: !!myLogoCanvas, hasOppLogo: !!oppLogoCanvas
    });
  }

  if (meta.type === "news") {
    const headlines = await fetchHeadlines(meta, MAX_NEWS_HEADLINES, fetchImpl);

    if (headlines.length === 0) {
      // A feed that's reachable but empty (or every item is missing a
      // title) -- same "steady state, not an error" treatment as Team's
      // off-season case. A genuinely unreachable/broken feed throws above
      // instead, via fetchHeadlines, and is retried next run.
      const content = formatNewsFallbackText(meta);
      const result = await compositeAndPack(basePngBuffer, (ctx) => drawDynamicText(ctx, content, meta), meta);
      return Object.assign(result, { headlines: [], content });
    }

    const card = {
      headerLabel: meta.location || "",
      headlines,
      updatedLabel: "UPDATED " + formatShortDate(now)
    };
    const result = await compositeAndPack(basePngBuffer, (ctx) => drawNewsCard(ctx, card), meta);
    return Object.assign(result, { headlines, content: headlines.join(" | ") });
  }

  throw new Error("Unknown dynamic layer type: " + meta.type);
}

module.exports = {
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  LOGO_SIZE,
  FONT_FAMILY,
  OUTBOUND_FETCH_HEADERS,
  daysUntil,
  formatCountdownText,
  formatTeamText,
  formatGameDateTime,
  findNextGame,
  fetchNextGame,
  espnScheduleUrl,
  espnTeamsUrl,
  gameDayBannerTitle,
  extractLogoUrl,
  extractVenueName,
  packTo1Bit,
  invertedCopy,
  drawDynamicText,
  drawGameDayCard,
  toGrayscale,
  ditherAtkinson,
  ditheredLogoCanvas,
  fetchDitheredLogo,
  fitBannerFontSize,
  MAX_NEWS_HEADLINES,
  isPrivateOrLinkLocalHostname,
  isSafeFetchUrl,
  newsFeedUrl,
  parseRssHeadlines,
  fetchHeadlines,
  formatNewsFallbackText,
  truncateToWidth,
  drawNewsCard,
  formatShortDate,
  renderDynamicDesign,
  ensureFontsRegistered
};
