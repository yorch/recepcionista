-- Per-business time zone, integer-cents money, booking duration + overlap protection,
-- indexed phone lookup. Written by hand (Prisma cannot express the exclusion constraint).

-- 1. Time zone ---------------------------------------------------------------
ALTER TABLE "public"."businesses" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'America/New_York';

-- 2. Indexed normalized phone ------------------------------------------------
ALTER TABLE "public"."businesses" ADD COLUMN "phone_key" TEXT;
UPDATE "public"."businesses"
   SET "phone_key" = right(regexp_replace("phone", '\D', '', 'g'), 10)
 WHERE "phone" IS NOT NULL;
CREATE INDEX "businesses_phone_key_idx" ON "public"."businesses"("phone_key");

-- 3. Money: whole dollars -> integer cents ----------------------------------
UPDATE "public"."bookings"
   SET "price_estimate" = "price_estimate" * 100
 WHERE "price_estimate" IS NOT NULL;
UPDATE "public"."bookings"
   SET "deposit_amount" = "deposit_amount" * 100
 WHERE "deposit_amount" IS NOT NULL;
-- Briefing stats.revenue was dollars as well.
UPDATE "public"."briefings"
   SET "stats" = jsonb_set("stats", '{revenue}', to_jsonb(round(("stats"->>'revenue')::numeric * 100)::bigint))
 WHERE "stats" ? 'revenue' AND jsonb_typeof("stats"->'revenue') = 'number';

-- 4. Booking duration + no-overlap exclusion constraint ----------------------
ALTER TABLE "public"."bookings" ADD COLUMN "duration_minutes" INTEGER NOT NULL DEFAULT 60;
ALTER TABLE "public"."bookings"
  ADD CONSTRAINT "bookings_duration_minutes_check" CHECK ("duration_minutes" > 0 AND "duration_minutes" <= 1440);

-- Needs privileges to create extensions (superuser or trusted-extension on PG13+).
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- A business cannot have two non-cancelled bookings whose [start, start+duration) overlap.
-- NOTE: fails if existing rows already overlap; resolve (cancel/move) duplicates first.
ALTER TABLE "public"."bookings"
  ADD CONSTRAINT "bookings_no_overlap"
  EXCLUDE USING gist (
    "business_id" WITH =,
    tsrange("scheduled_at", "scheduled_at" + make_interval(mins => "duration_minutes"), '[)') WITH &&
  )
  WHERE ("status" <> 'cancelled');
