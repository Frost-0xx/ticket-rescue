const fs = require("fs");
const { parse } = require("csv-parse");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

// Only this source is allowed to update canonical Event fields.
// Other sources may create Event if missing, but must NOT overwrite it.
const MASTER_EVENT_SOURCE = "geturtix";

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

// Cleans "display" fields (city/state/venue/names) so they don't keep quotes/spaces.
function cleanDisplayText(s) {
  if (s == null) return "";
  let t = String(s);

  // Normalize whitespace early
  t = t.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();

  // Remove wrapping quotes: "Inglewood " -> Inglewood
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    t = t.slice(1, -1).trim();
  }

  // Collapse internal multiple spaces again after trimming quotes
  t = t.replace(/\s+/g, " ").trim();

  return t;
}

// Parses US DateTime in 3 forms:
// 1) "05/14/2021 19:30"  (24h)
// 2) "05/14/2021 6:00 PM" (AM/PM)
// 3) "05/14/2021" (date-only)
function parseDateTimeUSFlexible(dateTimeStr) {
  const raw = cleanDisplayText(dateTimeStr);
  if (!raw) return null;

  // Date-only: MM/DD/YYYY
  let m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  if (m) {
    const mm = +m[1];
    const dd = +m[2];
    const yyyy = +m[3];
    const dateDay = new Date(Date.UTC(yyyy, mm - 1, dd, 0, 0, 0));
    return { dateDay, time24: null, raw };
  }

  // 24h time: MM/DD/YYYY HH:mm
  m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/.exec(raw);
  if (m) {
    const mm = +m[1];
    const dd = +m[2];
    const yyyy = +m[3];
    const hh = +m[4];
    const min = +m[5];
    const dateDay = new Date(Date.UTC(yyyy, mm - 1, dd, 0, 0, 0));
    const time24 = `${String(hh).padStart(2, "0")}:${String(min).padStart(
      2,
      "0"
    )}`;
    return { dateDay, time24, raw };
  }

  // AM/PM time: MM/DD/YYYY h:mm AM|PM
  m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(raw);
  if (m) {
    const mm = +m[1];
    const dd = +m[2];
    const yyyy = +m[3];
    let hh = +m[4];
    const min = +m[5];
    const ampm = String(m[6]).toUpperCase();

    if (hh < 1 || hh > 12) return null;
    if (ampm === "AM") {
      if (hh === 12) hh = 0;
    } else {
      if (hh !== 12) hh += 12;
    }

    const dateDay = new Date(Date.UTC(yyyy, mm - 1, dd, 0, 0, 0));
    const time24 = `${String(hh).padStart(2, "0")}:${String(min).padStart(
      2,
      "0"
    )}`;
    return { dateDay, time24, raw };
  }

  return null;
}

// "$699.00-$1,329.71" -> cents
// also handles: "$1,206.50 - $27,354.35" and en-dash "–"
// empty/TBD/invalid -> {min:null, max:null}
function parsePriceRangeToCents(rangeStr) {
  const raw = cleanDisplayText(rangeStr);
  if (!raw) return { min: null, max: null };

  const s = raw.trim();
  if (!s) return { min: null, max: null };
  if (/tbd/i.test(s)) return { min: null, max: null };

  // normalize dash variants to "-"
  const normalized = s.replace(/[–—]/g, "-"); // en/em dash
  const parts = normalized.split("-");
  if (parts.length < 2) return { min: null, max: null };

  const cleanMoney = (x) =>
    String(x || "")
      .replace(/\$/g, "")
      .replace(/,/g, "")
      .trim();

  const toCents = (x) => {
    const num = Number(x);
    if (!Number.isFinite(num)) return null;
    return Math.round(num * 100);
  };

  const left = cleanMoney(parts[0]);
  const right = cleanMoney(parts.slice(1).join("-")); // just in case there are extra dashes
  const min = toCents(left);
  const max = toCents(right);

  // If either side fails -> both null (avoid "null/0" weirdness)
  if (min == null || max == null) return { min: null, max: null };

  return { min, max };
}

function ynToBool(v) {
  const s = cleanDisplayText(v).toUpperCase();
  if (s === "Y") return true;
  if (s === "N") return false;
  return null;
}

async function main() {
  const source = process.argv[2]; // geturtix|tn|tl|sbs
  const filePath = process.argv[3];

  if (!source || !filePath) {
    console.error("Usage: node src/ingest.js <source> <path_to_csv>");
    process.exit(1);
  }
  if (!fs.existsSync(filePath)) {
    console.error("File not found:", filePath);
    process.exit(1);
  }

  const BATCH_SIZE = 200;
  let batch = [];
  let processed = 0;
  let skipped = 0;

  const parser = fs
    .createReadStream(filePath)
    .pipe(parse({ columns: true, skip_empty_lines: true }));

  for await (const row of parser) {
    // exact column names from your feed:
    const eventId = cleanDisplayText(row["EventID"]);
    const performerId = cleanDisplayText(row["PerformerID"]);
    const performerName = cleanDisplayText(row["Performer"]);

    const eventName = cleanDisplayText(row["Event"]);
    const city = cleanDisplayText(row["City"]);
    const state = cleanDisplayText(row["State"]);
    const country = cleanDisplayText(row["Country"]);
    const venue = cleanDisplayText(row["Venue"]);

    const dateTimeRaw = cleanDisplayText(row["DateTime"]);
    const url = cleanDisplayText(row["URLLink"]);
    const priceRangeRaw = cleanDisplayText(row["PriceRange"]);
    const ticketsYn = ynToBool(row["TicketsYN"]);

    // We require eventId + performerId + date + url.
    // If time is missing/unknown -> keep the row (time24=null).
    if (!eventId || !performerId || !dateTimeRaw || !url) {
      skipped++;
      continue;
    }

    const dt = parseDateTimeUSFlexible(dateTimeRaw);
    if (!dt) {
      skipped++;
      continue;
    }

    const pr = parsePriceRangeToCents(priceRangeRaw);

    batch.push({
      eventId,
      performerId,
      performerName,
      eventName,
      city,
      state,
      country,
      venue,
      dateDay: dt.dateDay,
      time24: dt.time24,
      datetimeRaw: dt.raw,
      url,
      priceMin: pr.min,
      priceMax: pr.max,
      priceRangeRaw,
      ticketsYn
    });

    if (batch.length >= BATCH_SIZE) {
      await flushBatch(source, batch);
      processed += batch.length;
      console.log("Processed:", processed, "Skipped:", skipped);
      batch = [];
    }
  }

  if (batch.length) {
    await flushBatch(source, batch);
    processed += batch.length;
  }

  console.log("Done. Total processed:", processed, "Skipped:", skipped);
  await prisma.$disconnect();
}

// NOTE: these are now transactional helpers - accept tx.
async function ensureEventExistsIfMissingTx(tx, r, cityNorm, stateNorm, venueNorm) {
  await tx.event.upsert({
    where: { id: r.eventId },
    update: {}, // no-op for non-master
    create: {
      id: r.eventId,
      eventName: r.eventName || null,
      dateDay: r.dateDay,
      time24: r.time24,
      datetimeRaw: r.datetimeRaw,
      city: r.city || null,
      cityNorm: cityNorm || null,
      state: r.state || null,
      stateNorm: stateNorm || null,
      country: r.country || null,
      venue: r.venue || null,
      venueNorm: venueNorm || null
    }
  });
}

async function upsertEventFromMasterTx(tx, r, cityNorm, stateNorm, venueNorm) {
  await tx.event.upsert({
    where: { id: r.eventId },
    update: {
      eventName: r.eventName || undefined,
      dateDay: r.dateDay,
      time24: r.time24,
      datetimeRaw: r.datetimeRaw,
      city: r.city || undefined,
      cityNorm: cityNorm || undefined,
      state: r.state || undefined,
      stateNorm: stateNorm || undefined,
      country: r.country || undefined,
      venue: r.venue || undefined,
      venueNorm: venueNorm || undefined
    },
    create: {
      id: r.eventId,
      eventName: r.eventName || null,
      dateDay: r.dateDay,
      time24: r.time24,
      datetimeRaw: r.datetimeRaw,
      city: r.city || null,
      cityNorm: cityNorm || null,
      state: r.state || null,
      stateNorm: stateNorm || null,
      country: r.country || null,
      venue: r.venue || null,
      venueNorm: venueNorm || null
    }
  });
}

async function flushBatch(source, rows) {
  const isMaster = source === MASTER_EVENT_SOURCE;

  // One DB transaction per batch => drastically less fsync/IO pressure
  await prisma.$transaction(async (tx) => {
    for (const r of rows) {
      const cityNorm = normText(r.city);
      const stateNorm = normText(r.state);
      const venueNorm = normText(r.venue);

      // 1) Event
      if (isMaster) {
        const cleanR = {
          ...r,
          city: cleanDisplayText(r.city),
          state: cleanDisplayText(r.state),
          venue: cleanDisplayText(r.venue),
          eventName: cleanDisplayText(r.eventName),
        };
        await upsertEventFromMasterTx(tx, cleanR, cityNorm, stateNorm, venueNorm);
      } else {
        await ensureEventExistsIfMissingTx(tx, r, cityNorm, stateNorm, venueNorm);
      }

      // 2) Performer
      const performerNorm = normText(r.performerName);
      await tx.performer.upsert({
        where: { id: r.performerId },
        update: {
          name: r.performerName || undefined,
          performerNorm: performerNorm || undefined
        },
        create: {
          id: r.performerId,
          name: r.performerName || null,
          performerNorm: performerNorm || null
        }
      });

      // 3) Join row
      await tx.eventPerformer.upsert({
        where: {
          eventId_performerId: { eventId: r.eventId, performerId: r.performerId }
        },
        update: {},
        create: { eventId: r.eventId, performerId: r.performerId }
      });

      // 4) Offer per source
      await tx.offer.upsert({
        where: { source_eventId: { source, eventId: r.eventId } },
        update: {
          url: r.url,
          priceMin: r.priceMin,
          priceMax: r.priceMax,
          priceRangeRaw: r.priceRangeRaw,
          ticketsYn: r.ticketsYn ?? undefined,
          lastSeenAt: new Date()
        },
        create: {
          source,
          eventId: r.eventId,
          url: r.url,
          priceMin: r.priceMin,
          priceMax: r.priceMax,
          priceRangeRaw: r.priceRangeRaw,
          ticketsYn: r.ticketsYn ?? null,
          lastSeenAt: new Date()
        }
      });
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});