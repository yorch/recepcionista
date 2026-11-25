-- The overlap EXCLUSION constraint becomes per (business, crew). Split out of 20261209120000_review19_fixes (review 23 A3) so that the ACCESS EXCLUSIVE lock
-- on `bookings` (held while the GiST index is built; an EXCLUDE constraint cannot be built CONCURRENTLY) is the ONLY lock this transaction holds.
-- Prisma runs the file as one transaction: nothing else here stacks on that lock. `lock_timeout` makes a busy table fail the deploy (re-run it) instead of
-- queueing every request behind it. Guarded: a database that already has the per-crew constraint (it applied the earlier, larger 20261209120000) is untouched.
-- On a database with more than ~100k bookings run the deploy in a maintenance window (docs/runbook.md section 4).
SET lock_timeout = '10s';

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
