const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const { PrismaClient } = require("@prisma/client");
const { z } = require("zod");

const prisma = new PrismaClient();
const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

/**
 * =========
 * State map
 * =========
 * CSV expected: data/state_abbr.csv with headers: name,abbr
 * Includes US states + DC + Canada provinces/territories
 */
const STATE_CSV_PATH =
  process.env.STATE_CSV_PATH ||
  path.join(__dirname, "..", "data", "state_abbr.csv");

const stateNameToAbbr = new Map(); // "texas" -> "TX"
const stateAbbrToName = new Map(); // "tx" -> "Texas"

function normText(s) {
  if (!s) return null;
  return String(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * =========
 * City cleanup helpers
 * =========
 */
function stripLeadingTime(s) {
  let t = String(s || "").trim();

  // 12h: 02:00 PM / 2:00PM
  t = t.replace(/^\s*\d{1,2}:\d{2}\s*(AM|PM)\s+/i, "");

  // 24h: 02:00 / 19:30
  t = t.replace(/^\s*\d{1,2}:\d{2}\s+/, "");

  return t.trim();
}

function cityCandidateFromMessyString(s) {
  let t = String(s || "").trim();
  if (!t) return null;

  // 1) если это "02:00 PM Idaho Falls" — уберём время
  t = stripLeadingTime(t);

  // 2) если внутри есть "Tickets" — берем всё, что ПОСЛЕ него
  // (Post Malone ... Tickets 2026-05-13 El Paso -> "2026-05-13 El Paso")
  const mTickets = /\btickets\b/i.exec(t);
  if (mTickets) {
    t = t.slice(mTickets.index + mTickets[0].length).trim();
  }

  // 3) убираем ISO дату YYYY-MM-DD (самый частый мусор)
  t = t.replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ");

  // 4) убрать дни недели/месяцы/числа дат (на всякий)
  t = t.replace(/\b(mon|tue|wed|thu|fri|sat|sun)\b/gi, " ");
  t = t.replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b/gi, " ");
  t = t.replace(/\b\d{1,2}(st|nd|rd|th)?\b/gi, " ");

  // 5) убрать явные шум-слова (иногда в city прилетает кусок заголовка)
  // NOTE: тут сознательно короткий список, чтобы не вырезать настоящие города
  t = t.replace(/\b(presents?|tour|part|show|stadium|arena|the|big|ass|tickets?)\b/gi, " ");

  t = t.replace(/\s+/g, " ").trim();

  const parts = t.split(" ").filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length <= 3) return t;

  // если всё ещё длинно — берём последние 2-3 слова (чаще всего это и есть город)
  const last2 = parts.slice(-2).join(" ");
  const last3 = parts.slice(-3).join(" ");
  // если last2 выглядит адекватно (только буквы/пробелы) — предпочтем его
  if (/^[a-zA-Z\s]+$/.test(last2)) return last2;
  return last3;
}

/**
 * City variants:
 * - handle Fort <-> Ft
 * - handle Saint <-> St
 * - handle specific aliases (West Valley City -> Salt Lake City)
 */
const CITY_ALIASES = new Map([
  ["west valley city", ["salt lake city"]]
]);

function cityVariants(rawCity) {
  const cleaned = cityCandidateFromMessyString(rawCity || "");
  const base = normText(cleaned || "");
  if (!base) return [];

  const out = new Set();
  out.add(base);

  // aliases
  const ali = CITY_ALIASES.get(base);
  if (ali && Array.isArray(ali)) {
    for (const a of ali) {
      const nn = normText(a);
      if (nn) out.add(nn);
    }
  }

  // ft <-> fort, st <-> saint (only first token)
  const parts = base.split(" ").filter(Boolean);
  if (parts.length >= 2) {
    const head = parts[0];
    const tail = parts.slice(1).join(" ");

    if (head === "ft") out.add(`fort ${tail}`);
    if (head === "fort") out.add(`ft ${tail}`);

    if (head === "st") out.add(`saint ${tail}`);
    if (head === "saint") out.add(`st ${tail}`);
  }

  return Array.from(out);
}

function loadStateMaps() {
  try {
    if (!fs.existsSync(STATE_CSV_PATH)) {
      console.warn(
        `[states] CSV not found at ${STATE_CSV_PATH} (state matching will be best-effort)`
      );
      return;
    }

    const csvText = fs.readFileSync(STATE_CSV_PATH, "utf-8");
    const records = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });

    for (const r of records) {
      const nameRaw = (r.name || "").trim();
      const abbrRaw = (r.abbr || "").trim();
      if (!nameRaw || !abbrRaw) continue;

      const nameKey = normText(nameRaw);
      const abbrKey = String(abbrRaw).trim().toLowerCase();

      if (nameKey) stateNameToAbbr.set(nameKey, abbrRaw.toUpperCase());
      if (abbrKey) stateAbbrToName.set(abbrKey, nameRaw);
    }

    console.log(
      `[states] loaded: ${stateNameToAbbr.size} names, ${stateAbbrToName.size} abbrs`
    );
  } catch (e) {
    console.warn("[states] failed to load:", e?.message || e);
  }
}
loadStateMaps();

/**
 * Accepts:
 * - "TX" / "tx"
 * - "Texas"
 * - "Ontario" / "ON"
 * Returns { stateFull, stateAbbr, stateNorm } or null if cannot resolve.
 */
function normalizeState(inputState) {
  const raw = String(inputState || "").trim();
  if (!raw) return null;

  // Abbr
  if (/^[A-Za-z]{2,3}$/.test(raw)) {
    const abbr = raw.toUpperCase();
    const full = stateAbbrToName.get(raw.toLowerCase());
    if (full) {
      return { stateFull: full, stateAbbr: abbr, stateNorm: normText(full) };
    }
    return { stateFull: null, stateAbbr: abbr, stateNorm: null };
  }

  // Full
  const fullKey = normText(raw);
  if (!fullKey) return null;
  const abbr = stateNameToAbbr.get(fullKey) || null;
  return { stateFull: raw, stateAbbr: abbr, stateNorm: fullKey };
}

function parseDateDayFromYMD(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || "");
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 0, 0, 0));
}

function todayUtcMidnight() {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0)
  );
}

function toTime12(time24) {
  if (!time24) return null;
  const m = /^(\d{2}):(\d{2})$/.exec(time24);
  if (!m) return null;
  let hh = +m[1];
  const mm = m[2];
  const ampm = hh >= 12 ? "PM" : "AM";
  hh = hh % 12;
  if (hh === 0) hh = 12;
  return `${hh}:${mm} ${ampm}`;
}

function money(cents) {
  if (cents == null) return null;
  return (cents / 100).toFixed(2);
}

function estAfterPromo(priceMinCents, promoPercent) {
  if (priceMinCents == null) return null;
  const p = promoPercent == null ? 0 : promoPercent;
  return Math.round(priceMinCents * (1 - p / 100));
}

/**
 * =========
 * Slug + links (server-side)
 * =========
 */
function slugifyPerformerName(name) {
  if (!name) return null;
  let s = String(name).trim();
  if (!s) return null;

  s = s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  s = s.replace(/&/g, " and ");
  s = s.replace(/'/g, "");
  s = s.toLowerCase();
  s = s.replace(/[^a-z0-9]+/g, " ");
  s = s.trim().replace(/\s+/g, "-");
  s = s.replace(/-+/g, "-").replace(/^-|-$/g, "");

  return s || null;
}

function buildPerformerLinks(performerName) {
  const slug = slugifyPerformerName(performerName);
  if (!slug) return { slug: null, links: null };

  return {
    slug,
    links: {
      geturtix: `https://geturtix.com/performers/${slug}`,
      tn: `https://www.ticketnetwork.com/e/performers/${slug}-tickets`,
      tl: `https://www.ticketliquidator.com/performers/${slug}-tickets`,
      sbs: `https://www.superboleteria.com/performers/${slug}-boletos`
    }
  };
}

/**
 * Try extract "performer-like" string from raw title.
 * MVP heuristics:
 * - cut after " | " or " - "
 * - remove obvious ticketing words
 */
function extractPerformerFromTitle(rawTitle) {
  const t0 = String(rawTitle || "").trim();
  if (!t0) return null;

  let t = t0.split(" | ")[0];
  t = t.split(" - ")[0];

  t = t.replace(/\b(tickets?|tour|events?)\b/gi, "").trim();
  t = t.replace(/\s+/g, " ").trim();

  if (t.length < 2) return null;
  return t;
}

/**
 * =========
 * Performer cleanup
 * =========
 * Fix cases like:
 * - "The Hondo Rodeo Fest - 3 Day Package"
 * - "2026 MEAC ... Mar 11-14, 2026, Sess 1-7"
 */
const MONTH_TOKEN_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b/i;

function cleanPerformerPicked(s) {
  let t = String(s || "").trim();
  if (!t) return null;

  // Remove leading "The "
  t = t.replace(/^\s*the\s+/i, "");

  // If a month appears, everything after it is usually date/garbage in titles
  const mMonth = MONTH_TOKEN_RE.exec(t);
  if (mMonth) {
    t = t.slice(0, mMonth.index).trim();
  }

  // Remove "3 Day Package", "Day Package", "Package"
  t = t.replace(/\b\d+\s*day\s*package\b/gi, " ");
  t = t.replace(/\bday\s*package\b/gi, " ");
  t = t.replace(/\bpackage\b/gi, " ");

  // Remove session tokens
  t = t.replace(/\b(sess(ion)?)\b[^,]*$/gi, " ");
  t = t.replace(/\b(sess(ion)?)\s*\d+(-\d+)?\b/gi, " ");

  // Collapse spaces
  t = t.replace(/\s+/g, " ").trim();

  return t || null;
}

/**
 * =========
 * UPCOMING soft filters (MVP)
 * =========
 * Exclude "Parking" listings ONLY in upcoming-mode (no-date).
 * We do NOT exclude it in exact mode, because user might be on a parking page.
 */
function upcomingExcludeWhere() {
  return {
    NOT: [{ eventName: { contains: "parking", mode: "insensitive" } }]
  };
}

/**
 * =========
 * Performer query degradation
 * =========
 */
const STOP_WORDS = new Set([
  "tickets",
  "ticket",
  "tour",
  "events",
  "event",
  "show",
  "shows",
  "live",
  "official",
  "presents",
  "present",
  "featuring",
  "feat",
  "with",
  "and",
  "the",
  "a",
  "an",
  "parking",
  "day",
  "package",
  "sess",
  "session"
]);

function isStopWord(w) {
  return STOP_WORDS.has(String(w || "").toLowerCase());
}

function isYearToken(w) {
  const s = String(w || "").trim();
  return /^((19|20)\d{2})$/.test(s);
}

function filterPerformerWords(words) {
  return (words || [])
    .map((x) => String(x).trim())
    .filter(Boolean)
    .filter((w) => !isStopWord(w))
    .filter((w) => !isYearToken(w));
}

function buildWordVariants(words, mode) {
  // mode: "exact" | "upcoming"
  const w = (words || []).map((x) => String(x).trim()).filter(Boolean);
  const variants = [];
  if (!w.length) return variants;

  const seen = new Set();
  const push = (arr) => {
    if (!arr || !arr.length) return;
    const key = arr.join(" ");
    if (seen.has(key)) return;
    seen.add(key);
    variants.push(arr);
  };

  // 0) full
  push(w);

  // 1) prefixes: [w0..w(k)]
  for (let k = w.length - 1; k >= 1; k--) {
    const v = w.slice(0, k);

    if (v.length === 1) {
      const one = v[0].toLowerCase();

      if (isStopWord(one) || isYearToken(one)) continue;

      if (one.length < 3) {
        if (mode === "exact") push(v);
        continue;
      }

      if (mode === "upcoming") {
        if (one.length >= 4) push(v);
        continue;
      }
    }

    push(v);
  }

  // 2) suffixes: [w(i)..wn]
  for (let i = 1; i <= w.length - 1; i++) {
    const v = w.slice(i);

    if (v.length === 1) {
      const one = v[0].toLowerCase();

      if (isStopWord(one) || isYearToken(one)) continue;

      if (one.length < 3) {
        if (mode === "exact") push(v);
        continue;
      }

      if (mode === "upcoming") {
        if (one.length >= 4) push(v);
        continue;
      }
    }

    push(v);
  }

  return variants;
}

function buildPerformerWordClauses(words) {
  return words.map((w) => ({
    performerNorm: { contains: w, mode: "insensitive" }
  }));
}

function buildEventNameClauses(words) {
  return words.map((w) => ({
    eventName: { contains: w, mode: "insensitive" }
  }));
}

const MatchRequest = z.object({
  performer_query: z.string().optional().nullable(),
  raw_title: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  state: z.string().optional().nullable(),
  date_day: z.string().optional().nullable(), // YYYY-MM-DD
  time_24: z.string().optional().nullable() // HH:mm
});

app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/match", async (req, res) => {
  try {
    const input = MatchRequest.parse(req.body);

    // Option C: prefer performer_query, else extract from raw_title
    const performerFromQuery = String(input.performer_query || "").trim() || null;
    const performerFromTitle = input.raw_title
      ? extractPerformerFromTitle(input.raw_title)
      : null;

    // Clean performer string before matching variants
    const performerPickedRaw = performerFromQuery || performerFromTitle || null;
    const performerPicked = performerPickedRaw ? (cleanPerformerPicked(performerPickedRaw) || performerPickedRaw) : null;

    // Build words (then filter stopwords/years immediately)
    const performerNorm = normText(performerPicked || "");
    let performerWords = performerNorm ? performerNorm.split(" ").filter(Boolean) : [];
    performerWords = filterPerformerWords(performerWords);

    // City variants
    const cityNormVariants = cityVariants(input.city || "");
    const cityNorm = cityNormVariants[0] || "";

    const st = normalizeState(input.state);
    const stateNorm = st?.stateNorm || "";

    const dateDayRaw = input.date_day ? parseDateDayFromYMD(input.date_day) : null;
    const time24 = input.time_24 || null;

    // Fallback performer links always when we have performerPicked
    const fb = performerPicked
      ? buildPerformerLinks(performerPicked)
      : { slug: null, links: null };
    const fallback = performerPicked
      ? {
          performer_input: performerPicked,
          performer_source: performerFromQuery ? "performer_query" : "raw_title",
          performer_slug: fb.slug,
          performer_links: fb.links
        }
      : null;

    const today = todayUtcMidnight();

    // If date is provided but already in the past => treat as "no date"
    const dateIsPast = dateDayRaw ? dateDayRaw < today : false;
    const dateDay = dateIsPast ? null : dateDayRaw;

    // We require at least performer + city for *any* useful response
    if (!cityNorm || performerWords.length === 0) {
      return res.json({
        confidence: "low",
        reason: "missing_required_fields",
        matches: [],
        hint:
          "Need (performer_query or raw_title) + city. date_day optional; state/time optional.",
        fallback
      });
    }

    const cityOr = cityNormVariants.map((c) => ({ cityNorm: c }));

    /**
     * Helper: apply time tie-break (only when multiple results and time24 provided)
     */
    function applyTimeTiebreak(events) {
      let filtered = events;
      if (events.length > 1 && time24) {
        const byTime = events.filter((e) => (e.time24 || "") === time24);
        if (byTime.length) filtered = byTime;
      }
      return filtered;
    }

    /**
     * ================
     * Mode 1: Exact-ish event match (performer + city + date)
     * ================
     */
    if (dateDay) {
      const variants = buildWordVariants(performerWords, "exact");

      for (const words of variants) {
        // 1) Primary: match by Performer join (ALL words, case-insensitive)
        const performerWhere = {
          dateDay,
          ...(stateNorm ? { stateNorm } : {}),
          AND: [
            { OR: cityOr },
            {
              performers: {
                some: {
                  performer: {
                    AND: buildPerformerWordClauses(words)
                  }
                }
              }
            }
          ]
        };

        let events = await prisma.event.findMany({
          where: performerWhere,
          include: { offers: true, performers: { include: { performer: true } } },
          take: 25
        });

        // 2) Fallback: match by Event title text (ALL words, case-insensitive)
        if (!events.length) {
          events = await prisma.event.findMany({
            where: {
              dateDay,
              ...(stateNorm ? { stateNorm } : {}),
              AND: [{ OR: cityOr }, ...buildEventNameClauses(words)]
            },
            include: { offers: true, performers: { include: { performer: true } } },
            take: 25
          });
        }

        if (events.length) {
          const filtered = applyTimeTiebreak(events);
          return res.json({
            confidence: filtered.length === 1 ? "high" : "medium",
            reason: filtered.length === 1 ? "exact_or_tiebroken" : "multiple",
            matches: filtered.map(shapeEvent),
            fallback
          });
        }
      }
      // If exact match failed for all variants, fall through to upcoming mode
    }

    /**
     * ================
     * Mode 2: Upcoming events (performer + city, no date OR date was past OR exact failed)
     * ================
     */
    const upcomingSoft = upcomingExcludeWhere();
    const variants = buildWordVariants(performerWords, "upcoming");

    let upcoming = [];

    for (const words of variants) {
      const upcomingWhereByPerformer = {
        ...(stateNorm ? { stateNorm } : {}),
        dateDay: { gte: today },
        ...upcomingSoft,
        AND: [
          { OR: cityOr },
          {
            performers: {
              some: {
                performer: {
                  AND: buildPerformerWordClauses(words)
                }
              }
            }
          }
        ]
      };

      upcoming = await prisma.event.findMany({
        where: upcomingWhereByPerformer,
        include: { offers: true, performers: { include: { performer: true } } },
        orderBy: [{ dateDay: "asc" }, { time24: "asc" }],
        take: 4
      });

      // If nothing by performer join, try fallback by eventName contains
      if (!upcoming.length) {
        upcoming = await prisma.event.findMany({
          where: {
            ...(stateNorm ? { stateNorm } : {}),
            dateDay: { gte: today },
            ...upcomingSoft,
            AND: [{ OR: cityOr }, ...buildEventNameClauses(words)]
          },
          include: { offers: true, performers: { include: { performer: true } } },
          orderBy: [{ dateDay: "asc" }, { time24: "asc" }],
          take: 4
        });
      }

      if (upcoming.length) break;
    }

    if (!upcoming.length) {
      return res.json({
        confidence: "low",
        reason: "no_upcoming_in_city",
        matches: [],
        fallback
      });
    }

    const hasMoreThan3 = upcoming.length > 3;
    const sliced = upcoming.slice(0, 3);

    return res.json({
      confidence: "medium",
      reason: "upcoming_in_city",
      matches: sliced.map(shapeEvent),
      hint: hasMoreThan3 ? "add date for exact match" : null,
      fallback
    });
  } catch (e) {
    return res.status(400).json({ error: String(e) });
  }
});

function shapeEvent(e) {
  const offers = (e.offers || []).map((o) => ({
    source: o.source,
    url: o.url,
    tickets_yn: o.ticketsYn,
    base_price_min: money(o.priceMin),
    base_price_max: money(o.priceMax),
    promo_percent: o.promoPercent,
    est_after_promo: money(estAfterPromo(o.priceMin, o.promoPercent)),
    labels: {
      base: "Base price (excl. fees & taxes)",
      est: "Est. after promo (excl. fees & taxes)"
    }
  }));

  offers.sort((a, b) => {
    const ax = a.est_after_promo ?? a.base_price_min ?? "999999";
    const bx = b.est_after_promo ?? b.base_price_min ?? "999999";
    return Number(ax) - Number(bx);
  });

  const performerNames = (e.performers || [])
    .map((ep) => ep.performer?.name)
    .filter(Boolean);

  return {
    event_id: e.id,
    event_name: e.eventName,
    date_day: e.dateDay.toISOString().slice(0, 10),
    time_24: e.time24,
    time_12: toTime12(e.time24),
    city: e.city,
    state: e.state,
    venue: e.venue,
    performers: performerNames,
    tickets_yn: offers.some((o) => o.tickets_yn === true)
      ? true
      : offers.some((o) => o.tickets_yn === false)
        ? false
        : null,
    offers
  };
}

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`API listening on :${port}`));