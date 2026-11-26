-- Review 23 fixes. Hand written, re-runnable (IF NOT EXISTS / guarded), additive. METADATA-ONLY: nothing here scans or rewrites a table, so the locks it takes
-- (taken inside Prisma's single per-file transaction) are held for milliseconds. The one heavy step, the index, is in 20261210120100_sms_log_from_index.
--
--  1. sms_log.from_e164 / sender_kind: which number actually sent each text ('tenant' own line | 'shared' platform sender | 'service' Twilio Messaging Service
--     pool). A reply to a number that is not a tenant's own is routed ONLY by this recorded sender (messaging/sender.ts resolveInboundRoute). NULL on rows
--     written before this migration and on rows that sent nothing (blocked / failed). Adding a nullable column without a default is a catalog change only.
--  2. The unused (to_e164, created_at) index of 20261209120000 goes away (the new lookup is by sender; an earlier version of that migration created it).
--  3. A previous run of the CONCURRENT index build that was interrupted leaves an INVALID index behind, which `IF NOT EXISTS` would then skip: drop it here
--     so re-running the deploy rebuilds it.
SET lock_timeout = '10s';

ALTER TABLE "public"."sms_log" ADD COLUMN IF NOT EXISTS "from_e164" TEXT;
ALTER TABLE "public"."sms_log" ADD COLUMN IF NOT EXISTS "sender_kind" TEXT;
DROP INDEX IF EXISTS "public"."sms_log_to_e164_created_at_idx";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'sms_log_from_e164_to_e164_created_at_idx' AND NOT i.indisvalid
  ) THEN
    DROP INDEX "public"."sms_log_from_e164_to_e164_created_at_idx";
  END IF;
END $$;

RESET lock_timeout;
