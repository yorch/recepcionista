-- Fixes of adversarial reviews 16 and 17. Hand written, re-runnable (guarded / IF NOT EXISTS), additive: no data is rewritten or dropped.
--
--  1. owner_replies.status gains 'uncertain': a send that may or may not have gone out (a claim that never finished, or a provider timeout). It is
--     never retried and counts toward the daily cap and the duplicate guard. The CHECK constraints that list the statuses are replaced
--     (added NOT VALID, then validated), so a re-run or an upgrade over rows in any state works.
--  2. calls.forward_pending_key: the metering key (call sid, else conversation id) the pending forward seconds were marked under, so the settle job
--     can never meter the same seconds again under a key that appeared later.

-- 1 ------------------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  c RECORD;
BEGIN
  -- Only replace the two constraints when they do not already list 'uncertain' (re-run safe).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'owner_replies_status_check' AND conrelid = 'public.owner_replies'::regclass AND pg_get_constraintdef(oid) LIKE '%uncertain%'
  ) THEN
    ALTER TABLE "public"."owner_replies" DROP CONSTRAINT IF EXISTS "owner_replies_status_check";
    ALTER TABLE "public"."owner_replies" ADD CONSTRAINT "owner_replies_status_check"
      CHECK ("status" IN ('proposed', 'sending', 'sent', 'uncertain', 'cancelled', 'expired', 'refused', 'failed')) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'owner_replies_decided_check' AND conrelid = 'public.owner_replies'::regclass AND pg_get_constraintdef(oid) LIKE '%uncertain%'
  ) THEN
    ALTER TABLE "public"."owner_replies" DROP CONSTRAINT IF EXISTS "owner_replies_decided_check";
    ALTER TABLE "public"."owner_replies" ADD CONSTRAINT "owner_replies_decided_check"
      CHECK ("status" NOT IN ('sending', 'sent', 'uncertain', 'cancelled', 'refused', 'failed') OR "decided_at" IS NOT NULL) NOT VALID;
  END IF;
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'public.owner_replies'::regclass AND contype = 'c' AND NOT convalidated
  LOOP
    EXECUTE format('ALTER TABLE "public"."owner_replies" VALIDATE CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

-- 2 ------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE "public"."calls" ADD COLUMN IF NOT EXISTS "forward_pending_key" TEXT;
