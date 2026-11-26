-- Review 19-22 fixes. Hand written, re-runnable (IF NOT EXISTS / guarded), additive. Safe to run on a database that already applied the earlier version of
-- 20261208120000 (every block below is guarded and becomes a no-op).
--
--  1. briefing_audio.text_hash: the transcript a clip was made from (a failed regeneration keeps a clip of the same text; the same text and voice is not
--     synthesized twice).
--  2. Validation of every CHECK left NOT VALID by 20261208120000 (SHARE UPDATE EXCLUSIVE locks only, no reader or writer waits for the scans).
--
-- Prisma applies a migration file as ONE transaction, so every lock taken here is held until the END of this file. That is why this file holds nothing
-- heavy (review 23 A3): the sms_log index that used to be step 2 is gone (the table is indexed by 20261210120100, CONCURRENTLY, in a file of its own) and
-- the per-crew overlap rebuild (an ACCESS EXCLUSIVE lock on `bookings` for the length of a GiST build) moved to 20261209120100_bookings_overlap_per_crew.
-- A database that applied the earlier, larger version of this file simply finds both later files already satisfied (they are guarded).
SET lock_timeout = '10s';

-- 1. briefing audio ------------------------------------------------------------------------------------------------------------------
ALTER TABLE "public"."briefing_audio" ADD COLUMN IF NOT EXISTS "text_hash" TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'briefing_audio_text_hash_check' AND conrelid = 'public.briefing_audio'::regclass) THEN
    ALTER TABLE "public"."briefing_audio" ADD CONSTRAINT "briefing_audio_text_hash_check" CHECK ("text_hash" IS NULL OR "text_hash" ~ '^[0-9a-f]{64}$') NOT VALID;
  END IF;
END $$;

-- 2. validate every CHECK still NOT VALID, failing loudly with the offending row count ------------------------------------------------
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

RESET lock_timeout;
