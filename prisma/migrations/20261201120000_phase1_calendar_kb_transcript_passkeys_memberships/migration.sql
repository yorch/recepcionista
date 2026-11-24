-- Phase 1 (all new tables/columns for the next feature set, in ONE migration so later work needs none):
--   Google Calendar two-way sync, owner call-in KB updates, live transcript, STIR/SHAKEN caller trust, usage reconciliation + 80/100% warnings,
--   passkeys (WebAuthn), multi-business memberships, locale / vertical / voice / refund policy / billing interval, booking reschedule + refunds.
--
-- LOCKING: every ALTER TABLE ... ADD COLUMN below has a constant default (or none), so on PG 11+ it is a catalog-only change (no rewrite).
-- CHECK constraints are added NOT VALID (brief lock, no scan) and validated at the end in one pass that reports the offending
-- constraint and row count. The only statements that touch existing rows are the two backfills (memberships, calls.metered_at), which
-- take row locks only. Re-runnable in parts: tables/columns/indexes use IF NOT EXISTS, constraints and triggers are guarded.
--
-- Prisma cannot express CHECK constraints, triggers or functions; they are invisible to its drift check.

-- AlterTable
ALTER TABLE "public"."bookings" ADD COLUMN IF NOT EXISTS     "cancel_reason" TEXT,
ADD COLUMN IF NOT EXISTS     "cancelled_at" TIMESTAMPTZ(6),
ADD COLUMN IF NOT EXISTS     "customer_notified_at" TIMESTAMPTZ(6),
ADD COLUMN IF NOT EXISTS     "refund_amount_cents" INTEGER,
ADD COLUMN IF NOT EXISTS     "refund_status" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN IF NOT EXISTS     "refunded_at" TIMESTAMPTZ(6),
ADD COLUMN IF NOT EXISTS     "reschedule_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS     "rescheduled_from_id" TEXT,
ADD COLUMN IF NOT EXISTS     "stripe_checkout_session_id" TEXT,
ADD COLUMN IF NOT EXISTS     "stripe_payment_intent_id" TEXT,
ADD COLUMN IF NOT EXISTS     "stripe_refund_id" TEXT;

-- AlterTable
ALTER TABLE "public"."businesses" ADD COLUMN IF NOT EXISTS     "billing_interval" TEXT NOT NULL DEFAULT 'month',
ADD COLUMN IF NOT EXISTS     "locale_default" TEXT NOT NULL DEFAULT 'en',
ADD COLUMN IF NOT EXISTS     "refund_policy" TEXT NOT NULL DEFAULT 'full_24h',
ADD COLUMN IF NOT EXISTS     "refund_policy_text" TEXT,
ADD COLUMN IF NOT EXISTS     "vertical" TEXT NOT NULL DEFAULT 'hvac',
ADD COLUMN IF NOT EXISTS     "voice_id" TEXT,
ADD COLUMN IF NOT EXISTS     "voice_name" TEXT;

-- AlterTable
ALTER TABLE "public"."calls" ADD COLUMN IF NOT EXISTS     "caller_verified" BOOLEAN,
ADD COLUMN IF NOT EXISTS     "kind" TEXT NOT NULL DEFAULT 'customer',
ADD COLUMN IF NOT EXISTS     "metered_at" TIMESTAMPTZ(6),
ADD COLUMN IF NOT EXISTS     "reconcile_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS     "stir_status" TEXT,
ADD COLUMN IF NOT EXISTS     "transfer_status" TEXT NOT NULL DEFAULT 'none';

-- AlterTable
ALTER TABLE "public"."usage_counters" ADD COLUMN IF NOT EXISTS     "ai_warned_100_at" TIMESTAMPTZ(6),
ADD COLUMN IF NOT EXISTS     "ai_warned_80_at" TIMESTAMPTZ(6),
ADD COLUMN IF NOT EXISTS     "forward_warned_100_at" TIMESTAMPTZ(6),
ADD COLUMN IF NOT EXISTS     "forward_warned_80_at" TIMESTAMPTZ(6),
ADD COLUMN IF NOT EXISTS     "sms_warned_100_at" TIMESTAMPTZ(6),
ADD COLUMN IF NOT EXISTS     "sms_warned_80_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "public"."user_sessions" ADD COLUMN IF NOT EXISTS     "active_business_id" TEXT;

-- AlterTable
ALTER TABLE "public"."users" ADD COLUMN IF NOT EXISTS     "locale" TEXT NOT NULL DEFAULT 'en';

-- CreateTable
CREATE TABLE IF NOT EXISTS "public"."calendar_connections" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "connected_by_user_id" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'google',
    "account_email" TEXT NOT NULL,
    "calendar_id" TEXT NOT NULL DEFAULT 'primary',
    "access_token_enc" TEXT,
    "refresh_token_enc" TEXT,
    "token_expires_at" TIMESTAMPTZ(6),
    "scopes" TEXT NOT NULL DEFAULT '',
    "sync_token" TEXT,
    "watch_channel_id" TEXT,
    "watch_resource_id" TEXT,
    "watch_expires_at" TIMESTAMPTZ(6),
    "status" TEXT NOT NULL DEFAULT 'active',
    "last_sync_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calendar_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "public"."calendar_event_links" (
    "id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "google_event_id" TEXT NOT NULL,
    "etag" TEXT,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_pushed_hash" TEXT,

    CONSTRAINT "calendar_event_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "public"."calendar_busy_blocks" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "google_event_id" TEXT NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "all_day" BOOLEAN NOT NULL DEFAULT false,
    "transparency" TEXT NOT NULL DEFAULT 'opaque',
    "summary_redacted" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calendar_busy_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "public"."owner_kb_changes" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "call_id" TEXT,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "summary" TEXT NOT NULL,
    "patch" JSONB NOT NULL DEFAULT '{}',
    "previous" JSONB,
    "applied_at" TIMESTAMPTZ(6),
    "reverted_at" TIMESTAMPTZ(6),
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "owner_kb_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "public"."call_transcript_events" (
    "id" TEXT NOT NULL,
    "call_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL,
    "is_final" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "call_transcript_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "public"."passkey_credentials" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "credential_id" TEXT NOT NULL,
    "public_key" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[],
    "device_type" TEXT NOT NULL DEFAULT 'singleDevice',
    "backed_up" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL DEFAULT 'Passkey',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(6),

    CONSTRAINT "passkey_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "public"."webauthn_challenges" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "purpose" TEXT NOT NULL,
    "challenge_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webauthn_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "public"."memberships" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disabled_at" TIMESTAMPTZ(6),

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "calendar_connections_status_idx" ON "public"."calendar_connections"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "calendar_connections_watch_expires_at_idx" ON "public"."calendar_connections"("watch_expires_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "calendar_connections_watch_channel_id_idx" ON "public"."calendar_connections"("watch_channel_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "calendar_connections_business_id_provider_key" ON "public"."calendar_connections"("business_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "calendar_event_links_booking_id_key" ON "public"."calendar_event_links"("booking_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "calendar_event_links_connection_id_google_event_id_key" ON "public"."calendar_event_links"("connection_id", "google_event_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "calendar_busy_blocks_business_id_starts_at_ends_at_idx" ON "public"."calendar_busy_blocks"("business_id", "starts_at", "ends_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "calendar_busy_blocks_connection_id_google_event_id_key" ON "public"."calendar_busy_blocks"("connection_id", "google_event_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "owner_kb_changes_business_id_created_at_idx" ON "public"."owner_kb_changes"("business_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "owner_kb_changes_call_id_idx" ON "public"."owner_kb_changes"("call_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "call_transcript_events_call_id_seq_key" ON "public"."call_transcript_events"("call_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "passkey_credentials_credential_id_key" ON "public"."passkey_credentials"("credential_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "passkey_credentials_user_id_idx" ON "public"."passkey_credentials"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "webauthn_challenges_challenge_hash_key" ON "public"."webauthn_challenges"("challenge_hash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "webauthn_challenges_expires_at_idx" ON "public"."webauthn_challenges"("expires_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "webauthn_challenges_user_id_idx" ON "public"."webauthn_challenges"("user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "memberships_business_id_idx" ON "public"."memberships"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "memberships_user_id_business_id_key" ON "public"."memberships"("user_id", "business_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "bookings_stripe_payment_intent_id_idx" ON "public"."bookings"("stripe_payment_intent_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "bookings_stripe_checkout_session_id_idx" ON "public"."bookings"("stripe_checkout_session_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "bookings_rescheduled_from_id_idx" ON "public"."bookings"("rescheduled_from_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "calls_metered_at_started_at_idx" ON "public"."calls"("metered_at", "started_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_sessions_active_business_id_idx" ON "public"."user_sessions"("active_business_id");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_rescheduled_from_id_fkey' AND conrelid = 'public.bookings'::regclass) THEN
    ALTER TABLE "public"."bookings" ADD CONSTRAINT "bookings_rescheduled_from_id_fkey" FOREIGN KEY ("rescheduled_from_id") REFERENCES "public"."bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_sessions_active_business_id_fkey' AND conrelid = 'public.user_sessions'::regclass) THEN
    ALTER TABLE "public"."user_sessions" ADD CONSTRAINT "user_sessions_active_business_id_fkey" FOREIGN KEY ("active_business_id") REFERENCES "public"."businesses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calendar_connections_business_id_fkey' AND conrelid = 'public.calendar_connections'::regclass) THEN
    ALTER TABLE "public"."calendar_connections" ADD CONSTRAINT "calendar_connections_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calendar_connections_connected_by_user_id_fkey' AND conrelid = 'public.calendar_connections'::regclass) THEN
    ALTER TABLE "public"."calendar_connections" ADD CONSTRAINT "calendar_connections_connected_by_user_id_fkey" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calendar_event_links_booking_id_fkey' AND conrelid = 'public.calendar_event_links'::regclass) THEN
    ALTER TABLE "public"."calendar_event_links" ADD CONSTRAINT "calendar_event_links_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calendar_event_links_connection_id_fkey' AND conrelid = 'public.calendar_event_links'::regclass) THEN
    ALTER TABLE "public"."calendar_event_links" ADD CONSTRAINT "calendar_event_links_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "public"."calendar_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calendar_busy_blocks_connection_id_fkey' AND conrelid = 'public.calendar_busy_blocks'::regclass) THEN
    ALTER TABLE "public"."calendar_busy_blocks" ADD CONSTRAINT "calendar_busy_blocks_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "public"."calendar_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calendar_busy_blocks_business_id_fkey' AND conrelid = 'public.calendar_busy_blocks'::regclass) THEN
    ALTER TABLE "public"."calendar_busy_blocks" ADD CONSTRAINT "calendar_busy_blocks_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'owner_kb_changes_business_id_fkey' AND conrelid = 'public.owner_kb_changes'::regclass) THEN
    ALTER TABLE "public"."owner_kb_changes" ADD CONSTRAINT "owner_kb_changes_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'owner_kb_changes_call_id_fkey' AND conrelid = 'public.owner_kb_changes'::regclass) THEN
    ALTER TABLE "public"."owner_kb_changes" ADD CONSTRAINT "owner_kb_changes_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_transcript_events_call_id_fkey' AND conrelid = 'public.call_transcript_events'::regclass) THEN
    ALTER TABLE "public"."call_transcript_events" ADD CONSTRAINT "call_transcript_events_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'passkey_credentials_user_id_fkey' AND conrelid = 'public.passkey_credentials'::regclass) THEN
    ALTER TABLE "public"."passkey_credentials" ADD CONSTRAINT "passkey_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'webauthn_challenges_user_id_fkey' AND conrelid = 'public.webauthn_challenges'::regclass) THEN
    ALTER TABLE "public"."webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memberships_user_id_fkey' AND conrelid = 'public.memberships'::regclass) THEN
    ALTER TABLE "public"."memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memberships_business_id_fkey' AND conrelid = 'public.memberships'::regclass) THEN
    ALTER TABLE "public"."memberships" ADD CONSTRAINT "memberships_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;


-- ============================================================================
-- Backfills (row locks only)
-- ============================================================================

-- Memberships: every non-admin user becomes a member of the business in users.business_id with users.role / disabled state.
INSERT INTO "public"."memberships" ("id", "user_id", "business_id", "role", "created_at", "disabled_at")
SELECT gen_random_uuid()::text, u."id", u."business_id", u."role", now(), NULL
  FROM "public"."users" u
 WHERE u."role" <> 'admin' AND u."business_id" IS NOT NULL AND u."role" IN ('owner', 'staff')
ON CONFLICT ("user_id", "business_id") DO NOTHING;

-- Calls that existed before usage reconciliation count as settled: the reconcile job must never meter history a second time.
UPDATE "public"."calls" SET "metered_at" = COALESCE("ended_at", "started_at") AT TIME ZONE 'UTC' WHERE "metered_at" IS NULL;

-- ============================================================================
-- CHECK constraints (NOT VALID first, validated at the end)
-- ============================================================================

DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('businesses', 'businesses_locale_default_check',  'CHECK ("locale_default" IN (''en'', ''es''))'),
      ('businesses', 'businesses_vertical_check',        'CHECK ("vertical" IN (''hvac'', ''plumbing'', ''electrical'', ''cleaning'', ''landscaping'', ''dental'', ''general''))'),
      ('businesses', 'businesses_refund_policy_check',   'CHECK ("refund_policy" IN (''none'', ''full_24h'', ''full_48h'', ''full_always''))'),
      ('businesses', 'businesses_refund_policy_text_check', 'CHECK ("refund_policy_text" IS NULL OR char_length("refund_policy_text") <= 2000)'),
      ('businesses', 'businesses_billing_interval_check','CHECK ("billing_interval" IN (''month'', ''year''))'),
      ('users',      'users_locale_check',               'CHECK ("locale" IN (''en'', ''es''))'),
      ('calls',      'calls_kind_check',                 'CHECK ("kind" IN (''customer'', ''owner''))'),
      ('calls',      'calls_transfer_status_check',      'CHECK ("transfer_status" IN (''none'', ''attempted'', ''connected'', ''failed'', ''declined''))'),
      ('calls',      'calls_reconcile_attempts_check',   'CHECK ("reconcile_attempts" >= 0)'),
      ('bookings',   'bookings_refund_status_check',     'CHECK ("refund_status" IN (''none'', ''pending'', ''refunded'', ''failed'', ''not_applicable''))'),
      ('bookings',   'bookings_refund_amount_check',     'CHECK ("refund_amount_cents" IS NULL OR "refund_amount_cents" >= 0)'),
      ('bookings',   'bookings_refunded_shape_check',    'CHECK ("refund_status" <> ''refunded'' OR ("refund_amount_cents" IS NOT NULL AND "refunded_at" IS NOT NULL))'),
      ('bookings',   'bookings_reschedule_count_check',  'CHECK ("reschedule_count" >= 0)'),
      ('bookings',   'bookings_cancel_reason_check',     'CHECK ("cancel_reason" IS NULL OR char_length("cancel_reason") <= 500)'),
      ('memberships','memberships_role_check',           'CHECK ("role" IN (''owner'', ''staff''))'),
      ('calendar_connections', 'calendar_connections_provider_check', 'CHECK ("provider" IN (''google''))'),
      ('calendar_connections', 'calendar_connections_status_check',   'CHECK ("status" IN (''active'', ''needs_reauth'', ''revoked'', ''error''))'),
      ('calendar_connections', 'calendar_connections_active_tokens_check', 'CHECK ("status" <> ''active'' OR "refresh_token_enc" IS NOT NULL)'),
      ('calendar_busy_blocks', 'calendar_busy_blocks_transparency_check', 'CHECK ("transparency" IN (''opaque'', ''transparent''))'),
      ('calendar_busy_blocks', 'calendar_busy_blocks_range_check',        'CHECK ("ends_at" >= "starts_at")'),
      ('owner_kb_changes', 'owner_kb_changes_source_check',  'CHECK ("source" IN (''owner_voice'', ''owner_sms'', ''dashboard''))'),
      ('owner_kb_changes', 'owner_kb_changes_status_check',  'CHECK ("status" IN (''proposed'', ''applied'', ''reverted'', ''rejected''))'),
      ('owner_kb_changes', 'owner_kb_changes_patch_check',   'CHECK (jsonb_typeof("patch") = ''object'')'),
      ('owner_kb_changes', 'owner_kb_changes_applied_check', 'CHECK ("status" NOT IN (''applied'', ''reverted'') OR "applied_at" IS NOT NULL)'),
      ('owner_kb_changes', 'owner_kb_changes_reverted_check','CHECK ("status" <> ''reverted'' OR "reverted_at" IS NOT NULL)'),
      ('call_transcript_events', 'call_transcript_events_role_check', 'CHECK ("role" IN (''agent'', ''caller'', ''system''))'),
      ('call_transcript_events', 'call_transcript_events_seq_check',  'CHECK ("seq" >= 0)'),
      ('call_transcript_events', 'call_transcript_events_text_check', 'CHECK (char_length("text") <= 20000)'),
      ('passkey_credentials', 'passkey_credentials_counter_check',     'CHECK ("counter" >= 0)'),
      ('passkey_credentials', 'passkey_credentials_device_type_check', 'CHECK ("device_type" IN (''singleDevice'', ''multiDevice''))'),
      ('webauthn_challenges', 'webauthn_challenges_purpose_check',     'CHECK ("purpose" IN (''register'', ''login'', ''reauth''))'),
      ('webauthn_challenges', 'webauthn_challenges_user_check',        'CHECK ("purpose" = ''login'' OR "user_id" IS NOT NULL)')
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
-- Triggers (compatibility with code that still writes users.business_id / users.role, and privacy guards)
-- ============================================================================

-- A legacy write of users.business_id / users.role (signup, admin-created users, scripts, old code paths) is mirrored into memberships.
CREATE OR REPLACE FUNCTION "public"."rc_sync_user_membership"() RETURNS trigger AS $$
BEGIN
  IF NEW."role" IN ('owner', 'staff') AND NEW."business_id" IS NOT NULL THEN
    INSERT INTO "public"."memberships" ("id", "user_id", "business_id", "role", "created_at")
    VALUES (gen_random_uuid()::text, NEW."id", NEW."business_id", NEW."role", now())
    ON CONFLICT ("user_id", "business_id") DO UPDATE SET "role" = EXCLUDED."role"
      WHERE "public"."memberships"."role" IS DISTINCT FROM EXCLUDED."role";
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "rc_users_sync_membership" ON "public"."users";
CREATE TRIGGER "rc_users_sync_membership"
  AFTER INSERT OR UPDATE OF "business_id", "role" ON "public"."users"
  FOR EACH ROW EXECUTE FUNCTION "public"."rc_sync_user_membership"();

-- Deleting a business must not delete people who also belong to ANOTHER business (users.business_id is ON DELETE CASCADE):
-- first move their legacy primary business to one they still belong to. Users with no other membership are removed by the cascade, as before.
CREATE OR REPLACE FUNCTION "public"."rc_business_repoint_users"() RETURNS trigger AS $$
BEGIN
  UPDATE "public"."users" u SET "business_id" = m."business_id", "role" = m."role"
    FROM (
      SELECT DISTINCT ON (ms."user_id") ms."user_id", ms."business_id", ms."role"
        FROM "public"."memberships" ms
       WHERE ms."business_id" <> OLD."id"
         AND ms."user_id" IN (SELECT x."id" FROM "public"."users" x WHERE x."business_id" = OLD."id" AND x."role" <> 'admin')
       ORDER BY ms."user_id", (ms."disabled_at" IS NULL) DESC, ms."created_at"
    ) m
   WHERE u."business_id" = OLD."id" AND u."id" = m."user_id";
  RETURN OLD;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "rc_businesses_repoint_users" ON "public"."businesses";
CREATE TRIGGER "rc_businesses_repoint_users"
  BEFORE DELETE ON "public"."businesses"
  FOR EACH ROW EXECUTE FUNCTION "public"."rc_business_repoint_users"();

-- Privacy guard: no transcript rows are ever stored for a call whose consent is 'declined' (the insert is skipped), and a call that BECOMES
-- 'declined' loses the rows it already has. Consent 'declined' is sticky (see updateCall), so this cannot flip back.
CREATE OR REPLACE FUNCTION "public"."rc_transcript_consent_guard"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."calls" c WHERE c."id" = NEW."call_id" AND c."consent_status" = 'declined') THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "rc_transcript_consent_guard" ON "public"."call_transcript_events";
CREATE TRIGGER "rc_transcript_consent_guard"
  BEFORE INSERT ON "public"."call_transcript_events"
  FOR EACH ROW EXECUTE FUNCTION "public"."rc_transcript_consent_guard"();

CREATE OR REPLACE FUNCTION "public"."rc_call_declined_purge"() RETURNS trigger AS $$
BEGIN
  DELETE FROM "public"."call_transcript_events" WHERE "call_id" = NEW."id";
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "rc_call_declined_purge" ON "public"."calls";
CREATE TRIGGER "rc_call_declined_purge"
  AFTER UPDATE OF "consent_status" ON "public"."calls"
  FOR EACH ROW WHEN (NEW."consent_status" = 'declined' AND OLD."consent_status" IS DISTINCT FROM 'declined')
  EXECUTE FUNCTION "public"."rc_call_declined_purge"();

-- ============================================================================
-- Validate every CHECK still marked NOT VALID (fails loudly with the offending row count)
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
