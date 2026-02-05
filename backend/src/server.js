const express = require("express");
const cors = require("cors");
const { PrismaClient } = require("@prisma/client");
const { z } = require("zod");

const prisma = new PrismaClient();
const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

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

function parseDateDayFromYMD(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || "");
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 0, 0, 0));
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

const MatchRequest = z.object({
  performer_query: z.string().min(1),
  city: z.string().optional().nullable(),
  state: z.string().optional().nullable(),
  date_day: z.string().optional().nullable(), // YYYY-MM-DD
  time_24: z.string().optional().nullable()   // HH:mm
});

app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/match", async (req, res) => {
  try {
    const input = MatchRequest.parse(req.body);

    const performerNorm = normText(input.performer_query);
    const performerWords = performerNorm ? performerNorm.split(" ") : [];

    const cityNorm = normText(input.city || "");
    const stateNorm = normText(input.state || "");
    const dateDay = input.date_day ? parseDateDayFromYMD(input.date_day) : null;
    const time24 = input.time_24 || null;

    if (!dateDay || !performerNorm || !cityNorm) {
      return res.json({
        confidence: "low",
        reason: "missing_required_fields",
        matches: [],
        hint: "Need performer_query + city + date_day. State/time are optional."
      });
    }

    // 1) Primary strategy: match by linked Performer rows
    const performerWhere = {
      dateDay,
      cityNorm,
      ...(stateNorm ? { stateNorm } : {}),
      performers: {
        some: {
          performer: {
            AND: performerWords.map(w => ({
              performerNorm: { contains: w }
            }))
          }
        }
      }
    };

    let events = await prisma.event.findMany({
      where: performerWhere,
      include: {
        offers: true,
        performers: { include: { performer: true } }
      },
      take: 25
    });

    // 2) Fallback strategy: match by Event name text
    // This solves cases where the "artist" appears in Event title,
    // but the linked Performer is a brand/festival/rodeo/etc.
    if (!events.length) {
      const eventNameClauses = performerWords.map(w => ({
        eventName: { contains: w }
      }));

      events = await prisma.event.findMany({
        where: {
          dateDay,
          cityNorm,
          ...(stateNorm ? { stateNorm } : {}),
          AND: eventNameClauses
        },
        include: {
          offers: true,
          performers: { include: { performer: true } }
        },
        take: 25
      });
    }

    if (!events.length) {
      return res.json({
        confidence: "low",
        reason: "no_match",
        matches: []
      });
    }

    // Tie-breaker by time if needed
    let filtered = events;
    if (events.length > 1 && time24) {
      const byTime = events.filter(e => (e.time24 || "") === time24);
      if (byTime.length) filtered = byTime;
    }

    return res.json({
      confidence: filtered.length === 1 ? "high" : "medium",
      reason: filtered.length === 1 ? "exact_or_tiebroken" : "multiple",
      matches: filtered.map(shapeEvent)
    });
  } catch (e) {
    return res.status(400).json({ error: String(e) });
  }
});

function shapeEvent(e) {
  const offers = (e.offers || []).map(o => ({
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
    .map(ep => ep.performer?.name)
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
    tickets_yn:
      offers.some(o => o.tickets_yn === true) ? true :
      offers.some(o => o.tickets_yn === false) ? false :
      null,
    offers
  };
}

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`API listening on :${port}`));