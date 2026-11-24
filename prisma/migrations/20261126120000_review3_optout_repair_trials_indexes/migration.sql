-- Adversarial review round 3 (docs/review/07).
--  1. H3: repair legacy STOP opt-outs whose phone_e164 was derived blindly from the last 10 digits (+52 / +44 numbers
--     were re-mapped onto unrelated +1 numbers, so the real customer was texted again).
--  2. L1: trial_fingerprints (one free trial per card / normalised email).
--  3. H2: index for the cross-business verification-text caps (sms_log consent_basis + created_at).
-- Idempotent (the repair can be re-run) and safe on databases where 20261125120000 ran BEFORE it was corrected.

-- ============================================================================
-- 1. Opt-out repair
-- ============================================================================
-- A "legacy" opt-out is one recorded before the E.164 columns existed: its phone_key holds only the last <=10 digits
-- of whatever number sent STOP (no '+'), so its country is unknowable from the key. Rows written after the previous
-- migration finished (by the application) have a trustworthy phone_e164 and are left alone.
-- For each legacy row the E.164 is set ONLY when the same business has seen exactly one distinct E.164 ending in those
-- digits (sms_log.to_e164, calls.caller_e164, bookings.phone_e164). Anything else (no evidence, or several countries)
-- becomes NULL: the application then matches the row by phone_key for EVERY country, i.e. it errs toward suppression
-- (a stranger's number may be over-suppressed; an opted-out customer is never texted). US/CA customers stay protected
-- either way.
DO $$
DECLARE
  cutoff TIMESTAMPTZ;
  fixed BIGINT;
  cleared BIGINT;
  keyed BIGINT;
BEGIN
  -- (the bookkeeping table does not exist in shadow databases: then everything counts as legacy)
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT max("finished_at") FROM "public"."_prisma_migrations" WHERE "migration_name" = ''20261125120000_accounts_billing_e164_constraints'''
       INTO cutoff;
  END IF;
  IF cutoff IS NULL THEN cutoff := now(); END IF;

  CREATE TEMP TABLE _rc_legacy_fix ON COMMIT DROP AS
  WITH legacy AS (
    SELECT "id", "business_id", "phone_key", "phone_e164"
      FROM "public"."sms_opt_outs"
     WHERE "opted_out_at" <= cutoff AND "phone_key" ~ '^[0-9]{1,10}$'
  ), ev AS (
    SELECT "business_id", "to_e164" AS e164 FROM "public"."sms_log" WHERE "to_e164" IS NOT NULL
    UNION ALL SELECT "business_id", "caller_e164" FROM "public"."calls" WHERE "caller_e164" IS NOT NULL
    UNION ALL SELECT "business_id", "phone_e164" FROM "public"."bookings" WHERE "phone_e164" IS NOT NULL
  ), cand AS (
    SELECT l."id", array_agg(DISTINCT e.e164) AS e164s
      FROM legacy l
      JOIN ev e ON e."business_id" = l."business_id"
               AND right(regexp_replace(e.e164, '[^0-9]', '', 'g'), 10) = l."phone_key"
     GROUP BY l."id"
  )
  SELECT l."id", l."phone_e164" AS old_e164,
         CASE WHEN c.e164s IS NOT NULL AND cardinality(c.e164s) = 1 THEN c.e164s[1] ELSE NULL END AS new_e164
    FROM legacy l LEFT JOIN cand c ON c."id" = l."id";

  UPDATE "public"."sms_opt_outs" o SET "phone_e164" = f.new_e164
    FROM _rc_legacy_fix f
   WHERE o."id" = f."id" AND o."phone_e164" IS DISTINCT FROM f.new_e164;
  GET DIAGNOSTICS fixed = ROW_COUNT;
  SELECT count(*) INTO cleared FROM _rc_legacy_fix WHERE new_e164 IS NULL;

  -- Non-US rows written by the new code use the full E.164 as phone_key: make phone_e164 agree with it.
  UPDATE "public"."sms_opt_outs" SET "phone_e164" = "phone_key"
   WHERE "phone_key" ~ '^\+[1-9][0-9]{6,14}$' AND "phone_e164" IS DISTINCT FROM "phone_key";
  GET DIAGNOSTICS keyed = ROW_COUNT;

  RAISE NOTICE 'opt-out repair: % legacy row(s) changed (% now country-agnostic, matched by last 10 digits), % non-US key row(s) aligned', fixed, cleared, keyed;
END $$;

-- ============================================================================
-- 2. Trial fingerprints (L1)
-- ============================================================================
-- CreateTable
CREATE TABLE "public"."trial_fingerprints" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "business_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trial_fingerprints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trial_fingerprints_kind_fingerprint_key" ON "public"."trial_fingerprints"("kind", "fingerprint");

-- ============================================================================
-- 3. Verification-text cap index (H2)
-- ============================================================================
-- CreateIndex
CREATE INDEX "sms_log_consent_basis_created_at_idx" ON "public"."sms_log"("consent_basis", "created_at");

-- CreateIndex (cross-business anti-pumping lookups: "was this number opted out / verified elsewhere?")
CREATE INDEX "sms_opt_outs_phone_e164_idx" ON "public"."sms_opt_outs"("phone_e164");

-- CreateIndex
CREATE INDEX "businesses_owner_phone_e164_idx" ON "public"."businesses"("owner_phone_e164");
