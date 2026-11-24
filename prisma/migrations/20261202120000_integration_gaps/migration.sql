-- Integration gaps (ONE migration):
--   * businesses.closed_dates      holiday closures (YYYY-MM-DD in the business zone), applied by owner call-in changes and honoured by
--                                  availability / the scheduler / createBooking / reschedule
--   * owner_kb_changes.base        the business fields (hours / service_area / closed_dates) as they were when a change was PROPOSED, so applying
--                                  over a newer edit is refused (stale) instead of silently undoing it
--   * calendar_connections.block_on_busy   the "block my busy time" switch (was: latest `calendar.settings_changed` audit event); backfilled
--   * bookings.dispute_status      'none' | 'open' | 'won' | 'lost' (set from charge.dispute.* webhooks)
--
-- LOCKING: every ADD COLUMN has a constant default (catalog-only on PG 11+). CHECKs are added NOT VALID then validated. The only statement
-- touching existing rows is the block_on_busy backfill (row locks on calendar_connections only). Re-runnable in parts.

ALTER TABLE "public"."businesses" ADD COLUMN IF NOT EXISTS "closed_dates" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "public"."owner_kb_changes" ADD COLUMN IF NOT EXISTS "base" JSONB;
ALTER TABLE "public"."calendar_connections" ADD COLUMN IF NOT EXISTS "block_on_busy" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "public"."bookings" ADD COLUMN IF NOT EXISTS "dispute_status" TEXT NOT NULL DEFAULT 'none';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'businesses_closed_dates_check') THEN
    ALTER TABLE "public"."businesses" ADD CONSTRAINT "businesses_closed_dates_check"
      CHECK (jsonb_typeof("closed_dates") = 'array' AND jsonb_array_length("closed_dates") <= 366) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_dispute_status_check') THEN
    ALTER TABLE "public"."bookings" ADD CONSTRAINT "bookings_dispute_status_check"
      CHECK ("dispute_status" IN ('none', 'open', 'won', 'lost')) NOT VALID;
  END IF;
END $$;

-- Backfill the switch from the audit trail it used to live in: the LATEST calendar.settings_changed event per business wins
-- (no event = the default, true). Only rows whose latest value is `false` need a write.
UPDATE "public"."calendar_connections" c
   SET "block_on_busy" = false
  FROM (
    SELECT DISTINCT ON ("business_id") "business_id", ("meta" ->> 'block_on_busy') AS v
      FROM "public"."audit_events"
     WHERE "action" = 'calendar.settings_changed' AND "business_id" IS NOT NULL AND "meta" ? 'block_on_busy'
     ORDER BY "business_id", "at" DESC
  ) latest
 WHERE c."business_id" = latest."business_id" AND latest.v = 'false' AND c."block_on_busy" IS DISTINCT FROM false;

ALTER TABLE "public"."businesses" VALIDATE CONSTRAINT "businesses_closed_dates_check";
ALTER TABLE "public"."bookings" VALIDATE CONSTRAINT "bookings_dispute_status_check";
