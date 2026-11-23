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
-- NOT idempotent by design: Prisma applies each migration exactly once (tracked in
-- _prisma_migrations), inside this one transaction. Never re-run this file by hand.
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

-- Pre-check: fail LOUDLY (and change nothing) if existing rows already overlap, rather than
-- letting the constraint error out cryptically. Resolve the listed bookings, then re-run.
DO $$
DECLARE
  n INTEGER;
  sample TEXT;
BEGIN
  WITH pairs AS (
    SELECT a.id AS a_id, b.id AS b_id
      FROM "public"."bookings" a
      JOIN "public"."bookings" b
        ON a."business_id" = b."business_id" AND a.id < b.id
       AND a."status" <> 'cancelled' AND b."status" <> 'cancelled'
       AND tsrange(a."scheduled_at", a."scheduled_at" + make_interval(mins => a."duration_minutes"), '[)')
        && tsrange(b."scheduled_at", b."scheduled_at" + make_interval(mins => b."duration_minutes"), '[)')
  )
  SELECT (SELECT count(*) FROM pairs),
         (SELECT string_agg(a_id || ' vs ' || b_id, '; ') FROM (SELECT * FROM pairs LIMIT 10) p)
    INTO n, sample;
  IF n > 0 THEN
    RAISE EXCEPTION 'Migration aborted: % overlapping non-cancelled booking pairs exist (first: %). Cancel or move them, then re-run the migration.', n, sample;
  END IF;
END $$;

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

-- 5. Indexed ElevenLabs agent lookup (tenant resolution on every tool call) ----
CREATE INDEX "businesses_agent_id_idx" ON "public"."businesses"("agent_id");
