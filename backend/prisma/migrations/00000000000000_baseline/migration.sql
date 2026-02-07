-- CreateEnum
CREATE TYPE "Source" AS ENUM ('geturtix', 'tn', 'tl', 'sbs');

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "eventName" TEXT,
    "dateDay" TIMESTAMP(3) NOT NULL,
    "time24" TEXT,
    "datetimeRaw" TEXT,
    "city" TEXT,
    "cityNorm" TEXT,
    "state" TEXT,
    "stateNorm" TEXT,
    "venue" TEXT,
    "venueNorm" TEXT,
    "country" TEXT,
    "ticketsYn" BOOLEAN DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Performer" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "performerNorm" TEXT,

    CONSTRAINT "Performer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventPerformer" (
    "eventId" TEXT NOT NULL,
    "performerId" TEXT NOT NULL,

    CONSTRAINT "EventPerformer_pkey" PRIMARY KEY ("eventId","performerId")
);

-- CreateTable
CREATE TABLE "Offer" (
    "id" TEXT NOT NULL,
    "source" "Source" NOT NULL,
    "eventId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "priceMin" INTEGER,
    "priceMax" INTEGER,
    "priceRangeRaw" TEXT,
    "ticketsYn" BOOLEAN,
    "promoPercent" INTEGER,
    "promoCode" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Offer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Event_dateDay_cityNorm_stateNorm_idx" ON "Event"("dateDay", "cityNorm", "stateNorm");

-- CreateIndex
CREATE INDEX "Performer_performerNorm_idx" ON "Performer"("performerNorm");

-- CreateIndex
CREATE INDEX "EventPerformer_performerId_idx" ON "EventPerformer"("performerId");

-- CreateIndex
CREATE INDEX "Offer_eventId_idx" ON "Offer"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "Offer_source_eventId_key" ON "Offer"("source", "eventId");

-- AddForeignKey
ALTER TABLE "EventPerformer" ADD CONSTRAINT "EventPerformer_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventPerformer" ADD CONSTRAINT "EventPerformer_performerId_fkey" FOREIGN KEY ("performerId") REFERENCES "Performer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

