-- Review 15 M1. Hand written, re-runnable, row updates only (no schema change).
--
-- The phase-1 migration (20261201120000) backfilled calls.metered_at = COALESCE(ended_at, started_at) for EVERY existing call. For a call that was
-- IN FLIGHT at that moment (no ended_at yet) the value was started_at. Its post-call webhook then arrived under the phase-1 code, stored ended_at
-- and duration_sec, and claimCallMetering refused because metered_at was already set: the call was never billed. The review-14 repair
-- (20261203120000, step 3) only matches rows whose metered_at still equals COALESCE(ended_at, started_at), i.e. calls that are STILL open, so it
-- misses exactly these calls once they finished.
--
-- Signature of a wrongly settled row: metered_at = started_at (the backfill value for an in-flight call; new code claims with now(), which is
-- never a call's own start), the call has since got an end (ended_at > started_at), and it started inside the window ending when phase 1 was
-- applied (it was in flight then). The window is anchored to the phase-1 apply time in _prisma_migrations, NOT to now(), so running this later
-- or again neither widens nor shifts it; without a phase-1 row (never applied here) nothing matches. Un-settling hands the call to the
-- reconcile job, which fetches the provider's duration and bills it once (claimCallMetering stamps now(), so a re-run no longer matches).
-- started_at is a timestamp without time zone holding UTC: compared with the UTC wall clock of the apply time, independent of session TimeZone.
-- `prisma migrate dev/diff` replays the history in a SHADOW database, which has no _prisma_migrations table: nothing to repair there.
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    UPDATE "public"."calls" c
       SET "metered_at" = NULL
      FROM (
        SELECT ("finished_at" AT TIME ZONE 'UTC') AS applied_utc
          FROM "public"."_prisma_migrations"
         WHERE "migration_name" = '20261201120000_phase1_calendar_kb_transcript_passkeys_memberships' AND "finished_at" IS NOT NULL
         ORDER BY "finished_at" DESC LIMIT 1
      ) p
     WHERE c."metered_at" = (c."started_at" AT TIME ZONE 'UTC')
       AND c."ended_at" IS NOT NULL AND c."ended_at" > c."started_at"
       AND c."conversation_id" IS NOT NULL
       AND c."started_at" <= p.applied_utc
       AND c."started_at" > p.applied_utc - interval '3 days';
  END IF;
END $$;
