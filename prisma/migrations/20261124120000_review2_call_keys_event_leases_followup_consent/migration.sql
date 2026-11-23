-- Review round 2 follow-ups.
--
-- 1. calls.conversation_id: the ElevenLabs conversation id as its own key (the Twilio SID stays in
--    call_sid), so tool-created rows, /api/voice/incoming rows and the post-call webhook all
--    resolve to ONE row (a declined-consent call can no longer be duplicated into a "disclosed" one).
-- 2. processed_events.status / claimed_at: a claim is a lease while 'processing', so a worker that
--    dies after claiming no longer swallows the sender's retries forever.
-- 3. bookings.followup_consent_*: records that the customer was told about follow-up texts.
-- 4. Prompts stored before the privacy fix still embed the owner's phone number; redact it.

ALTER TABLE "calls" ADD COLUMN "conversation_id" TEXT;
CREATE UNIQUE INDEX "calls_conversation_id_key" ON "calls"("conversation_id");

ALTER TABLE "processed_events"
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'done',
  ADD COLUMN "claimed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE "processed_events" SET "claimed_at" = "created_at";
ALTER TABLE "processed_events"
  ADD CONSTRAINT "processed_events_status_check" CHECK ("status" IN ('processing', 'done')) NOT VALID;
ALTER TABLE "processed_events" VALIDATE CONSTRAINT "processed_events_status_check";

ALTER TABLE "bookings"
  ADD COLUMN "followup_consent_at" TIMESTAMP(3),
  ADD COLUMN "followup_consent_source" TEXT;

UPDATE "knowledge_bases" kb
   SET "system_prompt" = replace(kb."system_prompt", b."owner_phone", '[owner phone withheld]')
  FROM "businesses" b
 WHERE kb."business_id" = b."id"
   AND b."owner_phone" IS NOT NULL AND b."owner_phone" <> ''
   AND position(b."owner_phone" in kb."system_prompt") > 0;
