-- Review 14 fixes. Hand written, re-runnable (IF NOT EXISTS / OR REPLACE / guarded), row locks only.
--
--  1. pending_recording_deletions.provider: the durable deletion queue now also holds ElevenLabs conversations (audio + transcript),
--     not just Twilio voicemail recordings. Existing rows are Twilio rows (default).
--  2. rc_transcript_consent_guard takes a row lock (FOR SHARE) on the call before it looks at consent. FOR SHARE conflicts with the
--     FOR NO KEY UPDATE of `UPDATE calls SET consent_status`, so an insert that raced a decline either waits and sees 'declined'
--     (skipped), or the declining UPDATE waits for the insert to commit and its AFTER purge then sees (and deletes) the row.
--  3. Repair of the phase-1 `metered_at` backfill: it marked EVERY existing call as already metered, including calls that were still in
--     progress or whose duration had not been stored (their post-call webhook / the reconcile job would then skip them and the minutes
--     were never billed). Only a call that already carries its stored duration was metered by the old code. The backfill value was exactly
--     COALESCE(ended_at, started_at); anything the new code claims gets now(), so that signature identifies the wrongly settled rows.

-- 1 ------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE "public"."pending_recording_deletions" ADD COLUMN IF NOT EXISTS "provider" TEXT NOT NULL DEFAULT 'twilio';

-- The shape check of the review-6 migration allowed Twilio SIDs only. Replace it with a provider-aware one: Twilio rows keep the exact SID shape,
-- ElevenLabs rows are ('elevenlabs', <conversation id>).
ALTER TABLE "public"."pending_recording_deletions" DROP CONSTRAINT IF EXISTS "pending_recording_deletions_sid_check";
ALTER TABLE "public"."pending_recording_deletions" DROP CONSTRAINT IF EXISTS "pending_recording_deletions_provider_check";
ALTER TABLE "public"."pending_recording_deletions" ADD CONSTRAINT "pending_recording_deletions_provider_check" CHECK (
  "attempts" >= 0 AND (
    ("provider" = 'twilio' AND "account_sid" ~ '^AC[0-9a-fA-F]{32}$' AND "recording_sid" ~ '^RE[0-9a-fA-F]{32}$')
    OR ("provider" = 'elevenlabs' AND "account_sid" = 'elevenlabs' AND "recording_sid" ~ '^[A-Za-z0-9_-]{6,128}$')
  )
) NOT VALID;
ALTER TABLE "public"."pending_recording_deletions" VALIDATE CONSTRAINT "pending_recording_deletions_provider_check";

-- 2 ------------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."rc_transcript_consent_guard"() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM "public"."calls" c WHERE c."id" = NEW."call_id" FOR SHARE;
  IF EXISTS (SELECT 1 FROM "public"."calls" c WHERE c."id" = NEW."call_id" AND c."consent_status" = 'declined') THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- 3 ------------------------------------------------------------------------------------------------------------------------------
UPDATE "public"."calls"
   SET "metered_at" = NULL
 WHERE "metered_at" = (COALESCE("ended_at", "started_at") AT TIME ZONE 'UTC')
   AND ("ended_at" IS NULL OR "duration_sec" IS NULL)
   AND "started_at" > now() - interval '3 days';

-- 4 ------------------------------------------------------------------------------------------------------------------------------
-- The Stripe Payment Link texted for a booking's deposit, so cancelling the booking can deactivate it (a cancelled booking must not stay payable).
ALTER TABLE "public"."bookings" ADD COLUMN IF NOT EXISTS "stripe_payment_link_id" TEXT;
