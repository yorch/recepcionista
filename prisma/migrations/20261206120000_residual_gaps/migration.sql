-- Residual gaps of reviews 11-15. Hand written, re-runnable (IF NOT EXISTS / guarded), additive only (no data is rewritten or dropped).
--
--  1. calendar_orphaned_events: pushed Google events that could not be removed from a previous account (dead tokens) are remembered, business-side
--     facts only, so the Google card can say "N events from the previous account could not be removed". No tokens are kept.
--  2. calls.dial_seconds / calls.forward_pending_secs: the dial duration a Twilio callback reported, and the forward seconds of a transferred call
--     that still have to be written to the usage counters (the reconcile job finishes them).
--  3. bookings.refund_requested_at: when the current refund attempt was recorded as pending, so "check with Stripe" only treats a refund as
--     never-sent once it is old enough. Existing pending rows stay NULL (= old enough).
--  4. user_sessions.revoked_business_ids: businesses a session may no longer act in / switch to. Existing sessions get the empty default (code also treats NULL as none).

-- 1 ------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "public"."calendar_orphaned_events" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "booking_id" TEXT,
    "google_event_id" TEXT NOT NULL,
    "calendar_id" TEXT NOT NULL,
    "account_email" TEXT NOT NULL,
    "service" TEXT NOT NULL DEFAULT '',
    "starts_at" TIMESTAMPTZ(6),
    "reason" TEXT NOT NULL DEFAULT 'account_changed',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calendar_orphaned_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "calendar_orphaned_events_business_id_created_at_idx" ON "public"."calendar_orphaned_events"("business_id", "created_at");
CREATE INDEX IF NOT EXISTS "calendar_orphaned_events_booking_id_idx" ON "public"."calendar_orphaned_events"("booking_id");
CREATE UNIQUE INDEX IF NOT EXISTS "calendar_orphaned_events_business_id_account_email_calendar_key" ON "public"."calendar_orphaned_events"("business_id", "account_email", "calendar_id", "google_event_id");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calendar_orphaned_events_business_id_fkey') THEN
    ALTER TABLE "public"."calendar_orphaned_events" ADD CONSTRAINT "calendar_orphaned_events_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calendar_orphaned_events_reason_check') THEN
    ALTER TABLE "public"."calendar_orphaned_events" ADD CONSTRAINT "calendar_orphaned_events_reason_check" CHECK ("reason" IN ('account_changed', 'calendar_changed', 'disconnected'));
  END IF;
END $$;

-- 2 ------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE "public"."calls" ADD COLUMN IF NOT EXISTS "dial_seconds" INTEGER;
ALTER TABLE "public"."calls" ADD COLUMN IF NOT EXISTS "forward_pending_secs" INTEGER;

-- 3 ------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE "public"."bookings" ADD COLUMN IF NOT EXISTS "refund_requested_at" TIMESTAMPTZ(6);

-- 4 ------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE "public"."user_sessions" ADD COLUMN IF NOT EXISTS "revoked_business_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];
