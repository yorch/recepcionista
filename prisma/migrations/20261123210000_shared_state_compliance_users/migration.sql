-- Shared state out of process memory (rate limit, event dedupe, provision lease),
-- compliance (SMS opt-out, consent, retention) and per-tenant auth (users, sessions).
-- Hand-written. Tables/columns/indexes use IF NOT EXISTS where that is harmless; the
-- CHECK constraints are intentionally NOT guarded (Prisma applies this file exactly once).
-- Prisma does not model CHECK constraints, so they cause no drift in `migrate diff`.

-- 1. Compliance columns on existing tables -----------------------------------
ALTER TABLE "public"."businesses" ADD COLUMN IF NOT EXISTS "retention_days" INTEGER NOT NULL DEFAULT 365;
ALTER TABLE "public"."businesses" ADD COLUMN IF NOT EXISTS "recording_disclosure_text" TEXT;
ALTER TABLE "public"."businesses"
  ADD CONSTRAINT "businesses_retention_days_check" CHECK ("retention_days" >= 1 AND "retention_days" <= 3650);

ALTER TABLE "public"."calls" ADD COLUMN IF NOT EXISTS "recording_disclosed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "public"."calls" ADD COLUMN IF NOT EXISTS "consent_status" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "public"."calls"
  ADD CONSTRAINT "calls_consent_status_check" CHECK ("consent_status" IN ('unknown', 'disclosed', 'declined'));

ALTER TABLE "public"."sms_log" ADD COLUMN IF NOT EXISTS "consent_basis" TEXT;

ALTER TABLE "public"."bookings" ADD COLUMN IF NOT EXISTS "anonymized_at" TIMESTAMP(3);

-- 2. SMS opt-outs -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "public"."sms_opt_outs" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "phone_key" TEXT NOT NULL,
    "opted_out_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    CONSTRAINT "sms_opt_outs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "sms_opt_outs_business_id_phone_key_key" ON "public"."sms_opt_outs"("business_id", "phone_key");
ALTER TABLE "public"."sms_opt_outs" ADD CONSTRAINT "sms_opt_outs_business_id_fkey"
  FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. Shared infrastructure state ------------------------------------------------
CREATE TABLE IF NOT EXISTS "public"."rate_limit_buckets" (
    "key" TEXT NOT NULL,
    "window_start" TIMESTAMPTZ(6) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY ("key", "window_start")
);
CREATE INDEX IF NOT EXISTS "rate_limit_buckets_window_start_idx" ON "public"."rate_limit_buckets"("window_start");

CREATE TABLE IF NOT EXISTS "public"."processed_events" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("source", "id")
);
CREATE INDEX IF NOT EXISTS "processed_events_created_at_idx" ON "public"."processed_events"("created_at");

CREATE TABLE IF NOT EXISTS "public"."provision_locks" (
    "key" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "acquired_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "provision_locks_pkey" PRIMARY KEY ("key")
);
CREATE INDEX IF NOT EXISTS "provision_locks_expires_at_idx" ON "public"."provision_locks"("expires_at");

-- 4. Users and sessions ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS "public"."users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "business_id" TEXT,
    "role" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disabled_at" TIMESTAMP(3),
    CONSTRAINT "users_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "users_email_lowercase_check" CHECK ("email" = lower("email")),
    CONSTRAINT "users_role_check" CHECK ("role" IN ('owner', 'staff', 'admin')),
    -- Tenant users must belong to a business; only platform admins are unscoped.
    CONSTRAINT "users_role_business_check" CHECK ("role" = 'admin' OR "business_id" IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_key" ON "public"."users"("email");
CREATE INDEX IF NOT EXISTS "users_business_id_idx" ON "public"."users"("business_id");
ALTER TABLE "public"."users" ADD CONSTRAINT "users_business_id_fkey"
  FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "public"."user_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "user_sessions_token_hash_key" ON "public"."user_sessions"("token_hash");
CREATE INDEX IF NOT EXISTS "user_sessions_user_id_idx" ON "public"."user_sessions"("user_id");
CREATE INDEX IF NOT EXISTS "user_sessions_expires_at_idx" ON "public"."user_sessions"("expires_at");
ALTER TABLE "public"."user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
