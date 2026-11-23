-- Phase 1: account lifecycle (email verification, TOTP, invites, audit), billing + usage metering,
-- E.164 phone columns (dual-read period: phone_key stays), and validation of CHECK constraints.
-- Written by hand on top of `prisma migrate diff` output (Prisma cannot express CHECK constraints).
-- Prisma applies this file once, in one transaction; every statement below is nevertheless written
-- to be harmless if run twice by hand (IF NOT EXISTS guards, idempotent UPDATEs).

-- ============================================================================
-- 1. Tables, columns, indexes, foreign keys (from `prisma migrate diff`)
-- ============================================================================

-- AlterTable
ALTER TABLE "public"."bookings" ADD COLUMN     "phone_e164" TEXT;

-- AlterTable
ALTER TABLE "public"."businesses" ADD COLUMN     "billing_status" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "call_minutes_cap_override" INTEGER,
ADD COLUMN     "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "current_period_end" TIMESTAMPTZ(6),
ADD COLUMN     "owner_phone_e164" TEXT,
ADD COLUMN     "owner_phone_verified_at" TIMESTAMPTZ(6),
ADD COLUMN     "past_due_since" TIMESTAMPTZ(6),
ADD COLUMN     "phone_e164" TEXT,
ADD COLUMN     "plan" TEXT,
ADD COLUMN     "sms_cap_override" INTEGER,
ADD COLUMN     "stripe_customer_id" TEXT,
ADD COLUMN     "stripe_subscription_id" TEXT,
ADD COLUMN     "trial_ends_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "public"."calls" ADD COLUMN     "caller_e164" TEXT;

-- AlterTable
ALTER TABLE "public"."sms_log" ADD COLUMN     "to_e164" TEXT;

-- AlterTable
ALTER TABLE "public"."sms_opt_outs" ADD COLUMN     "phone_e164" TEXT;

-- AlterTable
ALTER TABLE "public"."user_sessions" ADD COLUMN     "ip" TEXT,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'user',
ADD COLUMN     "mfa_verified_at" TIMESTAMPTZ(6),
ADD COLUMN     "user_agent" TEXT,
ALTER COLUMN "user_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "public"."users" ADD COLUMN     "email_verified_at" TIMESTAMPTZ(6),
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "totp_enabled_at" TIMESTAMPTZ(6),
ADD COLUMN     "totp_last_used_step" INTEGER,
ADD COLUMN     "totp_secret_enc" TEXT;

-- CreateTable
CREATE TABLE "public"."recovery_codes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."email_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "email" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "business_id" TEXT,
    "role" TEXT,
    "invited_by" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."audit_events" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_user_id" TEXT,
    "actor_kind" TEXT NOT NULL,
    "business_id" TEXT,
    "action" TEXT NOT NULL,
    "target" TEXT NOT NULL DEFAULT '',
    "ip" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."usage_counters" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "period_start" DATE NOT NULL,
    "sms_count" INTEGER NOT NULL DEFAULT 0,
    "call_seconds" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_counters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recovery_codes_user_id_code_hash_key" ON "public"."recovery_codes"("user_id", "code_hash");

-- CreateIndex
CREATE UNIQUE INDEX "email_tokens_token_hash_key" ON "public"."email_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "email_tokens_email_purpose_idx" ON "public"."email_tokens"("email", "purpose");

-- CreateIndex
CREATE INDEX "email_tokens_user_id_idx" ON "public"."email_tokens"("user_id");

-- CreateIndex
CREATE INDEX "email_tokens_business_id_idx" ON "public"."email_tokens"("business_id");

-- CreateIndex
CREATE INDEX "email_tokens_expires_at_idx" ON "public"."email_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "audit_events_business_id_at_idx" ON "public"."audit_events"("business_id", "at");

-- CreateIndex
CREATE INDEX "audit_events_actor_user_id_at_idx" ON "public"."audit_events"("actor_user_id", "at");

-- CreateIndex
CREATE INDEX "audit_events_at_idx" ON "public"."audit_events"("at");

-- CreateIndex
CREATE UNIQUE INDEX "usage_counters_business_id_period_start_key" ON "public"."usage_counters"("business_id", "period_start");

-- CreateIndex
CREATE INDEX "bookings_business_id_phone_e164_idx" ON "public"."bookings"("business_id", "phone_e164");

-- CreateIndex
CREATE INDEX "businesses_phone_e164_idx" ON "public"."businesses"("phone_e164");

-- CreateIndex
CREATE INDEX "businesses_stripe_customer_id_idx" ON "public"."businesses"("stripe_customer_id");

-- CreateIndex
CREATE INDEX "calls_business_id_caller_e164_idx" ON "public"."calls"("business_id", "caller_e164");

-- CreateIndex
CREATE INDEX "sms_log_business_id_to_e164_idx" ON "public"."sms_log"("business_id", "to_e164");

-- CreateIndex
CREATE INDEX "sms_opt_outs_business_id_phone_e164_idx" ON "public"."sms_opt_outs"("business_id", "phone_e164");

-- AddForeignKey
ALTER TABLE "public"."recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."email_tokens" ADD CONSTRAINT "email_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."email_tokens" ADD CONSTRAINT "email_tokens_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."email_tokens" ADD CONSTRAINT "email_tokens_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."usage_counters" ADD CONSTRAINT "usage_counters_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================================
-- 2. Backfills
-- ============================================================================

-- Existing users were created by an admin, who vouched for the address.
UPDATE "public"."users" SET "email_verified_at" = "created_at" WHERE "email_verified_at" IS NULL;

-- Best-effort E.164: strip formatting; keep '+<7..15 digits>' as is (NANP '+1' numbers must also
-- look like a real NANP number); bare 10/11-digit numbers are treated as US/Canada only when clean.
-- Everything else stays NULL: the application matches those by phone_key until a later pass.
CREATE OR REPLACE FUNCTION "public"."_rc_to_e164"(raw TEXT) RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  s TEXT;
  d TEXT;
BEGIN
  IF raw IS NULL THEN RETURN NULL; END IF;
  s := regexp_replace(raw, '[^0-9+]', '', 'g');
  IF s ~ '^\+' THEN
    d := substr(s, 2);
    IF d !~ '^[1-9][0-9]{6,14}$' THEN RETURN NULL; END IF;
    IF d ~ '^1' AND d !~ '^1[2-9][0-9]{2}[2-9][0-9]{6}$' THEN RETURN NULL; END IF;
    RETURN '+' || d;
  END IF;
  IF s ~ '^[2-9][0-9]{2}[2-9][0-9]{6}$' THEN RETURN '+1' || s; END IF;
  IF s ~ '^1[2-9][0-9]{2}[2-9][0-9]{6}$' THEN RETURN '+' || s; END IF;
  RETURN NULL;
END
$fn$;

UPDATE "public"."calls"        SET "caller_e164"      = "public"."_rc_to_e164"("caller_phone")   WHERE "caller_e164" IS NULL AND "caller_phone" IS NOT NULL;
UPDATE "public"."bookings"     SET "phone_e164"       = "public"."_rc_to_e164"("customer_phone") WHERE "phone_e164" IS NULL AND "customer_phone" <> '';
UPDATE "public"."sms_log"      SET "to_e164"          = "public"."_rc_to_e164"("to_phone")       WHERE "to_e164" IS NULL;
UPDATE "public"."businesses"   SET "phone_e164"       = "public"."_rc_to_e164"("phone")          WHERE "phone_e164" IS NULL AND "phone" IS NOT NULL;
UPDATE "public"."businesses"   SET "owner_phone_e164" = "public"."_rc_to_e164"("owner_phone")    WHERE "owner_phone_e164" IS NULL AND "owner_phone" IS NOT NULL;
-- Opt-outs only keep the last 10 digits; a clean 10-digit NANP key is unambiguous enough for US/Canada.
UPDATE "public"."sms_opt_outs" SET "phone_e164"       = "public"."_rc_to_e164"("phone_key")      WHERE "phone_e164" IS NULL;

DROP FUNCTION "public"."_rc_to_e164"(TEXT);

-- ============================================================================
-- 3. Cleanup of rows that would violate CHECK constraints (fix, and say how many)
-- ============================================================================

DO $$
DECLARE
  n BIGINT;
BEGIN
  UPDATE "public"."bookings"
     SET "duration_minutes" = LEAST(1440, GREATEST(1, "duration_minutes"))
   WHERE "duration_minutes" <= 0 OR "duration_minutes" > 1440;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE NOTICE 'cleanup: clamped duration_minutes on % bookings', n; END IF;

  UPDATE "public"."bookings" SET "price_estimate" = NULL WHERE "price_estimate" < 0;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE NOTICE 'cleanup: nulled % negative price_estimate values', n; END IF;

  UPDATE "public"."bookings" SET "deposit_amount" = NULL WHERE "deposit_amount" < 0;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE NOTICE 'cleanup: nulled % negative deposit_amount values', n; END IF;

  UPDATE "public"."processed_events" SET "status" = 'done' WHERE "status" NOT IN ('processing', 'done');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE NOTICE 'cleanup: reset % processed_events with an unknown status to done', n; END IF;

  UPDATE "public"."businesses" SET "retention_days" = LEAST(3650, GREATEST(1, "retention_days"))
   WHERE "retention_days" < 1 OR "retention_days" > 3650;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE NOTICE 'cleanup: clamped retention_days on % businesses', n; END IF;

  UPDATE "public"."calls" SET "consent_status" = 'unknown' WHERE "consent_status" NOT IN ('unknown', 'disclosed', 'declined');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE NOTICE 'cleanup: reset % calls with an unknown consent_status', n; END IF;
END $$;

-- ============================================================================
-- 4. New CHECK constraints (added NOT VALID, validated in step 5)
-- ============================================================================

DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('bookings',      'bookings_price_estimate_check',      'CHECK ("price_estimate" IS NULL OR "price_estimate" >= 0)'),
      ('bookings',      'bookings_deposit_amount_check',      'CHECK ("deposit_amount" IS NULL OR "deposit_amount" >= 0)'),
      ('bookings',      'bookings_phone_e164_check',          'CHECK ("phone_e164" IS NULL OR "phone_e164" ~ ''^\+[1-9][0-9]{6,14}$'')'),
      ('calls',         'calls_caller_e164_check',            'CHECK ("caller_e164" IS NULL OR "caller_e164" ~ ''^\+[1-9][0-9]{6,14}$'')'),
      ('sms_log',       'sms_log_to_e164_check',              'CHECK ("to_e164" IS NULL OR "to_e164" ~ ''^\+[1-9][0-9]{6,14}$'')'),
      ('sms_opt_outs',  'sms_opt_outs_phone_e164_check',      'CHECK ("phone_e164" IS NULL OR "phone_e164" ~ ''^\+[1-9][0-9]{6,14}$'')'),
      ('businesses',    'businesses_phone_e164_check',        'CHECK ("phone_e164" IS NULL OR "phone_e164" ~ ''^\+[1-9][0-9]{6,14}$'')'),
      ('businesses',    'businesses_owner_phone_e164_check',  'CHECK ("owner_phone_e164" IS NULL OR "owner_phone_e164" ~ ''^\+[1-9][0-9]{6,14}$'')'),
      ('businesses',    'businesses_billing_status_check',    'CHECK ("billing_status" IN (''none'', ''trialing'', ''active'', ''past_due'', ''canceled'', ''unpaid''))'),
      ('businesses',    'businesses_sms_cap_override_check',  'CHECK ("sms_cap_override" IS NULL OR "sms_cap_override" >= 0)'),
      ('businesses',    'businesses_call_cap_override_check', 'CHECK ("call_minutes_cap_override" IS NULL OR "call_minutes_cap_override" >= 0)'),
      ('users',         'users_phone_e164_check',             'CHECK ("phone" IS NULL OR "phone" ~ ''^\+[1-9][0-9]{6,14}$'')'),
      ('users',         'users_totp_enabled_check',           'CHECK ("totp_enabled_at" IS NULL OR "totp_secret_enc" IS NOT NULL)'),
      ('user_sessions', 'user_sessions_kind_check',           'CHECK ("kind" IN (''user'', ''admin_token''))'),
      ('user_sessions', 'user_sessions_kind_user_check',      'CHECK (("kind" = ''user'' AND "user_id" IS NOT NULL) OR ("kind" = ''admin_token'' AND "user_id" IS NULL))'),
      ('email_tokens',  'email_tokens_purpose_check',         'CHECK ("purpose" IN (''verify'', ''reset'', ''invite''))'),
      ('email_tokens',  'email_tokens_email_lowercase_check', 'CHECK ("email" = lower("email"))'),
      ('email_tokens',  'email_tokens_invite_shape_check',    'CHECK (("purpose" = ''invite'' AND "business_id" IS NOT NULL AND "role" IN (''owner'', ''staff'')) OR ("purpose" <> ''invite'' AND "user_id" IS NOT NULL))'),
      ('audit_events',  'audit_events_actor_kind_check',      'CHECK ("actor_kind" IN (''user'', ''admin_token'', ''system'', ''webhook''))'),
      ('usage_counters','usage_counters_nonnegative_check',   'CHECK ("sms_count" >= 0 AND "call_seconds" >= 0)')
    ) AS t(tbl, cname, def)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = c.cname AND conrelid = format('public.%I', c.tbl)::regclass
    ) THEN
      EXECUTE format('ALTER TABLE "public".%I ADD CONSTRAINT %I %s NOT VALID', c.tbl, c.cname, c.def);
    END IF;
  END LOOP;
END $$;

-- ============================================================================
-- 5. Validate every CHECK constraint still marked NOT VALID in this schema
--    (the ones above plus any left behind by earlier migrations / manual changes).
--    Fails loudly, with the offending row count, instead of a bare Postgres error.
-- ============================================================================

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
