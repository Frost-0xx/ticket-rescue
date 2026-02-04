const fs = require("fs");
const { parse } = require("csv-parse");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

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

// "05/14/2021 19:30" -> { dateDay: Date(UTC midnight), time24: "19:30" }
function parseDateTimeUS(dateTimeStr) {
  const s = String(dateTimeStr || "").trim();
  const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const mm = +m[1];
  const dd = +m[2];
  const yyyy = +m[3];
  const hh = m[4];
  const min = m[5];
  const dateDay = new Date(Date.UTC(yyyy, mm - 1, dd, 0, 0, 0));
  return { dateDay, time24: `${hh}:${min}`, raw: s };
}

// "$699.00-$1,329.71" -> cents
function parsePriceRangeToCents(rangeStr) {
  if (!rangeStr) return { min: null, max: null };
  const s = String(rangeStr).trim();
  const parts = s.split("-");
  const left = (parts[0] || "").replace(/\$/g, "").replace(/,/g, "").trim();
  const right = (parts[1] || "").replace(/\$/g, "").replace(/,/g, "").trim();

  const toCents = (x) => {
    const num = Number(x);
    if (!Number.isFinite(num)) return null;
    return Math.round(num * 100);
  };

  return { min: toCents(left), max: toCents(right) };
}

function ynToBool(v) {
  const s = String(v || "").trim().toUpperCase();
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

  const BATCH_SIZE = 1000;
  let batch = [];
  let processed = 0;

  const parser = fs
    .createReadStream(filePath)
    .pipe(parse({ columns: true, skip_empty_lines: true }));

  for await (const row of parser) {
    // exact column names from your feed:
    const eventId = String(row["EventID"] || "").trim();
    const performerId = String(row["PerformerID"] || "").trim();
    const performerName = String(row["Performer"] || "").trim();

    const eventName = String(row["Event"] || "").trim();
    const city = String(row["City"] || "").trim();
    const state = String(row["State"] || "").trim();
    const country = String(row["Country"] || "").trim();
    const venue = String(row["Venue"] || "").trim();

    const dateTimeRaw = String(row["DateTime"] || "").trim();
    const url = String(row["URLLink"] || "").trim();
    const priceRangeRaw = String(row["PriceRange"] || "").trim();
    const ticketsYn = ynToBool(row["TicketsYN"]);

    if (!eventId || !performerId || !dateTimeRaw || !url) continue;

    const dt = parseDateTimeUS(dateTimeRaw);
    if (!dt) continue;

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
      console.log("Processed:", processed);
      batch = [];
    }
  }

  if (batch.length) {
    await flushBatch(source, batch);
    processed += batch.length;
  }

  console.log("Done. Total processed:", processed);
  await prisma.$disconnect();
}

async function flushBatch(source, rows) {
  for (const r of rows) {
    // 1) upsert event
    const cityNorm = normText(r.city);
    const stateNorm = normText(r.state);
    const venueNorm = normText(r.venue);

    await prisma.event.upsert({
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
        venueNorm: venueNorm || undefined,
      },
      create: {
        id: r.eventId,
        eventName: r.eventName || null,
        dateDay: r.dateDay,
        time24: r.time24,
        datetimeRaw: r.datetimeRaw,
        city: r.city || null,
        cityNorm,
        state: r.state || null,
        stateNorm,
        country: r.country || null,
        venue: r.venue || null,
        venueNorm,
      }
    });

    // 2) upsert performer
    const performerNorm = normText(r.performerName);
    await prisma.performer.upsert({
      where: { id: r.performerId },
      update: {
        name: r.performerName || undefined,
        performerNorm: performerNorm || undefined
      },
      create: {
        id: r.performerId,
        name: r.performerName || null,
        performerNorm
      }
    });

    // 3) ensure join row
    await prisma.eventPerformer.upsert({
      where: { eventId_performerId: { eventId: r.eventId, performerId: r.performerId } },
      update: {},
      create: { eventId: r.eventId, performerId: r.performerId }
    });

    // 4) upsert offer for this source
    await prisma.offer.upsert({
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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});