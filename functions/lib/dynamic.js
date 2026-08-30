// Rendering/packing logic for the daily "dynamic layer" regeneration
// job -- kept separate from index.js so it can be unit-tested without a
// live Firebase project (see test/), with every real network call
// (ESPN, NOAA/Open-Meteo, Imagen) injectable so tests never need real
// credentials. Covers every dynamic-layer type published from design:
// "countdown" (a target date), "team" (a sports team's next game,
// rendered as a full "Game Day" card with logos when a game is found),
// "news", "tide", "tideTimeline", and "beachBuddy" (see the "Beach
// Buddy" section below -- a single recurring character whose pose is
// driven by real tide/weather data, illustrated by Imagen with a
// procedural vector-line fallback).
//
// IMPORTANT: daysUntil(), formatCountdownText(), formatTeamText(),
// findNextGame(), the dithering functions, and drawGameDayCard() are
// deliberately duplicated (not shared via a build step) in
// design/index.html, which is the browser-side code that first
// renders/previews this same content at publish time. If any of these
// change here, they must change there too, or what a customer previewed
// at publish time won't match what the board shows once this job
// redraws it.
"use strict";

const { createCanvas, loadImage, registerFont } = require("canvas");
const path = require("path");
const { fetchTideCardData, fetchTideTimelineData, formatLongDate } = require("./astro");
const { OUTBOUND_FETCH_HEADERS } = require("./http");
const { generateBeachBuddyArt } = require("./imagen");

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
// "Block" / "Pixel" buttons in design's Countdown tool) -> the family
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
// job covering devices nationwide -- see the design build notes for the
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

// The single-team detail endpoint -- distinct from espnTeamsUrl (the
// whole-league list, used for the picker dropdown) and espnScheduleUrl
// (this team's games, no record on it). This is the one that carries a
// team's current win-loss record, per the same kind of widely-documented
// community knowledge the rest of this ESPN integration is built on --
// NOT itself confirmed against a live response yet (see the Known
// tradeoffs note in the README).
function espnTeamUrl(sport, league, teamId) {
  return ESPN_BASE + "/" + sport + "/" + league + "/teams/" + teamId;
}

// Same sport/league pairs design's League dropdown offers (and
// ALLOWED_LEAGUES in index.js whitelists) -- used only for the Game Day
// card's banner title ("COLLEGE FOOTBALL GAME DAY" reads as a real
// section header; a bare "NEXT GAME" didn't feel like a hero title). An
// unmapped pair (shouldn't happen, since both sides share this list) just
// falls back to a bare "GAME DAY" rather than showing nothing.
const LEAGUE_DISPLAY_NAME = {
  "football/nfl": "NFL",
  "football/college-football": "COLLEGE FOOTBALL",
  "basketball/nba": "NBA",
  "basketball/womens-college-basketball": "WOMEN'S COLLEGE BASKETBALL",
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

// Unverified field name (see espnTeamUrl's comment) -- the single-team
// detail response's team.record.items is documented (community-wide) as
// an array of record breakdowns (overall/home/road/vs. conference, etc),
// each with its own "summary" string like "8-3". Prefers the entry
// explicitly typed "total" (the overall record, what a Game Day card
// actually wants); falls back to the first entry if none is typed that
// way, rather than assuming array order. Returns null on any shape
// mismatch instead of guessing wrong and showing a bogus record.
function extractRecordSummary(team) {
  const items = team && team.record && team.record.items;
  if (!Array.isArray(items) || items.length === 0) return null;
  const total = items.find((it) => it && it.type === "total");
  const chosen = total || items[0];
  return (chosen && typeof chosen.summary === "string" && chosen.summary) || null;
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
        opponentTeamId: opp.team.id != null ? String(opp.team.id) : null,
        venue: extractVenueName(comp),
        gameDateISO: ev.date
      };
    }
  }
  return { nextGame: best, myAbbrev, myLogo };
}

// `fetchImpl` is injectable so tests never make a real network call --
// defaults to the platform global (Node 20's built-in fetch in the actual
// Cloud Function, or a browser's fetch in design).
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

// A team's win-loss record is a nice-to-have on the Game Day card, not
// load-bearing -- degrades to null on ANY failure (missing teamId,
// network error, bad status, unexpected shape) rather than throwing,
// same contract as fetchDitheredLogo. A missing record just means that
// side's record doesn't render; it should never take down the whole
// card the way a genuine schedule-fetch failure does.
async function fetchTeamRecord(sport, league, teamId, fetchImpl) {
  if (!teamId) return null;
  try {
    const doFetch = fetchImpl || fetch;
    const resp = await doFetch(espnTeamUrl(sport, league, teamId));
    if (!resp.ok) return null;
    const data = await resp.json();
    return extractRecordSummary(data && data.team);
  } catch (err) {
    return null;
  }
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

// Splits the weekday+date and kickoff time into two separate strings
// (instead of one joined line) so the card's bottom line can draw the
// venue at a larger font size IN BETWEEN them, sharing one baseline --
// see drawGameLine below. Always Eastern time regardless of the device's
// own location, matching how US sports broadcasts/schedules
// conventionally list game times. Returns null on an unparseable date
// rather than showing garbage text.
function formatGameDateTimeParts(isoString) {
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
  return {
    dateLabel: weekday + " " + month + " " + day,
    timeLabel: hour + ":" + minute + " " + dayPeriod + " ET"
  };
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
const MAX_NEWS_HEADLINES = 2; // each gets up to 2 wrapped lines rather than 1 truncated one, see drawNewsCard

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
//
// Deliberately NOT sending OUTBOUND_FETCH_HEADERS here, matching
// fetchNextGame/espnProxyHandler's teams/schedule fetch below -- this is
// a deliberate experiment, not a proven fix: confirmed live, Google News
// and NPR both went back to 503/403-blocking this fetch even WITH a
// realistic browser User-Agent, while ESPN's headerless fetch keeps
// working the whole time. This does NOT contradict the earlier fix
// (removing the header once already made things worse, because Node's
// own un-set-header defaults -- "User-Agent: node" -- are a worse bot
// signal than a real one) -- that finding was about Node's defaults
// specifically being bad, not about headers being unnecessary in
// general. Whether removing the header again helps THIS block is
// unconfirmed; it's worth trying because it now matches the one thing
// in this file that's demonstrably still working, not because the
// underlying cause is understood.
async function fetchHeadlines(meta, maxItems, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const resp = await doFetch(newsFeedUrl(meta));
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

// Wraps `text` into at most maxLines lines that each fit maxWidth at
// ctx's current font, breaking at word boundaries -- unlike
// truncateToWidth, which always cuts to a single line, this is for
// headlines that now get real room to breathe (2 headlines instead of 3,
// see MAX_NEWS_HEADLINES) rather than being squeezed onto one line each.
// If the text still doesn't fit after maxLines lines, the leftover words
// are folded into the last line and THAT line is truncated with an
// ellipsis (via truncateToWidth) -- so a very long headline degrades the
// same familiar way, just after more of it has already been shown.
function wrapToLines(ctx, text, maxWidth, maxLines) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? current + " " + word : word;
    if (current && ctx.measureText(candidate).width > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);

  if (lines.length <= maxLines) return lines;

  const kept = lines.slice(0, maxLines - 1);
  const rest = lines.slice(maxLines - 1).join(" ");
  kept.push(truncateToWidth(ctx, rest, maxWidth));
  return kept;
}

// Full-screen layout: solid black title banner ("{LOCATION} NEWS" in
// white block letters, or a bare "NEWS" if the customer used a custom
// feed URL with no location text -- no drawn border, the board's own
// bezel frames it), up to 2 bulleted headlines -- each word-wrapped
// across up to 2 lines rather than truncated to 1, so a headline reads
// in full far more often -- and a small "UPDATED {DATE}" footer --
// mirrors drawGameDayCard.
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
  const lineGap = 32;
  const headlineGap = 16;
  ctx.textAlign = "left";
  card.headlines.forEach((headline) => {
    ctx.font = "bold 26px \"" + FONT_FAMILY.serif + "\"";
    const bullet = "•  ";
    const bulletWidth = ctx.measureText(bullet).width;
    const lines = wrapToLines(ctx, headline, maxTextWidth - bulletWidth, 2);
    lines.forEach((line, i) => {
      if (i === 0) ctx.fillText(bullet, leftX, y);
      ctx.fillText(line, leftX + bulletWidth, y);
      y += lineGap;
    });
    y += headlineGap;
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

// Mirrors design/index.html's packTo1Bit exactly: row-major, MSB-first
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
// PREVIEW png in design/index.html -- a plain per-channel 255-v, alpha
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
// Same Atkinson dither used by design's "Normal Photo" tool (see
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
// ratio, same as design does for clip art) and dithers it. Returns an
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

// Draws one edge-to-edge line -- dateLabel, then venue (if given) at a
// LARGER size than the rest, then timeLabel -- all sharing one baseline,
// the way a normal typographic mixed-size line works ("10€" with a
// bigger currency mark, still baseline-aligned). fitBannerFontSize can't
// do this: it only ever measures one string at one size. So this shrinks
// dateSize and venueSize together, in lockstep (keeping venue
// VENUE_SIZE_BOOST px larger than the rest), re-measuring the WHOLE
// assembled line each step, until it fits maxWidth or dateSize hits
// MIN_DATE_SIZE -- same "shrink everything together, never truncate"
// contract as fitBannerFontSize, just for 3 segments glued together
// instead of 1. Skips venue (2 segments, not 3) when there isn't one,
// e.g. an ESPN response with no venue field.
const VENUE_SIZE_BOOST = 6;
const MIN_DATE_SIZE = 13;
function drawGameLine(ctx, dateLabel, venue, timeLabel, maxWidth, y) {
  const family = FONT_FAMILY.serif;
  const sep = "  ·  ";
  let dateSize = 20;
  let venueSize, totalWidth, sepWidth, dateWidth, venueWidth, timeWidth;
  for (;;) {
    venueSize = dateSize + VENUE_SIZE_BOOST;
    ctx.font = "bold " + dateSize + "px \"" + family + "\"";
    sepWidth = ctx.measureText(sep).width;
    dateWidth = ctx.measureText(dateLabel).width;
    timeWidth = ctx.measureText(timeLabel).width;
    venueWidth = 0;
    if (venue) {
      ctx.font = "bold " + venueSize + "px \"" + family + "\"";
      venueWidth = ctx.measureText(venue).width;
    }
    const segCount = venue ? 3 : 2;
    totalWidth = dateWidth + timeWidth + venueWidth + sepWidth * (segCount - 1);
    if (totalWidth <= maxWidth || dateSize <= MIN_DATE_SIZE) break;
    dateSize--;
  }

  const prevAlign = ctx.textAlign;
  ctx.textAlign = "left";
  let x = CANVAS_WIDTH / 2 - totalWidth / 2;

  ctx.font = "bold " + dateSize + "px \"" + family + "\"";
  ctx.fillText(dateLabel, x, y);
  x += dateWidth;

  if (venue) {
    ctx.fillText(sep, x, y);
    x += sepWidth;
    ctx.font = "bold " + venueSize + "px \"" + family + "\"";
    ctx.fillText(venue, x, y);
    x += venueWidth;
    ctx.font = "bold " + dateSize + "px \"" + family + "\"";
  }
  ctx.fillText(sep, x, y);
  x += sepWidth;
  ctx.fillText(timeLabel, x, y);

  ctx.textAlign = prevAlign;
}

// ================= Game Day card: record placement =================
// A team's win-loss record is optional (see fetchTeamRecord) and there's
// no space reserved for it anywhere on this already-fully-packed card --
// see the README's "Known tradeoffs" note on this. Two ways to show it,
// tried in order, both leaving every other element exactly where it
// already was (never shrinking the logos, the headline's own max size,
// or anything else):
//
//   1. PREFERRED -- "over the logo": drawn as its own text, centered
//      over each logo, sharing the headline's own baseline. Only used
//      when the plain "TEAM VS TEAM" headline (at ITS normal auto-fit
//      size, totally unchanged) leaves enough real horizontal gap on
//      that side between its own edge and the logo -- i.e. only when
//      the room is actually and already there, not manufactured by
//      shrinking something else. Short team names (most pro leagues)
//      usually have this room; full college names usually don't.
//   2. FALLBACK -- folded into the headline text itself, bookending it
//      ("8-3  ·  PENN STATE VS MARSHALL  ·  2-9") padded with extra
//      spaces around each dot for breathing room. The padding is purely
//      cosmetic, so it's given up first, one space at a time, before
//      the actual font size is ever allowed to shrink below its normal
//      24px ceiling -- losing a little whitespace is free, losing
//      readable text size is not.
const RECORD_OVER_LOGO_MAX_SIZE = 22;
const RECORD_OVER_LOGO_MIN_SIZE = 13;
const RECORD_OVER_LOGO_CLEARANCE = 8; // kept between the record text and the headline's own edge
const RECORD_PAD_MAX = 4; // spaces on each side of the dot separator
const RECORD_PAD_MIN = 1; // the plain, unpadded dot -- last resort before shrinking the font

// Largest size (within the over-logo range) at which `text` fits inside
// `gapAvailable` (already excludes RECORD_OVER_LOGO_CLEARANCE) without
// exceeding the logo's own width -- there's no point centering a record
// over a logo wider than the logo itself. Returns null if even the
// smallest size doesn't fit, meaning this placement isn't viable here.
function fitRecordOverLogo(ctx, text, gapAvailable) {
  const usable = gapAvailable - RECORD_OVER_LOGO_CLEARANCE;
  if (usable <= 0) return null;
  for (let size = RECORD_OVER_LOGO_MAX_SIZE; size >= RECORD_OVER_LOGO_MIN_SIZE; size--) {
    ctx.font = "bold " + size + "px \"" + FONT_FAMILY.serif + "\"";
    if (ctx.measureText(text).width <= Math.min(usable, LOGO_SIZE)) return size;
  }
  return null;
}

// Builds the fallback headline (records folded in, bookending the base
// text) and its font size, per the "give up padding before font size"
// contract above.
function buildPaddedRecordHeadline(ctx, base, myRecord, oppRecord, maxWidth) {
  const build = (pad) => {
    const sep = " ".repeat(pad) + "·" + " ".repeat(pad);
    return (myRecord ? myRecord + sep : "") + base + (oppRecord ? sep + oppRecord : "");
  };
  ctx.font = "24px \"" + FONT_FAMILY.block + "\"";
  for (let pad = RECORD_PAD_MAX; pad > RECORD_PAD_MIN; pad--) {
    const headline = build(pad);
    if (ctx.measureText(headline).width <= maxWidth) return { headline, size: 24 };
  }
  const headline = build(RECORD_PAD_MIN);
  const size = fitBannerFontSize(ctx, headline, maxWidth, FONT_FAMILY.block, 24, 16);
  return { headline, size };
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
//      normal case, not the exception. If card.myRecord/oppRecord are
//      given, see the "record placement" comment above for where they
//      end up.
//   3. logos either side + the days-left count between them, split
//      across 3 lines (IN / {number} / DAY(S)) with the number in a very
//      large font -- this is the card's single most important fact, so
//      it gets the most visual weight, sized to whatever room is left
//      between the logos rather than a fixed width.
//   4. one edge-to-edge bottom line: date, venue (at a larger size than
//      the rest -- see drawGameLine), and kickoff time, all on one line.
// Missing optional fields (no logo found, no dateLabel/timeLabel because
// the date was unparseable, no venue in ESPN's response) are simply
// skipped rather than leaving a gap or showing "undefined".
function drawGameDayCard(ctx, card) {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, CANVAS_WIDTH, BANNER_HEIGHT);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  const bannerTitle = card.bannerTitle || "GAME DAY";
  const bannerSize = fitBannerFontSize(ctx, bannerTitle, CANVAS_WIDTH - 40, FONT_FAMILY.block, 24, 14);
  ctx.fillText(bannerTitle, CANVAS_WIDTH / 2, BANNER_HEIGHT / 2 + Math.round(bannerSize * 0.35));

  // Logos drawn BEFORE the headline text on purpose: ditheredLogoCanvas
  // produces a fully opaque square (even its "white" pixels have alpha
  // 255, see ditheredLogoCanvas), so whichever of these two draws last
  // wins any pixel they both touch. A long headline (long team names,
  // auto-shrunk toward its 16px floor) can genuinely reach into a logo's
  // bounding box up here -- confirmed visually, not hypothetical -- and
  // drawing the logo second used to silently erase the overlapping
  // letters. Drawing logos first means the headline's actual ink always
  // wins that overlap instead of disappearing into it.
  const bodyMidY = BANNER_HEIGHT + (CANVAS_HEIGHT - BANNER_HEIGHT) / 2;
  if (card.myLogo) ctx.drawImage(card.myLogo, LOGO_MARGIN, bodyMidY - LOGO_SIZE / 2, LOGO_SIZE, LOGO_SIZE);
  if (card.oppLogo) ctx.drawImage(card.oppLogo, CANVAS_WIDTH - LOGO_MARGIN - LOGO_SIZE, bodyMidY - LOGO_SIZE / 2, LOGO_SIZE, LOGO_SIZE);

  ctx.fillStyle = "#000";
  ctx.textAlign = "center";
  // Tucked in tight under the banner (not vertically centered in its own
  // band, like the banner title is) -- the logos are back to their full
  // 175px size, which leaves very little clearance above them, so this
  // needs to sit as high as it can rather than claiming a fixed-height
  // band of its own.
  const headlineMaxWidth = CANVAS_WIDTH - 40;
  const headlineY = (size) => BANNER_HEIGHT + 4 + size;

  if (card.myRecord || card.oppRecord) {
    // Try the "over the logo" placement first -- see the "Game Day card:
    // record placement" comment above. Checked at the headline's OWN
    // normal size, completely unmodified: only used when that leaves
    // genuine room, never manufactured by shrinking the headline to make
    // room.
    const headlineSize = fitBannerFontSize(ctx, card.headline, headlineMaxWidth, FONT_FAMILY.block, 24, 16);
    ctx.font = headlineSize + "px \"" + FONT_FAMILY.block + "\"";
    const headlineWidth = ctx.measureText(card.headline).width;
    const headlineLeftEdge = CANVAS_WIDTH / 2 - headlineWidth / 2;
    const headlineRightEdge = CANVAS_WIDTH / 2 + headlineWidth / 2;
    const leftGap = headlineLeftEdge - (LOGO_MARGIN + LOGO_SIZE);
    const rightGap = (CANVAS_WIDTH - LOGO_MARGIN - LOGO_SIZE) - headlineRightEdge;
    const myFit = card.myRecord ? fitRecordOverLogo(ctx, card.myRecord, leftGap) : null;
    const oppFit = card.oppRecord ? fitRecordOverLogo(ctx, card.oppRecord, rightGap) : null;
    const bothFit = (!card.myRecord || myFit) && (!card.oppRecord || oppFit);

    if (bothFit) {
      ctx.font = headlineSize + "px \"" + FONT_FAMILY.block + "\"";
      ctx.fillText(card.headline, CANVAS_WIDTH / 2, headlineY(headlineSize));
      const y = headlineY(headlineSize);
      if (myFit) {
        ctx.font = "bold " + myFit + "px \"" + FONT_FAMILY.serif + "\"";
        ctx.fillText(card.myRecord, LOGO_MARGIN + LOGO_SIZE / 2, y);
      }
      if (oppFit) {
        ctx.font = "bold " + oppFit + "px \"" + FONT_FAMILY.serif + "\"";
        ctx.fillText(card.oppRecord, CANVAS_WIDTH - LOGO_MARGIN - LOGO_SIZE / 2, y);
      }
    } else {
      // Not enough room -- fold the records into the headline text
      // itself instead (see buildPaddedRecordHeadline).
      const { headline, size } = buildPaddedRecordHeadline(ctx, card.headline, card.myRecord, card.oppRecord, headlineMaxWidth);
      ctx.font = size + "px \"" + FONT_FAMILY.block + "\"";
      ctx.fillText(headline, CANVAS_WIDTH / 2, headlineY(size));
    }
  } else {
    const headlineSize = fitBannerFontSize(ctx, card.headline, headlineMaxWidth, FONT_FAMILY.block, 24, 16);
    ctx.fillText(card.headline, CANVAS_WIDTH / 2, headlineY(headlineSize));
  }

  // Constrained to the gap BETWEEN the logos, not the full card width --
  // unlike the headline/gameLine bands above/below, this (and the venue
  // line below it) needs to stay clear of the logos on either side.
  const daysMaxWidth = CANVAS_WIDTH - 2 * (LOGO_MARGIN + LOGO_SIZE) - 20;
  if (card.daysLeft <= 0) {
    const size = fitBannerFontSize(ctx, "TODAY!", daysMaxWidth, FONT_FAMILY.block, 56, 26);
    ctx.fillText("TODAY!", CANVAS_WIDTH / 2, bodyMidY - 6 + Math.round(size * 0.35));
  } else {
    // "IN" and "DAY(S)" need the SAME gap to the big number on both
    // sides -- a fixed pixel offset from bodyMidY for each (the earlier
    // approach) doesn't give that, since the number's own rendered
    // height varies with its font size, which varies with how many
    // digits fit. Instead, measure the number's actual glyph box
    // (actualBoundingBoxAscent/Descent -- real ink extent, not an
    // approximated cap-height) and hang "IN"/"DAY(S)" off ITS top/bottom
    // edge plus a fixed gap, so the gap is genuinely equal regardless of
    // the number's size.
    const GAP = 10;
    const numberText = String(card.daysLeft);
    const numberSize = fitBannerFontSize(ctx, numberText, daysMaxWidth, FONT_FAMILY.block, 92, 40);
    ctx.font = numberSize + "px \"" + FONT_FAMILY.block + "\"";
    const numMetrics = ctx.measureText(numberText);
    const numHeight = numMetrics.actualBoundingBoxAscent + numMetrics.actualBoundingBoxDescent;
    const numTop = bodyMidY - numHeight / 2;
    const numBaseline = numTop + numMetrics.actualBoundingBoxAscent;
    const numBottom = numBaseline + numMetrics.actualBoundingBoxDescent;
    ctx.fillText(numberText, CANVAS_WIDTH / 2, numBaseline);

    ctx.font = "bold 20px \"" + FONT_FAMILY.serif + "\"";
    const inMetrics = ctx.measureText("IN");
    ctx.fillText("IN", CANVAS_WIDTH / 2, numTop - GAP - inMetrics.actualBoundingBoxDescent);

    const unitText = card.daysUnit || "DAYS";
    const unitMetrics = ctx.measureText(unitText);
    ctx.fillText(unitText, CANVAS_WIDTH / 2, numBottom + GAP + unitMetrics.actualBoundingBoxAscent);
  }

  if (card.dateLabel && card.timeLabel) {
    ctx.fillStyle = "#000";
    drawGameLine(ctx, card.dateLabel, card.venue, card.timeLabel, CANVAS_WIDTH - 48, CANVAS_HEIGHT - 14);
  }
}

// Silhouette of the moon's lit fraction -- black fill is the UNLIT
// shadow (ink on the page), the blank/white area is what's lit, matching
// this card's black-ink-on-white style everywhere else. Verified against
// a 6-case reference render (new/crescent/quarter/gibbous/full, both
// waxing and waning) before being trusted here -- the two-path
// (semicircle + terminator ellipse) approach is easy to get subtly
// backwards (e.g. which half bulges which direction) without checking
// actual output.
function drawMoonIcon(ctx, cx, cy, r, illum, waxing) {
  const k = Math.max(0, Math.min(1, illum));
  const rx = r * Math.abs(1 - 2 * k);
  const gibbous = k > 0.5;
  ctx.save();
  ctx.save();
  // The waning case is drawn by mirroring the waxing construction
  // horizontally, rather than trying to flip the arc-direction booleans by
  // hand -- an earlier version did that (bulgeAnticlockwise = !gibbous)
  // and it silently produced a shape frozen at exactly half-lit for every
  // illum > 0.5 (never reaching full), since arc-direction sign flips
  // don't mirror the same way this ellipse construction needs. Reusing
  // the proven-correct waxing path under a horizontal flip sidesteps that
  // whole class of bug.
  if (!waxing) {
    ctx.translate(2 * cx, 0);
    ctx.scale(-1, 1);
  }
  ctx.beginPath();
  ctx.fillStyle = "#000";
  ctx.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2, false);
  ctx.ellipse(cx, cy, rx, r, 0, Math.PI / 2, -Math.PI / 2, gibbous);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// Small drawn glyphs for the Tide & Fishing card's weather row -- no
// emoji (node-canvas has no color-emoji font, so an emoji character
// renders as tofu/garbage; verified directly while building this).
function drawWindArrow(ctx, x, y, size) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.PI / 4);
  ctx.beginPath();
  ctx.moveTo(0, -size); ctx.lineTo(0, size);
  ctx.moveTo(-size * 0.5, -size * 0.4); ctx.lineTo(0, -size); ctx.lineTo(size * 0.5, -size * 0.4);
  ctx.strokeStyle = "#000"; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.stroke();
  ctx.restore();
}
function drawWaveGlyph(ctx, x, y, w, h) {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.quadraticCurveTo(x + w * 0.25, y - h, x + w * 0.5, y);
  ctx.quadraticCurveTo(x + w * 0.75, y + h, x + w, y);
  ctx.strokeStyle = "#000"; ctx.lineWidth = 2; ctx.lineCap = "round";
  ctx.stroke();
  ctx.restore();
}
function drawTrendArrow(ctx, x, y, size, direction) {
  ctx.save();
  ctx.translate(x, y);
  if (direction === "down") ctx.rotate(Math.PI);
  ctx.beginPath();
  ctx.moveTo(0, -size); ctx.lineTo(size * 0.8, size * 0.6); ctx.lineTo(-size * 0.8, size * 0.6);
  ctx.closePath();
  ctx.fillStyle = "#000";
  ctx.fill();
  ctx.restore();
}
function drawWarningTriangle(ctx, x, y, size) {
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.moveTo(0, -size); ctx.lineTo(size * 0.95, size * 0.75); ctx.lineTo(-size * 0.95, size * 0.75);
  ctx.closePath();
  ctx.lineWidth = 2.2;
  ctx.strokeStyle = "#000";
  ctx.stroke();
  ctx.fillStyle = "#000";
  ctx.fillRect(-1.3, -size * 0.35, 2.6, size * 0.7);
  ctx.beginPath();
  ctx.arc(0, size * 0.52, 1.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
function drawRainTick(ctx, x, y, size) {
  ctx.save();
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x - size * 0.3, y);
  ctx.lineTo(x - size * 0.7, y + size);
  ctx.moveTo(x + size * 0.3, y);
  ctx.lineTo(x - size * 0.1, y + size);
  ctx.stroke();
  ctx.restore();
}
// A diagonal-hatch "highlight" -- deliberately not a gray fill, since a
// semi-transparent wash would just get thresholded away to solid black or
// white once this is packed to 1-bit for the real e-ink display. Denser
// spacing reads as more emphasis (used for solunar "major" periods vs.
// "minor").
function drawHatchBand(ctx, x0, x1, yTop, yBottom, spacing) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, yTop, x1 - x0, yBottom - yTop);
  ctx.clip();
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 1;
  for (let x = x0 - (yBottom - yTop); x < x1; x += spacing) {
    ctx.beginPath();
    ctx.moveTo(x, yBottom);
    ctx.lineTo(x + (yBottom - yTop), yTop);
    ctx.stroke();
  }
  ctx.restore();
}

// Phase 2 of the Tide & Fishing card: adds solunar major/minor period
// bands (hatched, clipped to the dawn-dusk window like everything else on
// this card) and a fishing score badge in the banner, on top of Phase 1's
// tide curve + moon phase/rise/set. Weather (wind/pressure/rain/swell)
// is still a later phase.
//
// card is exactly what lib/astro.js's fetchTideCardData returns:
// { dawn, sunrise, sunset, dusk, moon, tideCurve, tideExtrema,
// solunarPeriods, fishingScore }, each of dawn/sunrise/sunset/dusk/
// moon.rise/moon.set being either null or
// { t: <ISO string>, label: <"3:15 PM" or null> }.
function drawTideCard(ctx, card) {
  const dawnMs = new Date(card.dawn.t).getTime();
  const duskMs = new Date(card.dusk.t).getTime();
  function minutesToX(iso) {
    const ms = new Date(iso).getTime();
    const clamped = Math.max(dawnMs, Math.min(duskMs, ms));
    return 46 + ((clamped - dawnMs) / (duskMs - dawnMs)) * (CANVAS_WIDTH - 92);
  }

  // Fixed bands -- each zone owns a Y range that never depends on the
  // day's actual tide/data values, so a high/low label can't drift into
  // the top strip or footer on a day with an unusual tide range. See the
  // mockup iteration that led here: floating a label relative to its
  // dot's data-driven height is what caused repeated overlap bugs.
  //
  // The plot itself is trimmed from its original 64px down to 30px --
  // it's just a simple rise-and-fall shape, and doesn't need much
  // vertical resolution to read clearly -- to make room for larger text
  // everywhere else (bigger fonts need more line height, not just wider
  // glyphs; nothing on this card is smaller than 18px, matching the
  // fishing badge/moon phase, per an explicit "minimum font size" ask).
  // The reclaimed space is split across the hi/lo label zones (both top
  // and bottom, which each grew to fit an 18px time label under the
  // 22px height label) and the footer (now two full 18px lines instead
  // of one row of smaller mixed sizes).
  const TOP_STRIP_END = BANNER_HEIGHT + 24;
  const PLOT_TOP = TOP_STRIP_END + 46;
  const PLOT_BOTTOM = PLOT_TOP + 44;
  const FOOTER_START = PLOT_BOTTOM + 60;

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, CANVAS_WIDTH, BANNER_HEIGHT);
  ctx.fillStyle = "#fff";
  // Left-aligned with a fixed margin, not centered -- this title is long
  // enough to nearly fill the space left of the fishing badge, so a
  // centering offset tuned for the old, much shorter "TODAY'S TIDE"
  // would push it into the badge instead of scaling safely with title
  // length the way a fixed left margin does.
  //
  // maxWidth reserves room for the WIDEST possible badge ("FISHING:
  // EXCELLENT", ~239px including its padding), not today's actual one --
  // sizing against whatever score happens to be showing today would
  // silently overlap the badge on a day the score is longer than
  // whatever this was tuned against.
  ctx.textAlign = "left";
  const bannerTitle = "DAILY FISHING FORECAST: TIDES & SOLUNAR";
  const bannerSize = fitBannerFontSize(ctx, bannerTitle, CANVAS_WIDTH - 24 - 239 - 24 - 16, FONT_FAMILY.block, 28, 16);
  ctx.fillText(bannerTitle, 24, BANNER_HEIGHT / 2 + Math.round(bannerSize * 0.35));

  if (card.fishingScore) {
    ctx.font = "bold 18px \"" + FONT_FAMILY.serif + "\"";
    const badgeLabel = "FISHING: " + card.fishingScore.toUpperCase();
    const badgeTextWidth = ctx.measureText(badgeLabel).width;
    const badgeW = badgeTextWidth + 28;
    const badgeH = 32;
    const badgeX = CANVAS_WIDTH - 24 - badgeW;
    const badgeY = (BANNER_HEIGHT - badgeH) / 2;
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.roundRect(badgeX, badgeY, badgeW, badgeH, badgeH / 2);
    ctx.fill();
    ctx.fillStyle = "#000";
    ctx.textAlign = "left";
    ctx.fillText(badgeLabel, badgeX + 14, BANNER_HEIGHT / 2 + 6);
  }

  // The alert strip (rain/wind call-outs) is the single boldest thing on
  // the card besides the banner -- it's what the "conditions that might
  // change your plans" ask was actually about, so it outranks the quiet
  // Sunrise/Sunset line and takes that row over on any day there's
  // something to flag. On an ordinary day with nothing to call out, the
  // row falls back to Sunrise/Sunset as before.
  const weather = card.weather || {};
  const alertParts = [].concat(
    (weather.rainWindows || []).map((w) => w.label),
    weather.windRamp ? [weather.windRamp.label] : []
  );
  if (alertParts.length) {
    drawWarningTriangle(ctx, 32, (BANNER_HEIGHT + TOP_STRIP_END) / 2, 11);
    ctx.font = "bold 18px \"" + FONT_FAMILY.serif + "\"";
    ctx.fillStyle = "#000";
    ctx.textAlign = "left";
    ctx.fillText(alertParts.join("   ·   "), 50, (BANNER_HEIGHT + TOP_STRIP_END) / 2 + 6);
  } else {
    ctx.font = "bold 18px \"" + FONT_FAMILY.serif + "\"";
    ctx.fillStyle = "#000";
    if (card.sunrise.label) {
      ctx.textAlign = "left";
      ctx.fillText("Sunrise " + card.sunrise.label, 24, TOP_STRIP_END - 7);
    }
    if (card.sunset.label) {
      ctx.textAlign = "right";
      ctx.fillText("Sunset " + card.sunset.label, CANVAS_WIDTH - 24, TOP_STRIP_END - 7);
    }
  }

  // Includes extrema heights, not just the curve's -- normally a no-op
  // (extrema fall within the curve's own range), but load-bearing when
  // tideCurve is empty (a subordinate station with hi/lo-only
  // predictions, no continuous curve -- see astro.js's fetchTideCardData):
  // without this, the scale would fall back to [0,1] and clip real hi/lo
  // values well outside that range instead of scaling to fit them.
  const heights = card.tideCurve.map((p) => p.heightFt).concat((card.tideExtrema || []).map((p) => p.heightFt));
  const minH = (heights.length ? Math.min(...heights) : 0) - 0.4;
  const maxH = (heights.length ? Math.max(...heights) : 1) + 0.4;
  function heightToY(h) {
    return PLOT_BOTTOM - ((h - minH) / (maxH - minH)) * (PLOT_BOTTOM - PLOT_TOP);
  }

  const solunarPeriods = card.solunarPeriods || [];
  solunarPeriods.forEach((p) => {
    const pStartMs = new Date(p.start).getTime(), pEndMs = new Date(p.end).getTime();
    if (pEndMs < dawnMs || pStartMs > duskMs) return;
    const x0 = minutesToX(new Date(Math.max(pStartMs, dawnMs)).toISOString());
    const x1 = minutesToX(new Date(Math.min(pEndMs, duskMs)).toISOString());
    drawHatchBand(ctx, x0, x1, PLOT_TOP, PLOT_BOTTOM, p.kind === "major" ? 7 : 13);
  });

  // Rain ticks along the top of the plot -- visually distinct from the
  // full-height solunar hatch above so the two kinds of "shaded window"
  // are never confused with each other.
  (weather.rainWindows || []).forEach((w) => {
    const wStartMs = new Date(w.start).getTime(), wEndMs = new Date(w.end).getTime();
    if (wEndMs < dawnMs || wStartMs > duskMs) return;
    const rx0 = minutesToX(new Date(Math.max(wStartMs, dawnMs)).toISOString());
    const rx1 = minutesToX(new Date(Math.min(wEndMs, duskMs)).toISOString());
    for (let x = rx0; x <= rx1; x += 14) drawRainTick(ctx, x, PLOT_TOP + 4, 8);
  });

  ctx.strokeStyle = "rgba(0,0,0,0.2)";
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  [card.sunrise, card.sunset].forEach((point) => {
    if (!point) return;
    const x = minutesToX(point.t);
    ctx.beginPath();
    ctx.moveTo(x, PLOT_TOP);
    ctx.lineTo(x, PLOT_BOTTOM);
    ctx.stroke();
  });
  ctx.setLineDash([]);

  if (card.tideCurve.length > 1) {
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    card.tideCurve.forEach((p, i) => {
      const x = minutesToX(p.t);
      const y = heightToY(p.heightFt);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(0,0,0,0.25)";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(46, PLOT_BOTTOM);
  ctx.lineTo(CANVAS_WIDTH - 46, PLOT_BOTTOM);
  ctx.stroke();
  ctx.setLineDash([]);

  // Hourly axis along the plot's bottom edge -- lets the curve's shape
  // be read against time of day directly, without cross-referencing the
  // H/L dot labels for it. Ticks land on round LOCAL-clock hours (using
  // this card's own timeZone, not raw UTC), spaced evenly by
  // AXIS_TICK_INTERVAL_H -- 3h apart reliably gives 5-6 ticks across a
  // typical dawn-dusk span (~14-16h) without crowding. Deliberately a
  // smaller/lighter font than the rest of the card's 18px-minimum
  // content text -- this is axis scaffolding, not content, the same
  // distinction a chart's own axis labels always get.
  const AXIS_TICK_INTERVAL_H = 3;
  const dawnLocalParts = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: card.timeZone }).formatToParts(new Date(dawnMs));
  const dawnLocalHour = Number(dawnLocalParts.find((p) => p.type === "hour").value) % 24;
  const dawnLocalMinute = Number(dawnLocalParts.find((p) => p.type === "minute").value);
  const minutesToFirstTick = ((AXIS_TICK_INTERVAL_H - (dawnLocalHour % AXIS_TICK_INTERVAL_H)) % AXIS_TICK_INTERVAL_H) * 60 - dawnLocalMinute;
  const hourFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: true, timeZone: card.timeZone });
  ctx.textAlign = "center";
  ctx.font = "bold 12px \"" + FONT_FAMILY.serif + "\"";
  ctx.fillStyle = "#000";
  for (let tickMs = dawnMs + Math.max(0, minutesToFirstTick) * 60000; tickMs <= duskMs; tickMs += AXIS_TICK_INTERVAL_H * 3600000) {
    const x = minutesToX(new Date(tickMs).toISOString());
    ctx.strokeStyle = "rgba(0,0,0,0.4)"; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, PLOT_BOTTOM - 3);
    ctx.lineTo(x, PLOT_BOTTOM + 4);
    ctx.stroke();
    ctx.fillText(hourFmt.format(new Date(tickMs)), x, PLOT_BOTTOM + 16);
  }

  ctx.textAlign = "center";
  card.tideExtrema.forEach((e) => {
    const eMs = new Date(e.t).getTime();
    if (eMs < dawnMs || eMs > duskMs) return;
    const x = minutesToX(e.t);
    const y = heightToY(e.heightFt);
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#000";
    ctx.fill();

    const heightLabel = (e.isHigh ? "H " : "L ") + e.heightFt.toFixed(1) + "ft";
    if (e.isHigh) {
      if (y - PLOT_TOP > 14) {
        ctx.strokeStyle = "rgba(0,0,0,0.35)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, y - 6); ctx.lineTo(x, PLOT_TOP + 2); ctx.stroke();
      }
      ctx.font = "bold 22px \"" + FONT_FAMILY.serif + "\"";
      ctx.fillStyle = "#000";
      ctx.fillText(heightLabel, x, TOP_STRIP_END + 24);
      ctx.font = "bold 18px \"" + FONT_FAMILY.serif + "\"";
      ctx.fillStyle = "#000";
      ctx.fillText(e.label, x, TOP_STRIP_END + 40);
    } else {
      if (PLOT_BOTTOM - y > 14) {
        ctx.strokeStyle = "rgba(0,0,0,0.35)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, y + 6); ctx.lineTo(x, PLOT_BOTTOM - 2); ctx.stroke();
      }
      ctx.font = "bold 22px \"" + FONT_FAMILY.serif + "\"";
      ctx.fillStyle = "#000";
      ctx.fillText(heightLabel, x, PLOT_BOTTOM + 38);
      ctx.font = "bold 18px \"" + FONT_FAMILY.serif + "\"";
      ctx.fillStyle = "#000";
      ctx.fillText(e.label, x, PLOT_BOTTOM + 56);
    }
  });

  // MAJOR/MINOR band labels sit just above the baseline, with a small
  // white halo so the hatch lines behind them don't cut through the text.
  // At 18px the label is often wider than a MINOR band itself (a minor
  // period is only ~50min wide, well under an hour of plot width) -- the
  // white halo box is sized to the text, not the band, so it can extend
  // past the band's own hatched edges into the plain plot on either side
  // without clipping or overlapping the tide curve/dots there.
  solunarPeriods.forEach((p) => {
    const pStartMs = new Date(p.start).getTime(), pEndMs = new Date(p.end).getTime();
    if (pEndMs < dawnMs || pStartMs > duskMs) return;
    const x0 = minutesToX(new Date(Math.max(pStartMs, dawnMs)).toISOString());
    const x1 = minutesToX(new Date(Math.min(pEndMs, duskMs)).toISOString());
    ctx.font = "italic bold 18px \"" + FONT_FAMILY.serif + "\"";
    ctx.textAlign = "center";
    const bandLabel = p.kind.toUpperCase();
    const labelW = ctx.measureText(bandLabel).width;
    const labelCx = (x0 + x1) / 2;
    ctx.fillStyle = "#fff";
    ctx.fillRect(labelCx - labelW / 2 - 4, PLOT_BOTTOM - 25, labelW + 8, 22);
    ctx.fillStyle = "#000";
    ctx.fillText(bandLabel, labelCx, PLOT_BOTTOM - 8);
  });

  // Footer row 1: moon phase + rise/set.
  const footerY1 = FOOTER_START + 22;
  drawMoonIcon(ctx, 60, footerY1 - 10, 13, card.moon.illumination, card.moon.waxing);
  ctx.textAlign = "left";
  ctx.font = "bold 18px \"" + FONT_FAMILY.serif + "\"";
  ctx.fillStyle = "#000";
  ctx.fillText(card.moon.phaseName, 82, footerY1 - 3);

  const riseSetParts = [];
  if (card.moon.rise && card.moon.rise.label) riseSetParts.push("Moonrise " + card.moon.rise.label);
  if (card.moon.set && card.moon.set.label) riseSetParts.push("Moonset " + card.moon.set.label);
  if (riseSetParts.length) {
    ctx.font = "bold 18px \"" + FONT_FAMILY.serif + "\"";
    ctx.fillStyle = "#000";
    ctx.textAlign = "right";
    ctx.fillText(riseSetParts.join("   ·   "), CANVAS_WIDTH - 24, footerY1 - 3);
  }

  // Footer row 2: wind + pressure (left), swell + water temp (right) --
  // both from Open-Meteo. Omitted entirely if there's nothing at all to
  // show (e.g. the weather fetch came back sparse), rather than drawing
  // an empty row.
  //
  // "Wind"/"Swell"/"water" label words are dropped here (unlike the
  // moonrise/moonset line above, which keeps its words and still fits) --
  // at 18px, a full label-then-value row for both clusters no longer fits
  // in the card's width. Each icon (wind arrow, pressure trend arrow,
  // wave glyph) already identifies what its number means, the same
  // convention "H"/"L" and the pressure trend arrow already used even
  // before this -- so the words were redundant, not essential.
  const footerY2 = CANVAS_HEIGHT - 8;
  let cx = 84;
  if (weather.wind) {
    drawWindArrow(ctx, 58, footerY2 - 8, 8);
    ctx.font = "bold 18px \"" + FONT_FAMILY.serif + "\"";
    ctx.fillStyle = "#000";
    ctx.textAlign = "left";
    const windValue = weather.wind.mph + " mph" + (weather.wind.dir ? " " + weather.wind.dir : "");
    ctx.fillText(windValue, cx, footerY2 - 3);
    cx += ctx.measureText(windValue).width;
  }
  if (weather.pressure && weather.pressure.hpa != null) {
    if (cx > 84) {
      ctx.font = "bold 18px \"" + FONT_FAMILY.serif + "\"";
      ctx.fillStyle = "#000";
      ctx.textAlign = "left";
      ctx.fillText("   ·   ", cx, footerY2 - 3);
      cx += ctx.measureText("   ·   ").width;
    }
    if (weather.pressure.deltaHpa != null && weather.pressure.trend !== "steady") {
      drawTrendArrow(ctx, cx + 8, footerY2 - 8, 8, weather.pressure.trend === "falling" ? "down" : "up");
      cx += 18;
    }
    const pressureValue = weather.pressure.hpa + " hPa" + (weather.pressure.deltaHpa != null ? " (" + weather.pressure.deltaHpa + ")" : "");
    ctx.font = "bold 18px \"" + FONT_FAMILY.serif + "\"";
    ctx.fillStyle = "#000";
    ctx.textAlign = "left";
    ctx.fillText(pressureValue, cx, footerY2 - 3);
  }

  const rightParts = [];
  if (weather.swell) rightParts.push(weather.swell.heightFt.toFixed(1) + " ft" + (weather.swell.periodS != null ? " @ " + weather.swell.periodS + "s" : ""));
  if (weather.waterTempF != null) rightParts.push(weather.waterTempF + "°F");
  if (rightParts.length) {
    const fullPlain = rightParts.join("   ·   ");
    ctx.font = "bold 18px \"" + FONT_FAMILY.serif + "\"";
    const fullW = ctx.measureText(fullPlain).width;
    let px = CANVAS_WIDTH - 24 - fullW;
    drawWaveGlyph(ctx, px - 34, footerY2 - 7, 28, 6);
    ctx.fillStyle = "#000";
    ctx.textAlign = "left";
    ctx.fillText(fullPlain, px, footerY2 - 3);
  }
}

// ================= Sun/Moon/Tide Timeline card =================
// Full-screen layout, built from real user feedback across many mockup
// rounds (not redesigned from scratch here -- see the README section
// for the full history). The whole board represents one local calendar
// day, midnight to midnight, left to right. Three bands, top to bottom:
//   1. Top row: a sun icon straddling the sunrise/sunset boundary
//      itself (see TIMELINE_invertNightColumns below for why that
//      works), its time above; town name + full date centered between
//      them, in the daylight span specifically (not the canvas
//      midpoint -- the two rarely coincide).
//   2. Above the time axis (~2/3 down): each tide high/low, as
//      "H"/"L" + feet above its time, with a drop-line down to the
//      axis at that event's actual time position. Highs get a taller
//      drop-line than lows -- a visual echo of a real tide curve's
//      shape, even though this card never draws a continuous curve.
//   3. Below the axis: each moon event (rise, set, overhead,
//      underfoot) as a drop-line up to the axis, then time, moon-phase
//      icon, and a small RISE/SET/OVER/UNDER word underneath.
// The axis itself carries NO hour labels -- every time on the card is
// its own label, deliberately.
//
// Night/day background: rather than picking an ink color per element
// while drawing (which was tried first and kept breaking -- a label
// straddling the boundary would have PART of its own width land on the
// wrong-colored background, invisible white-on-white), everything here
// is drawn in the simple, uniform black-ink-on-white scheme, with zero
// day/night awareness. TIMELINE_invertNightColumns then inverts the
// finished night-side pixel columns as the very last step -- correct
// by construction for ANY element that happens to land there, including
// ones straddling the boundary (like the sun icon, deliberately
// centered exactly on it): the night-side half of a straddling icon
// simply becomes a white glyph on the now-black background, no special
// case needed.
const TIMELINE_TIME_FONT_SIZE = 30; // every time on this card: sunrise, sunset, tide, moon
const TIMELINE_AMPM_RATIO = 0.55; // the AM/PM suffix renders at this fraction of the main time's size
const TIMELINE_WORD_FONT_SIZE = 22; // RISE / SET / OVER / UNDER
const TIMELINE_TOP_ROW_HEIGHT = 54;
const TIMELINE_AXIS_Y = 165; // "two thirds down" -- moved up a bit from a literal 2/3 (181) to leave more room below for the moon icon
const TIMELINE_MOON_ICON_R = 17;
const TIMELINE_HIGH_LINE_LEN = 36;
const TIMELINE_LOW_LINE_LEN = 18;
const TIMELINE_SUN_ICON_R = 11;
const TIMELINE_HL_LETTER_SIZE = 28; // the "H"/"L" itself
const TIMELINE_HL_VALUE_SIZE = 18; // the "4.7ft" that follows it, deliberately smaller and not bold

// Splits "6:20AM" into "6:20" (mainSize) + "AM" (smaller, ampmSize),
// sharing one baseline -- same mixed-size-one-line technique
// drawGameLine uses for the Game Day card's date/venue/time. Handles
// left/center/right alignment itself.
function drawTimelineTimeSplitAmPm(ctx, timeStr, x, y, align, mainSize, ampmSize) {
  const m = timeStr.replace(" ", "").match(/^(.*?)(AM|PM)$/);
  const family = FONT_FAMILY.serif;
  if (!m) {
    ctx.font = "bold " + mainSize + "px \"" + family + "\"";
    ctx.textAlign = align;
    ctx.fillText(timeStr, x, y);
    return;
  }
  const main = m[1], suffix = m[2];
  ctx.font = "bold " + mainSize + "px \"" + family + "\"";
  const mainWidth = ctx.measureText(main).width;
  ctx.font = "bold " + ampmSize + "px \"" + family + "\"";
  const suffixWidth = ctx.measureText(suffix).width;
  const totalWidth = mainWidth + suffixWidth;
  let startX;
  if (align === "left") startX = x;
  else if (align === "right") startX = x - totalWidth;
  else startX = x - totalWidth / 2;
  ctx.textAlign = "left";
  ctx.font = "bold " + mainSize + "px \"" + family + "\"";
  ctx.fillText(main, startX, y);
  ctx.font = "bold " + ampmSize + "px \"" + family + "\"";
  ctx.fillText(suffix, startX + mainWidth, y);
}

// Keeps a marker's text from running off the left/right canvas edge --
// switches text-align near the edges instead of staying centered.
function timelineClampAlign(x) {
  if (x < 90) return "left";
  if (x > CANVAS_WIDTH - 90) return "right";
  return "center";
}
function timelineClampX(x) {
  if (x < 90) return Math.max(x, 4);
  if (x > CANVAS_WIDTH - 90) return Math.min(x, CANVAS_WIDTH - 4);
  return x;
}
// For a centered cluster (the moon icon + its word, both always
// center-anchored regardless of timelineClampAlign) -- keeps its widest
// element (the word, wider than the icon) fully on-canvas near either
// edge instead of just nudging in a few px.
function timelineClampCenterX(x, halfWidth) {
  return Math.max(halfWidth + 4, Math.min(x, CANVAS_WIDTH - halfWidth - 4));
}

// A filled circle + short rays -- deliberately centered exactly on
// sunriseX/sunsetX (never clamped like the text around it), so
// TIMELINE_invertNightColumns bisects it right on the boundary.
function drawTimelineSunIcon(ctx, cx, cy, r) {
  ctx.save();
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 2;
  const rayCount = 8;
  const rayInner = r + 3;
  const rayOuter = r + 8;
  for (let i = 0; i < rayCount; i++) {
    const angle = (i / rayCount) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * rayInner, cy + Math.sin(angle) * rayInner);
    ctx.lineTo(cx + Math.cos(angle) * rayOuter, cy + Math.sin(angle) * rayOuter);
    ctx.stroke();
  }
  ctx.restore();
}

// Splits "HIGH 4.7" into "HIGH " (larger, bold) + "4.7" (smaller, plain
// weight) sharing one baseline -- same mixed-size-one-line technique as
// drawTimelineTimeSplitAmPm, just with the larger piece first instead of
// last. Spells out HIGH/LOW rather than abbreviating to H/L, and drops
// the "ft" unit -- the card only ever shows one unit, it doesn't need
// repeating at every marker. Serif, not the block/Bungee font used
// elsewhere on this card -- Bungee's "L" reads oddly at this size.
function drawTimelineHLValue(ctx, isHigh, heightFt, x, y, align) {
  const letter = (isHigh ? "HIGH" : "LOW") + " ";
  const value = heightFt.toFixed(1);
  const family = FONT_FAMILY.serif;
  ctx.font = "bold " + TIMELINE_HL_LETTER_SIZE + "px \"" + family + "\"";
  const letterWidth = ctx.measureText(letter).width;
  ctx.font = TIMELINE_HL_VALUE_SIZE + "px \"" + family + "\"";
  const valueWidth = ctx.measureText(value).width;
  const totalWidth = letterWidth + valueWidth;
  let startX;
  if (align === "left") startX = x;
  else if (align === "right") startX = x - totalWidth;
  else startX = x - totalWidth / 2;
  ctx.textAlign = "left";
  ctx.font = "bold " + TIMELINE_HL_LETTER_SIZE + "px \"" + family + "\"";
  ctx.fillText(letter, startX, y);
  ctx.font = TIMELINE_HL_VALUE_SIZE + "px \"" + family + "\"";
  ctx.fillText(value, startX + letterWidth, y);
}

// A tide extremum this close to midnight (either side) sits right where
// the axis wraps around -- there's real risk of running into the
// opposite-edge marker's own label, so for these, the value+time is
// dropped entirely and only the bare "H"/"L" (still with its own
// drop-line) is drawn. Reads ex.label ("6:16 AM"/"12:23 AM"/"10:15 PM")
// rather than redoing a timezone lookup -- it's already the exact
// local wall-clock string this card displays everywhere else.
function timelineIsNearMidnightEdge(label) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(label || "");
  if (!m) return false;
  let hour = parseInt(m[1], 10) % 12;
  if (m[3].toUpperCase() === "PM") hour += 12;
  const totalMinutes = hour * 60 + parseInt(m[2], 10);
  return totalMinutes < 3 * 60 + 30 || totalMinutes >= 22 * 60;
}

// A reversed-fill variant of drawMoonIcon, just for this card. drawMoonIcon
// (used by the Tide & Fishing card's footer, which has no day/night zones)
// inks the DARK side of the moon and leaves the LIT side blank -- confirmed
// by its own test (a "full" moon there is drawn almost entirely blank, a
// "new" moon almost entirely inked). That reads backwards here: this
// card's invert-the-night-columns pass means whatever's inked in the night
// zone comes out white, and whatever's inked in the day zone stays black --
// so for "a full moon looks white at night, black by day" (the ask), the
// LIT side needs to be what's inked, not the dark side. Fills the whole
// disk black, then paints the same dark-side shape drawMoonIcon would have
// inked back to OPAQUE white (not erased to transparent -- a destination-out
// erase was tried first and technically "worked," but left truly
// transparent holes rather than white, which only look right by accident
// depending on how alpha survives the invert pass/PNG export/1-bit
// packing downstream. An explicit opaque repaint has no such dependency).
function drawTimelineMoonIcon(ctx, cx, cy, r, illum, waxing) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = "#000";
  ctx.fill();

  const k = Math.max(0, Math.min(1, illum));
  const rx = r * Math.abs(1 - 2 * k);
  const gibbous = k > 0.5;
  // See drawMoonIcon's comment: the waning case mirrors the (proven-
  // correct) waxing construction horizontally rather than flipping the
  // ellipse's arc-direction boolean by hand -- that approach silently
  // froze the icon at exactly half-lit for every illum > 0.5 when waning.
  ctx.save();
  if (!waxing) {
    ctx.translate(2 * cx, 0);
    ctx.scale(-1, 1);
  }
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2, false);
  ctx.ellipse(cx, cy, rx, r, 0, Math.PI / 2, -Math.PI / 2, gibbous);
  ctx.closePath();
  ctx.fillStyle = "#fff";
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = "#000";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// Inverts every pixel (RGB, not alpha) in the given x-range across the
// card's full height -- the "apply the night rule" step. Cheap to call
// twice (once per side of the daylight span) since each call only
// touches its own rectangle.
function TIMELINE_invertNightColumns(ctx, x0, w) {
  if (w <= 0) return;
  const imgData = ctx.getImageData(x0, 0, w, CANVAS_HEIGHT);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = 255 - d[i];
    d[i + 1] = 255 - d[i + 1];
    d[i + 2] = 255 - d[i + 2];
  }
  ctx.putImageData(imgData, x0, 0);
}

const TIMELINE_MOON_WORD = { rise: "RISE", set: "SET", overhead: "OVER", underfoot: "UNDER" };

function drawTideTimelineCard(ctx, card) {
  const dayStartMs = new Date(card.dayStart).getTime();
  const dayEndMs = new Date(card.dayEnd).getTime();
  function xForTime(iso) {
    const frac = (new Date(iso).getTime() - dayStartMs) / (dayEndMs - dayStartMs);
    return Math.round(frac * CANVAS_WIDTH);
  }

  const sunriseX = card.sunrise ? xForTime(card.sunrise.t) : null;
  const sunsetX = card.sunset ? xForTime(card.sunset.t) : null;

  // ---- Top row: sun icons + times, town name + date ----
  if (card.sunrise) {
    const align = timelineClampAlign(sunriseX);
    const anchorX = timelineClampX(sunriseX);
    ctx.fillStyle = "#000";
    drawTimelineTimeSplitAmPm(ctx, card.sunrise.label, anchorX, 25, align, TIMELINE_TIME_FONT_SIZE, Math.round(TIMELINE_TIME_FONT_SIZE * TIMELINE_AMPM_RATIO));
    drawTimelineSunIcon(ctx, sunriseX, 43, TIMELINE_SUN_ICON_R);
  }
  if (card.sunset) {
    const align = timelineClampAlign(sunsetX);
    const anchorX = timelineClampX(sunsetX);
    ctx.fillStyle = "#000";
    drawTimelineTimeSplitAmPm(ctx, card.sunset.label, anchorX, 25, align, TIMELINE_TIME_FONT_SIZE, Math.round(TIMELINE_TIME_FONT_SIZE * TIMELINE_AMPM_RATIO));
    drawTimelineSunIcon(ctx, sunsetX, 43, TIMELINE_SUN_ICON_R);
  }

  const centerX = (sunriseX != null && sunsetX != null) ? (sunriseX + sunsetX) / 2 : CANVAS_WIDTH / 2;
  ctx.fillStyle = "#000";
  ctx.textAlign = "center";
  ctx.font = "bold 24px \"" + FONT_FAMILY.serif + "\"";
  ctx.fillText(card.townName || "", centerX, 22);
  if (card.dateLabel) {
    ctx.font = "bold 18px \"" + FONT_FAMILY.serif + "\"";
    ctx.fillText(card.dateLabel, centerX, 44);
  }

  // Solid opaque black, not a translucent gray -- this is what lets the
  // night-side invert pass turn it genuinely WHITE there instead of just
  // a different shade of gray (an rgba fill would blend with the white
  // background first, and invert that blended color, not pure black).
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(0, TIMELINE_AXIS_Y);
  ctx.lineTo(CANVAS_WIDTH, TIMELINE_AXIS_Y);
  ctx.stroke();

  // ---- Tide highs/lows, above the axis ----
  (card.tideExtrema || []).forEach((ex) => {
    const x = xForTime(ex.t);
    const align = timelineClampAlign(x);
    const anchorX = timelineClampX(x);
    const lineLen = ex.isHigh ? TIMELINE_HIGH_LINE_LEN : TIMELINE_LOW_LINE_LEN;
    const lineTop = TIMELINE_AXIS_Y - lineLen;
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, lineTop);
    ctx.lineTo(x, TIMELINE_AXIS_Y);
    ctx.stroke();

    // The value-to-time gap is fixed independently of lineLen (30px,
    // sized for TIME_FONT_SIZE's own ascent) -- lineLen only controls
    // how far the whole cluster floats above the axis.
    const timeBaseline = lineTop - 8;
    const valueBaseline = timeBaseline - 30;
    ctx.fillStyle = "#000";
    if (timelineIsNearMidnightEdge(ex.label)) {
      ctx.textAlign = align;
      ctx.font = "bold " + TIMELINE_HL_LETTER_SIZE + "px \"" + FONT_FAMILY.serif + "\"";
      ctx.fillText(ex.isHigh ? "H" : "L", anchorX, timeBaseline);
    } else {
      drawTimelineHLValue(ctx, ex.isHigh, ex.heightFt, anchorX, valueBaseline, align);
      drawTimelineTimeSplitAmPm(ctx, ex.label, anchorX, timeBaseline, align, TIMELINE_TIME_FONT_SIZE, Math.round(TIMELINE_TIME_FONT_SIZE * TIMELINE_AMPM_RATIO));
    }
  });

  // ---- Moon events, below the axis ----
  (card.moonEvents || []).forEach((ev) => {
    const x = xForTime(ev.t);
    const align = timelineClampAlign(x);
    const anchorX = timelineClampX(x);

    const lineBottom = TIMELINE_AXIS_Y + 12;
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, TIMELINE_AXIS_Y);
    ctx.lineTo(x, lineBottom);
    ctx.stroke();

    ctx.fillStyle = "#000";
    const timeY = lineBottom + 20;
    drawTimelineTimeSplitAmPm(ctx, ev.label, anchorX, timeY, align, TIMELINE_TIME_FONT_SIZE, Math.round(TIMELINE_TIME_FONT_SIZE * TIMELINE_AMPM_RATIO));

    const word = TIMELINE_MOON_WORD[ev.kind] || "";
    ctx.font = "bold " + TIMELINE_WORD_FONT_SIZE + "px \"" + FONT_FAMILY.serif + "\"";
    const wordHalfWidth = ctx.measureText(word).width / 2;
    const clusterX = timelineClampCenterX(x, wordHalfWidth);

    const iconY = timeY + 9 + TIMELINE_MOON_ICON_R;
    drawTimelineMoonIcon(ctx, clusterX, iconY, TIMELINE_MOON_ICON_R, card.moonPhase.illumination, card.moonPhase.waxing);

    ctx.textAlign = "center";
    ctx.fillText(word, clusterX, iconY + TIMELINE_MOON_ICON_R + 20);
  });

  // ---- Apply the night rule, last ----
  if (sunriseX != null && sunsetX != null) {
    TIMELINE_invertNightColumns(ctx, 0, sunriseX);
    TIMELINE_invertNightColumns(ctx, sunsetX, CANVAS_WIDTH - sunsetX);
  }
}

// ================= Beach Buddy =================
// A single friendly stick-figure character whose POSE and headline are
// driven by the device's own real conditions (tide, wind, rain, swell,
// moon) -- reusing fetchTideCardData exactly as the "tide" type does, no
// separate data source. No black title banner and no clutter on
// purpose: this card is meant to read at a glance, like a Life is Good
// illustration -- one big headline, an optional short subline, and the
// character. Drawn fresh once a day (same daily job as every other
// dynamic layer), not live/animated -- an e-ink panel can't do frame
// animation, so "alive" here means an expressive POSE, not motion.

const INK = "#000";

// One stick-figure limb segment pair (e.g. upper arm + forearm, or thigh
// + shin) from `origin`. Each angle is DEGREES CLOCKWISE FROM STRAIGHT
// DOWN (0 = hangs straight down, 90 = points right, 180 = points straight
// up, -90 = points left) -- angle2 is relative to angle1 (0 keeps the limb
// straight; nonzero bends it at the elbow/knee). Returns the limb's end
// point, unused here but kept for symmetry with the rest of the rig.
function stickLimb(ctx, origin, angle1, len1, angle2, len2, u) {
  const a1 = (angle1 * Math.PI) / 180;
  const p1 = { x: origin.x + Math.sin(a1) * len1 * u, y: origin.y + Math.cos(a1) * len1 * u };
  const a2 = ((angle1 + angle2) * Math.PI) / 180;
  const p2 = { x: p1.x + Math.sin(a2) * len2 * u, y: p1.y + Math.cos(a2) * len2 * u };
  ctx.beginPath();
  ctx.moveTo(origin.x, origin.y);
  ctx.lineTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.stroke();
  return p2;
}

const STICK_HEAD_R = 0.42;
const STICK_TORSO = 1.5;
const STICK_UPPER = 0.75;
const STICK_LOWER = 0.7;
const STICK_THIGH = 0.85;
const STICK_SHIN = 0.85;

// Named arm/leg angle pairs -- [angle1, angle2] each, see stickLimb.
// `lean` (units of u) shifts the shoulder/head sideways from the hip;
// `rotate` (degrees) spins the WHOLE figure around the hip (see
// drawStickFigure) -- used for "windy" (leaning into it) and "surfing"
// (crouched). Only the poses moodForBeachData actually picks are defined
// here, kept intentionally small.
const STICK_POSES = {
  standing: { armL: [-12, 0], armR: [12, 0], legL: [-10, 0], legR: [10, 0] },
  pointing: { armL: [-12, 0], armR: [80, 0], legL: [-10, 0], legR: [10, 0] },
  // Relaxed/casual -- arms crossed, one foot kicked out. A true reclined
  // "leaned back in a beach chair" pose isn't reachable with this rig
  // (rotate spins the legs along with the torso, which doesn't look like
  // sitting), so this leans on posture instead: arms crossed reads as
  // relaxed/confident even standing upright, and covers low tide, a
  // calm default day, AND stargazing at night (see moodForBeachData).
  lounging: { armL: [65, -55], armR: [-65, 55], legL: [-18, 0], legR: [30, -12] },
  // Upper arm swings out and up (145 degrees -- well past horizontal)
  // BEFORE going vertical, so the hand ends up clear of the head instead
  // of the arm passing straight through it. The umbrella prop is placed
  // at a fixed offset above this exact arm, see BUDDY_PROP_OFFSET.
  umbrella: { armL: [-14, 0], armR: [145, 0], legL: [-14, 0], legR: [14, 0] },
  windy: { armL: [-42, 24], armR: [102, -14], legL: [-34, 0], legR: [12, 0], rotate: -16 },
  surfing: { armL: [-100, 18], armR: [100, -18], legL: [-46, 0], legR: [46, 0], rotate: -8 }
};

// Draws one stick figure WITH a small face (two dot eyes, a smile arc) --
// unlike a generic faceless stick figure, personality is the whole point
// here, so the face is always on, not optional. `hipX,hipY` is the
// figure's HIP point, not its feet -- torso/head go up from there, legs
// go down.
function drawStickFigure(ctx, hipX, hipY, u, poseName) {
  const pose = STICK_POSES[poseName] || STICK_POSES.standing;
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  ctx.lineWidth = Math.max(2, u * 0.16);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const rotateRad = ((pose.rotate || 0) * Math.PI) / 180;
  ctx.save();
  ctx.translate(hipX, hipY);
  if (rotateRad) ctx.rotate(rotateRad);

  const lean = (pose.lean || 0) * u;
  const shoulder = { x: lean, y: -STICK_TORSO * u };
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(shoulder.x, shoulder.y);
  ctx.stroke();

  const headR = STICK_HEAD_R * u;
  const headCenter = { x: shoulder.x + lean * 0.3, y: shoulder.y - headR * 1.15 };
  ctx.beginPath();
  ctx.arc(headCenter.x, headCenter.y, headR, 0, Math.PI * 2);
  ctx.stroke();

  // Two dot eyes + a smiling mouth arc -- deliberately tiny and simple
  // (this head is only ~30-35px across at the sizes this card uses), but
  // this is the single biggest thing that makes the figure read as a
  // friendly character rather than a bare diagram.
  const eyeR = Math.max(1, headR * 0.13);
  const eyeDX = headR * 0.36, eyeDY = -headR * 0.04;
  ctx.beginPath();
  ctx.arc(headCenter.x - eyeDX, headCenter.y + eyeDY, eyeR, 0, Math.PI * 2);
  ctx.arc(headCenter.x + eyeDX, headCenter.y + eyeDY, eyeR, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.lineWidth = Math.max(1.5, u * 0.07);
  ctx.arc(headCenter.x, headCenter.y + headR * 0.12, headR * 0.42, 0.12 * Math.PI, 0.88 * Math.PI);
  ctx.stroke();
  ctx.lineWidth = Math.max(2, u * 0.16);

  stickLimb(ctx, shoulder, pose.armL[0], STICK_UPPER, pose.armL[1], STICK_LOWER, u);
  stickLimb(ctx, shoulder, pose.armR[0], STICK_UPPER, pose.armR[1], STICK_LOWER, u);
  stickLimb(ctx, { x: 0, y: 0 }, pose.legL[0], STICK_THIGH, pose.legL[1], STICK_SHIN, u);
  stickLimb(ctx, { x: 0, y: 0 }, pose.legR[0], STICK_THIGH, pose.legR[1], STICK_SHIN, u);

  ctx.restore();
}

// Small decorative icons in the same simple line-art style as the design
// tool's own sticker library (circles/arcs/lines, solid black ink, no
// fine gradients that would vanish under a 1-bit threshold).
function drawProp(ctx, kind, x, y, s) {
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  ctx.lineWidth = Math.max(2, s * 0.08);
  ctx.lineCap = "round";
  if (kind === "sun") {
    ctx.beginPath();
    ctx.arc(x, y, s * 0.35, 0, Math.PI * 2);
    ctx.stroke();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a) * s * 0.5, y + Math.sin(a) * s * 0.5);
      ctx.lineTo(x + Math.cos(a) * s * 0.72, y + Math.sin(a) * s * 0.72);
      ctx.stroke();
    }
  } else if (kind === "cloud") {
    ctx.beginPath();
    ctx.arc(x - s * 0.3, y, s * 0.28, Math.PI * 0.5, Math.PI * 1.5);
    ctx.arc(x, y - s * 0.15, s * 0.32, Math.PI, Math.PI * 1.9);
    ctx.arc(x + s * 0.32, y, s * 0.26, Math.PI * 1.4, Math.PI * 0.5);
    ctx.lineTo(x - s * 0.3, y + s * 0.28);
    ctx.closePath();
    ctx.stroke();
  } else if (kind === "moon") {
    ctx.beginPath();
    ctx.arc(x, y, s * 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(x + s * 0.18, y, s * 0.36, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === "star") {
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + (i * 4 * Math.PI) / 5;
      const px = x + Math.cos(a) * s * 0.5, py = y + Math.sin(a) * s * 0.5;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();
  } else if (kind === "wave") {
    ctx.beginPath();
    ctx.moveTo(x - s, y);
    for (let i = -s; i < s; i += s / 4) {
      ctx.quadraticCurveTo(x + i + s / 8, y - s * 0.18, x + i + s / 4, y);
    }
    ctx.stroke();
  } else if (kind === "umbrella") {
    ctx.beginPath();
    ctx.arc(x, y, s * 0.42, Math.PI, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - s * 0.42, y);
    ctx.lineTo(x + s * 0.42, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y - s * 0.05);
    ctx.lineTo(x, y + s * 0.5);
    ctx.stroke();
  } else if (kind === "windLines") {
    for (let i = 0; i < 3; i++) {
      const yy = y + i * s * 0.28 - s * 0.28;
      ctx.beginPath();
      ctx.moveTo(x - s * 0.5, yy);
      ctx.lineTo(x + s * 0.5 - i * s * 0.1, yy);
      ctx.stroke();
    }
  } else if (kind === "surfboard") {
    // Horizontal, lying flat under the figure's feet -- a vertical board
    // reads as a shield/wall beside the figure instead.
    ctx.beginPath();
    ctx.ellipse(x, y, s * 0.75, s * 0.16, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - s * 0.65, y);
    ctx.lineTo(x + s * 0.65, y);
    ctx.stroke();
  }
}

// Fixed (dx, dy) offsets from the figure's hip, in units of u -- simpler
// and more reliable than computing a rotated pose's actual hand/foot
// position, and each is tuned to sit naturally against the one pose it's
// paired with in moodForBeachData (e.g. "umbrella" the prop only ever
// appears with the "umbrella" pose's raised hand).
const BUDDY_PROP_OFFSET = {
  umbrella: { dx: 1.15, dy: -2.95 },
  wave: { dx: 0, dy: 1.9 },
  moon: { dx: 1.7, dy: -2.1 },
  star: { dx: -1.7, dy: -2.3 },
  windLines: { dx: -1.7, dy: -0.7 },
  surfboard: { dx: 0, dy: 1.75 }
};

// Picks today's headline + pose from the SAME payload fetchTideCardData
// already returns for the "tide" type -- no separate data source. Rules
// are checked in priority order (rain beats wind beats surf beats tide
// timing beats the calm-day default, with tonight's moon as a last-
// resort fallback), and every branch degrades gracefully when a field
// is missing (a down Open-Meteo call leaves data.weather null, same
// contract as the Tide & Fishing card).
//
// Rewritten to judge rain/wind/swell/tide against a fixed BUSINESS
// HOURS window (10:00am-4:30pm local, see businessHoursStart/End in
// fetchTideCardData) instead of the literal instant `now` happens to
// be. The reason: this card's own daily refresh (regenerateCountdownDesigns
// in index.js) runs once a day, overnight -- checking "is it raining/
// windy/surfing/is there a tide RIGHT NOW" at 4-5am local (as this used
// to) meant those branches were almost never true for a real device,
// since it's before dawn nearly everywhere in the US: the card
// defaulted to the nighttime moon-phase branch almost every single day,
// regardless of what the actual day ahead looked like. Checking
// forecast conditions across business hours instead means the card
// reflects "what will today look like," reachable at any generation
// time -- exactly what a once-a-day forecast card should do. The
// nighttime moon-phase branch still exists, just demoted to a fallback
// for whenever NONE of the business-hours signals fire AND the render
// itself is happening at night (the live design-tool preview opened in
// the evening, or the daily job running pre-dawn on an otherwise calm
// day) -- so it's still reachable, just no longer the default outcome
// for most days.
function moodForBeachData(data, now) {
  const at = now || new Date();
  const nowMs = at.getTime();
  const weather = data.weather || {};
  const bhStartMs = data.businessHoursStart ? new Date(data.businessHoursStart.t).getTime() : null;
  const bhEndMs = data.businessHoursEnd ? new Date(data.businessHoursEnd.t).getTime() : null;
  const overlapsBusinessHours = (startMs, endMs) => bhStartMs != null && bhEndMs != null && startMs <= bhEndMs && endMs >= bhStartMs;

  const rainWindows = weather.rainWindows || [];
  const businessRain = rainWindows.find((w) => overlapsBusinessHours(new Date(w.start).getTime(), new Date(w.end).getTime()));
  if (businessRain) {
    const activeNow = nowMs >= new Date(businessRain.start).getTime() && nowMs <= new Date(businessRain.end).getTime();
    return {
      pose: "umbrella",
      headline: activeNow ? "RAINY DAY" : "RAIN LATER",
      sub: businessRain.label.replace("RAIN LIKELY ", ""),
      props: ["umbrella"]
    };
  }

  // A real business-hours forecast peak (not "right now") beats
  // needing an explicit ramp pattern -- a day that's just uniformly
  // windy all afternoon is still windy, ramp or no ramp.
  const windRamp = weather.windRamp;
  const bhWindMph = weather.businessHoursWind ? weather.businessHoursWind.mph : null;
  if (windRamp || (bhWindMph != null && bhWindMph >= 20)) {
    return {
      pose: "windy",
      headline: "WINDY",
      sub: windRamp ? windRamp.gustMph + " MPH GUSTS" : bhWindMph + " MPH",
      props: ["windLines"]
    };
  }

  const bhSwellFt = weather.businessHoursSwell ? weather.businessHoursSwell.heightFt : null;
  if (bhSwellFt != null && bhSwellFt >= 3) {
    return { pose: "surfing", headline: "SURF'S UP", sub: bhSwellFt + " FT SWELL", props: ["surfboard"] };
  }

  // Only a tide actually falling inside business hours is headline-
  // worthy -- an early-morning or late-evening tide isn't something
  // anyone glancing at their desk during the day will ever see happen.
  // extrema is chronological, so the LAST one remaining after filtering
  // to the window is the LATER of however many qualify -- not the
  // earliest/soonest, which is what a plain "next upcoming" pick would
  // give.
  const extrema = data.tideExtrema || [];
  const businessTides = bhStartMs != null && bhEndMs != null
    ? extrema.filter((e) => { const t = new Date(e.t).getTime(); return t >= bhStartMs && t <= bhEndMs; })
    : [];
  const headlineTide = businessTides.length ? businessTides[businessTides.length - 1] : null;
  if (headlineTide) {
    return {
      pose: headlineTide.isHigh ? "pointing" : "lounging",
      headline: (headlineTide.isHigh ? "HIGH TIDE " : "LOW TIDE ") + headlineTide.label,
      sub: null,
      props: ["wave"]
    };
  }

  // Nothing notable is forecast for business hours -- if this render is
  // actually happening at night, show tonight's moon instead of a bland
  // default; otherwise it really is just a calm, unremarkable day.
  const daytime = !!(data.sunrise && data.sunset && nowMs >= new Date(data.sunrise.t).getTime() && nowMs <= new Date(data.sunset.t).getTime());
  if (!daytime) {
    return {
      pose: "lounging",
      headline: (data.moon.phaseName || "CLEAR NIGHT").toUpperCase(),
      sub: null,
      props: ["moon", "star"]
    };
  }

  return {
    pose: "lounging",
    headline: "PERFECT DAY",
    sub: weather.waterTempF != null ? "WATER " + weather.waterTempF + "°F" : null,
    props: []
  };
}

const BUDDY_HIP_X = CANVAS_WIDTH / 2;
const BUDDY_HIP_Y = 195;
const BUDDY_FIGURE_U = 40;

// Used by the procedural fallback only (drawBeachBuddyCard) -- no black
// title banner and no border, meant to read as a friendly greeting, not
// a data card, so it's just one big headline and an optional short
// subline before the character itself. The AI art card
// (drawBeachBuddyArtCard) does NOT use this -- it needs a real banner,
// see its own comment for why.
function drawBeachBuddyHeadline(ctx, mood) {
  ctx.fillStyle = INK;
  ctx.textAlign = "center";
  const headlineSize = fitBannerFontSize(ctx, mood.headline, CANVAS_WIDTH - 48, FONT_FAMILY.block, 52, 30);
  ctx.font = headlineSize + "px \"" + FONT_FAMILY.block + "\"";
  ctx.fillText(mood.headline, CANVAS_WIDTH / 2, 54);

  if (mood.sub) {
    ctx.font = "bold 20px \"" + FONT_FAMILY.serif + "\"";
    ctx.fillText(mood.sub, CANVAS_WIDTH / 2, 82);
  }
}

// The procedural vector-line fallback -- used whenever Imagen art isn't
// available (generation failed, or wasn't attempted, e.g. in tests).
function drawBeachBuddyCard(ctx, mood) {
  drawBeachBuddyHeadline(ctx, mood);

  drawStickFigure(ctx, BUDDY_HIP_X, BUDDY_HIP_Y, BUDDY_FIGURE_U, mood.pose);

  (mood.props || []).forEach((kind) => {
    const off = BUDDY_PROP_OFFSET[kind] || { dx: 1.5, dy: -1 };
    drawProp(ctx, kind, BUDDY_HIP_X + off.dx * BUDDY_FIGURE_U, BUDDY_HIP_Y + off.dy * BUDDY_FIGURE_U, BUDDY_FIGURE_U * 1.7);
  });
}

// Fills a `width x height` canvas EDGE TO EDGE with sourceImage -- a
// cover-fit crop (scales by the LARGER of the two ratios, so the image
// always fully covers the target with no white margin, cropping
// whichever dimension overflows), unlike a logo's contain-fit (which
// pads with white specifically to avoid ever cropping the logo). A
// live test of the first (contain-fit, small centered panel) version of
// this card came back reading as a stamp-sized afterthought, not a real
// screen -- this fills the whole card the way the reference "WANTED
// poster" joke image did. Dithered with the same Atkinson algorithm
// already used for team logos (ditheredLogoCanvas above): a flat,
// mostly-2-color illustration (see imagen.js's STYLE_PREFIX) dithers
// into clean, crisp linework, unlike a plain luminance threshold which
// would lose soft anti-aliased edges the model's own renderer leaves
// behind.
function ditheredArtCoverCanvas(sourceImage, width, height) {
  const padded = createCanvas(width, height);
  const pctx = padded.getContext("2d");
  pctx.fillStyle = "#fff";
  pctx.fillRect(0, 0, width, height);
  const scale = Math.max(width / sourceImage.width, height / sourceImage.height);
  const w = sourceImage.width * scale, h = sourceImage.height * scale;
  pctx.drawImage(sourceImage, (width - w) / 2, (height - h) / 2, w, h);

  const imgData = pctx.getImageData(0, 0, width, height).data;
  const gray = toGrayscale(imgData, width, height);
  const bits = ditherAtkinson(gray, width, height);

  const out = createCanvas(width, height);
  const octx = out.getContext("2d");
  const id = octx.createImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    const on = !!bits[i];
    const v = on ? 0 : 255;
    id.data[i * 4] = v; id.data[i * 4 + 1] = v; id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255;
  }
  octx.putImageData(id, 0, 0);
  return out;
}

// `artImage` is a loaded (node-canvas Image) Imagen illustration,
// filling the ENTIRE card below the banner, edge to edge -- a solid
// black title banner (same convention every other full-screen card here
// uses: Game Day, News) is what keeps the headline legible regardless
// of how busy the art underneath it is; the earlier no-banner design
// only worked for the procedural card's guaranteed-plain-white
// background, not for real illustrated art.
function drawBeachBuddyArtCard(ctx, mood, artImage) {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, CANVAS_WIDTH, BANNER_HEIGHT);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  const headlineText = mood.sub ? mood.headline + "  ·  " + mood.sub : mood.headline;
  const headlineSize = fitBannerFontSize(ctx, headlineText, CANVAS_WIDTH - 40, FONT_FAMILY.block, 24, 14);
  ctx.font = headlineSize + "px \"" + FONT_FAMILY.block + "\"";
  ctx.fillText(headlineText, CANVAS_WIDTH / 2, BANNER_HEIGHT / 2 + Math.round(headlineSize * 0.35));

  const artHeight = CANVAS_HEIGHT - BANNER_HEIGHT;
  const dithered = ditheredArtCoverCanvas(artImage, CANVAS_WIDTH, artHeight);
  ctx.drawImage(dithered, 0, BANNER_HEIGHT);
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
// on a device. "beachBuddy" follows the same rule for its own tide/
// weather data (via fetchTideCardData) -- a failure there still throws --
// but NOT for the Imagen art itself, which degrades to the procedural
// stick-figure card instead, same principle as a failed logo fetch.
//
// `beachBuddyArtImpl`, when given, replaces the real Imagen call (see
// generateBeachBuddyArt in lib/imagen.js) -- injected by tests so they
// never need real Vertex AI credentials, same convention as `fetchImpl`.
async function renderDynamicDesign(basePngBuffer, meta, now, fetchImpl, beachBuddyArtImpl) {
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

    const [myLogoCanvas, oppLogoCanvas, myRecord, oppRecord] = await Promise.all([
      fetchDitheredLogo(myLogoUrl, LOGO_SIZE, fetchImpl),
      fetchDitheredLogo(rawNextGame.opponentLogo, LOGO_SIZE, fetchImpl),
      fetchTeamRecord(meta.sport, meta.league, meta.teamId, fetchImpl),
      fetchTeamRecord(meta.sport, meta.league, rawNextGame.opponentTeamId, fetchImpl)
    ]);

    const headline = (myAbbrev || "") + " " + vsOrAt + " " + rawNextGame.opponentAbbrev;
    const daysUnit = daysLeft === 1 ? "DAY" : "DAYS";
    // Kept as one string purely for the log-friendly `content` field
    // below -- drawGameDayCard takes daysLeft/daysUnit directly instead
    // of a pre-formatted label, since it renders them as 3 separate lines
    // now, not one.
    const daysLabel = daysLeft <= 0 ? "TODAY!" : "IN " + daysLeft + " " + daysUnit;
    const dateTimeParts = formatGameDateTimeParts(rawNextGame.gameDateISO);
    const card = {
      bannerTitle: gameDayBannerTitle(meta.sport, meta.league),
      headline,
      daysLeft,
      daysUnit,
      venue: rawNextGame.venue,
      dateLabel: dateTimeParts ? dateTimeParts.dateLabel : null,
      timeLabel: dateTimeParts ? dateTimeParts.timeLabel : null,
      myLogo: myLogoCanvas,
      oppLogo: oppLogoCanvas,
      myRecord,
      oppRecord
    };

    const result = await compositeAndPack(basePngBuffer, (ctx) => drawGameDayCard(ctx, card), meta);
    const nextGame = Object.assign({}, rawNextGame, { daysLeft });
    return Object.assign(result, {
      nextGame, myAbbrev,
      content: headline + " " + daysLabel,
      hasMyLogo: !!myLogoCanvas, hasOppLogo: !!oppLogoCanvas,
      myRecord, oppRecord
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

  if (meta.type === "tide") {
    const data = await fetchTideCardData({ lat: meta.lat, lon: meta.lon, stationId: meta.stationId }, now, fetchImpl);
    const result = await compositeAndPack(basePngBuffer, (ctx) => drawTideCard(ctx, data), meta);
    const extremaSummary = data.tideExtrema.map((e) => (e.isHigh ? "H" : "L") + " " + e.label).join(", ");
    return Object.assign(result, { tideData: data, content: data.moon.phaseName + " -- " + extremaSummary });
  }

  if (meta.type === "tideTimeline") {
    const data = await fetchTideTimelineData({ lat: meta.lat, lon: meta.lon, stationId: meta.stationId }, now, fetchImpl);
    const card = Object.assign({}, data, {
      townName: (meta.townName || "").toUpperCase(),
      dateLabel: formatLongDate(new Date(data.dayStart), data.timeZone)
    });
    const result = await compositeAndPack(basePngBuffer, (ctx) => drawTideTimelineCard(ctx, card), meta);
    const tideSummary = data.tideExtrema.map((e) => (e.isHigh ? "H" : "L") + " " + e.label).join(", ");
    return Object.assign(result, { timelineData: data, content: card.townName + " -- " + tideSummary });
  }

  if (meta.type === "beachBuddy") {
    const data = await fetchTideCardData({ lat: meta.lat, lon: meta.lon, stationId: meta.stationId }, now, fetchImpl);
    const mood = moodForBeachData(data, now);

    let artImage = null;
    try {
      const generate = beachBuddyArtImpl || ((m) => generateBeachBuddyArt(m, {
        project: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT,
        location: "us-central1"
      }));
      artImage = await loadImage(await generate(mood));
    } catch (err) {
      // Imagen is a nice-to-have layered on top of the real tide/weather-
      // driven mood, not load-bearing -- a bad/blocked/unreachable
      // generation should never take the whole card down, just fall back
      // to the procedural stick-figure version of the exact same mood
      // (drawBeachBuddyCard), same principle as fetchDitheredLogo
      // degrading to "no logo" rather than failing the Game Day card.
      console.error("Beach Buddy art generation failed, falling back to the procedural card:", err);
    }

    const drawFn = artImage
      ? (ctx) => drawBeachBuddyArtCard(ctx, mood, artImage)
      : (ctx) => drawBeachBuddyCard(ctx, mood);
    const result = await compositeAndPack(basePngBuffer, drawFn, meta);
    return Object.assign(result, {
      beachData: data,
      mood: mood.headline,
      usedArt: !!artImage,
      content: mood.headline + (mood.sub ? " -- " + mood.sub : "")
    });
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
  formatGameDateTimeParts,
  drawGameLine,
  findNextGame,
  fetchNextGame,
  fetchTeamRecord,
  espnScheduleUrl,
  espnTeamsUrl,
  espnTeamUrl,
  gameDayBannerTitle,
  extractLogoUrl,
  extractVenueName,
  extractRecordSummary,
  fitRecordOverLogo,
  buildPaddedRecordHeadline,
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
  wrapToLines,
  drawNewsCard,
  formatShortDate,
  drawMoonIcon,
  drawTideCard,
  drawTideTimelineCard,
  drawTimelineMoonIcon,
  timelineIsNearMidnightEdge,
  renderDynamicDesign,
  ensureFontsRegistered,
  STICK_POSES,
  drawStickFigure,
  drawProp,
  moodForBeachData,
  drawBeachBuddyCard,
  drawBeachBuddyArtCard,
  ditheredArtCoverCanvas
};
