-- Review 19-22 fixes. Hand written, re-runnable (IF NOT EXISTS / guarded), additive. Safe to run on a database that already applied the earlier version of
-- 20261208120000 (every block below is guarded and becomes a no-op).
--
--  1. briefing_audio.text_hash: the transcript a clip was made from (a failed regeneration keeps a clip of the same text; the same text and voice is not
--     synthesized twice).
--  2. sms_log (to_e164, created_at): routes a customer's reply to the shared sender to the business that texted them last.
--  3. Validation of every CHECK left NOT VALID by 20261208120000 (moved here: SHARE UPDATE EXCLUSIVE locks only, no reader or writer waits for the scans).
--  4. The overlap EXCLUSION constraint becomes per (business, crew). LAST, so its ACCESS EXCLUSIVE lock on `bookings` is held only while the GiST index is
--     built (no table scan of other tables runs under it). `lock_timeout` makes a busy table fail the deploy (re-run it) instead of queueing every request.
--     On a database with more than ~100k bookings run the deploy in a maintenance window (docs/runbook.md).
SET lock_timeout = '10s';

-- 1. briefing audio ------------------------------------------------------------------------------------------------------------------
ALTER TABLE "public"."briefing_audio" ADD COLUMN IF NOT EXISTS "text_hash" TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'briefing_audio_text_hash_check' AND conrelid = 'public.briefing_audio'::regclass) THEN
    ALTER TABLE "public"."briefing_audio" ADD CONSTRAINT "briefing_audio_text_hash_check" CHECK ("text_hash" IS NULL OR "text_hash" ~ '^[0-9a-f]{64}$') NOT VALID;
  END IF;
END $$;

-- 2. sms_log lookup by recipient number ----------------------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "sms_log_to_e164_created_at_idx" ON "public"."sms_log"("to_e164", "created_at");

-- 3. validate every CHECK still NOT VALID, failing loudly with the offending row count ------------------------------------------------
DO $$
DECLARE
  c RECORD;
  bad BIGINT;
BEGIN
  FOR c IN
    SELECT con.conname, con.conrelid::regclass AS rel, pg_get_expr(con.conbin, con.conrelid) AS expr
      FROM pg_constraint con
      JOIN pg_namespace ns ON ns.oid = con.connamespace
     WHERE ns.nspname = 'public' AND con.contype = 'c' AND NOT con.convalidated
     ORDER BY con.conname
  LOOP
    EXECUTE format('SELECT count(*) FROM %s WHERE NOT COALESCE(%s, true)', c.rel, c.expr) INTO bad;
    IF bad > 0 THEN
      RAISE EXCEPTION 'Migration aborted: CHECK constraint % on % is violated by % row(s) (condition: %). Fix or delete those rows, then re-run the migration.',
        c.conname, c.rel, bad, c.expr;
    END IF;
    EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', c.rel, c.conname);
  END LOOP;
END $$;

-- 4. the overlap guard becomes per (business, crew) (last: see the header) --------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'bookings_no_overlap' AND conrelid = 'public.bookings'::regclass AND pg_get_constraintdef(oid) LIKE '%crew%'
  ) THEN
    ALTER TABLE "public"."bookings" DROP CONSTRAINT IF EXISTS "bookings_no_overlap";
    ALTER TABLE "public"."bookings"
      ADD CONSTRAINT "bookings_no_overlap"
      EXCLUDE USING gist (
        "business_id" WITH =,
        "crew" WITH =,
        tsrange("scheduled_at", "scheduled_at" + make_interval(mins => "duration_minutes"), '[)') WITH &&
      )
      WHERE ("status" <> 'cancelled');
  END IF;
END $$;

RESET lock_timeout;
