-- Platform admin console, Phase 2/4/5/8 schema. Hand written, RE-RUNNABLE (IF NOT EXISTS / guarded DO blocks), additive. Prisma runs this file in ONE transaction, so it
-- only adds tables / columns / NOT VALID checks (validated afterwards) and updates the few rows that need a value; there is no index build on a big table
-- (every index here is on a table that is new and empty, or on `plans` / `job_runs` / the console tables).
--
--  1. Console tables: platform_settings (+ MAC, secret envelope, dual-secret window), setting_change_sets, platform_setting_revisions, tenant_setting_overrides,
--     settings_state (single row, the global version every instance polls, the incident freeze flag), instance_heartbeats.
--  2. plans (seeded from today's PLAN_* / COMP_PLANS defaults) and businesses.plan -> plans.key. A BEFORE trigger registers an unknown plan string as a hidden plan so
--     every writer that still stores a free string (Stripe webhook with BILLING_PLAN_NAME, tests, scripts) keeps working. EXISTING unknown strings are mapped to the
--     seeded 'legacy' plan and every remap is recorded in audit_events ('plans.migrated', meta.from) so nothing is lost.
--  3. job_runs, legal_pages + legal_page_versions, support_grants.
--  4. businesses.suspended_at / suspended_reason / suspended_by: a suspended tenant answers "out of service" and cannot send (enforced in src/lib/db/usage.ts).
--  5. users.platform_role (owner | ops | support | read_only); every existing admin user becomes 'owner'.
SET lock_timeout = '10s';

-- ---- 1. console tables --------------------------------------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "platform_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB,
    "secret_envelope" TEXT,
    "secret_fingerprint" TEXT,
    "secret_last4" TEXT,
    "previous_envelope" TEXT,
    "previous_until" TIMESTAMPTZ(6),
    "version" BIGINT NOT NULL DEFAULT 0,
    "integrity_mac" TEXT NOT NULL,
    "updated_by" TEXT,
    "updated_via" TEXT NOT NULL DEFAULT 'console',
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "platform_settings_one_of_check" CHECK (("value" IS NULL) <> ("secret_envelope" IS NULL)),
    CONSTRAINT "platform_settings_key_check" CHECK ("key" ~ '^[a-z_][a-z0-9_.]{0,119}$'),
    CONSTRAINT "platform_settings_fp_check" CHECK ("secret_fingerprint" IS NULL OR "secret_envelope" IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS "setting_change_sets" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'applied',
    "apply_at" TIMESTAMPTZ(6),
    "created_by" TEXT,
    "created_kind" TEXT NOT NULL DEFAULT 'user',
    "via" TEXT NOT NULL DEFAULT 'console',
    "approved_by" TEXT,
    "reason" TEXT,
    "tier" TEXT NOT NULL DEFAULT 'normal',
    "version" BIGINT NOT NULL DEFAULT 0,
    "rollback_of" TEXT,
    "summary" JSONB NOT NULL DEFAULT '{}',
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "setting_change_sets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "setting_change_sets_status_check" CHECK ("status" IN ('applied', 'rolled_back', 'pending_approval', 'scheduled')),
    CONSTRAINT "setting_change_sets_tier_check" CHECK ("tier" IN ('normal', 'sensitive', 'critical'))
);

CREATE TABLE IF NOT EXISTS "platform_setting_revisions" (
    "id" TEXT NOT NULL,
    "change_set_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "op" TEXT NOT NULL DEFAULT 'set',
    "old_present" BOOLEAN NOT NULL DEFAULT false,
    "old_value" JSONB,
    "new_value" JSONB,
    "old_fingerprint" TEXT,
    "new_fingerprint" TEXT,
    "prev_envelope" TEXT,
    "actor_user_id" TEXT,
    "actor_kind" TEXT NOT NULL DEFAULT 'user',
    "reason" TEXT,
    "ip" TEXT,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "platform_setting_revisions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_setting_revisions_op_check" CHECK ("op" IN ('set', 'remove'))
);

CREATE TABLE IF NOT EXISTS "tenant_setting_overrides" (
    "business_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tenant_setting_overrides_pkey" PRIMARY KEY ("business_id", "key")
);

CREATE TABLE IF NOT EXISTS "settings_state" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "global_version" BIGINT NOT NULL DEFAULT 0,
    "frozen_at" TIMESTAMPTZ(6),
    "frozen_by" TEXT,
    "frozen_reason" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "settings_state_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "settings_state_single_row_check" CHECK ("id" = 1)
);
INSERT INTO "settings_state" ("id", "global_version") VALUES (1, 0) ON CONFLICT ("id") DO NOTHING;

CREATE TABLE IF NOT EXISTS "instance_heartbeats" (
    "instance_id" TEXT NOT NULL,
    "settings_version" BIGINT NOT NULL DEFAULT 0,
    "build_sha" TEXT,
    "canary" TEXT NOT NULL DEFAULT 'none',
    "ignored_rows" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "instance_heartbeats_pkey" PRIMARY KEY ("instance_id"),
    CONSTRAINT "instance_heartbeats_canary_check" CHECK ("canary" IN ('ok', 'failed', 'none'))
);

-- ---- 2. plans -----------------------------------------------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "plans" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "public" BOOLEAN NOT NULL DEFAULT false,
    "is_comped" BOOLEAN NOT NULL DEFAULT false,
    "stripe_price_id" TEXT,
    "stripe_price_id_annual" TEXT,
    "trial_days" INTEGER,
    "sms_cap" INTEGER,
    "call_minutes_cap" INTEGER,
    "voicemail_minutes_cap" INTEGER,
    "forward_minutes_cap" INTEGER,
    "max_locations" INTEGER,
    "features" JSONB NOT NULL DEFAULT '{}',
    "sort" INTEGER NOT NULL DEFAULT 100,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT,
    CONSTRAINT "plans_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "plans_numbers_check" CHECK (
      ("trial_days" IS NULL OR "trial_days" BETWEEN 0 AND 365) AND ("sms_cap" IS NULL OR "sms_cap" >= 0) AND ("call_minutes_cap" IS NULL OR "call_minutes_cap" >= 0)
      AND ("voicemail_minutes_cap" IS NULL OR "voicemail_minutes_cap" >= 0) AND ("forward_minutes_cap" IS NULL OR "forward_minutes_cap" >= 0)
      AND ("max_locations" IS NULL OR "max_locations" >= 1)),
    CONSTRAINT "plans_features_object_check" CHECK (jsonb_typeof("features") = 'object')
);

-- Seed: today's defaults (PLAN_SMS_CAP 500, PLAN_CALL_MINUTES_CAP 300, VOICEMAIL_MINUTES_CAP 60, FORWARD_MINUTES_CAP 600; COMP_PLANS legacy + grandfathered).
-- An environment pin of a PLAN_* variable still wins over a plan row (precedence env > console), so a deployment that sets them keeps its numbers.
INSERT INTO "plans" ("key", "name", "public", "is_comped", "sms_cap", "call_minutes_cap", "voicemail_minutes_cap", "forward_minutes_cap", "sort") VALUES
  ('standard',     'Standard',               true,  false, 500, 300, 60, 600, 10),
  ('legacy',       'Legacy (comped)',        false, true,  500, 300, 60, 600, 90),
  ('grandfathered','Grandfathered (comped)', false, true,  500, 300, 60, 600, 91),
  ('demo',         'Demo',                   false, false, 500, 300, 60, 600, 99)
ON CONFLICT ("key") DO NOTHING;

-- A writer that still stores a free plan string registers it as a hidden, non-comped plan with NULL caps (= inherit the platform settings: exactly what an
-- unknown string meant before this table existed). The console lists these so an admin can rename, comp or archive them.
CREATE OR REPLACE FUNCTION "businesses_ensure_plan"() RETURNS trigger AS $$
BEGIN
  IF NEW."plan" IS NOT NULL THEN
    INSERT INTO "plans" ("key", "name", "public", "sort") VALUES (NEW."plan", left(NEW."plan", 120), false, 1000) ON CONFLICT ("key") DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "businesses_ensure_plan_trg" ON "businesses";
CREATE TRIGGER "businesses_ensure_plan_trg" BEFORE INSERT OR UPDATE OF "plan" ON "businesses" FOR EACH ROW EXECUTE FUNCTION "businesses_ensure_plan"();

-- Existing unknown strings -> 'legacy' (recorded, so nothing is lost). A second run finds none.
INSERT INTO "audit_events" ("id", "at", "actor_kind", "business_id", "action", "target", "meta")
SELECT gen_random_uuid()::text, now(), 'system', b."id", 'plans.migrated', 'business:' || b."id", jsonb_build_object('from', b."plan", 'to', 'legacy')
  FROM "businesses" b WHERE b."plan" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "plans" p WHERE p."key" = b."plan");
UPDATE "businesses" SET "plan" = 'legacy' WHERE "plan" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "plans" p WHERE p."key" = "businesses"."plan");

-- ---- 3. job_runs, legal pages, support grants --------------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "job_runs" (
    "id" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6),
    "dry_run" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "counts" JSONB NOT NULL DEFAULT '{}',
    "processed" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "error_sample" TEXT,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "trigger" TEXT NOT NULL DEFAULT 'schedule',
    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "job_runs_status_check" CHECK ("status" IN ('ok', 'error', 'skipped')),
    CONSTRAINT "job_runs_trigger_check" CHECK ("trigger" IN ('schedule', 'manual', 'api'))
);

CREATE TABLE IF NOT EXISTS "legal_pages" (
    "slug" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "published_version" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "legal_pages_pkey" PRIMARY KEY ("slug", "locale"),
    CONSTRAINT "legal_pages_slug_check" CHECK ("slug" IN ('terms', 'privacy', 'sms_terms')),
    CONSTRAINT "legal_pages_locale_check" CHECK ("locale" IN ('en', 'es'))
);

CREATE TABLE IF NOT EXISTS "legal_page_versions" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "draft" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),
    "published_by" TEXT,
    CONSTRAINT "legal_page_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "legal_page_versions_body_size_check" CHECK (char_length("body") <= 200000),
    CONSTRAINT "legal_page_versions_version_check" CHECK ("version" >= 1),
    CONSTRAINT "legal_page_versions_state_check" CHECK (("draft" AND "published_at" IS NULL) OR (NOT "draft" AND "published_at" IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS "support_grants" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "ip" TEXT,
    CONSTRAINT "support_grants_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "support_grants_window_check" CHECK ("expires_at" > "started_at")
);

-- ---- 4 + 5. columns on existing tables ------------------------------------------------------------------------------------------------------------

ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "suspended_at" TIMESTAMPTZ(6);
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "suspended_by" TEXT;
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "suspended_reason" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "platform_role" TEXT;

UPDATE "users" SET "platform_role" = 'owner' WHERE "role" = 'admin' AND "platform_role" IS NULL;

-- ---- indexes (all on new or console-sized tables) --------------------------------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "setting_change_sets_at_idx" ON "setting_change_sets"("at");
CREATE INDEX IF NOT EXISTS "setting_change_sets_version_idx" ON "setting_change_sets"("version");
CREATE INDEX IF NOT EXISTS "platform_setting_revisions_change_set_id_idx" ON "platform_setting_revisions"("change_set_id");
CREATE INDEX IF NOT EXISTS "platform_setting_revisions_key_at_idx" ON "platform_setting_revisions"("key", "at");
CREATE INDEX IF NOT EXISTS "platform_setting_revisions_at_idx" ON "platform_setting_revisions"("at");
CREATE INDEX IF NOT EXISTS "tenant_setting_overrides_key_idx" ON "tenant_setting_overrides"("key");
CREATE INDEX IF NOT EXISTS "instance_heartbeats_seen_at_idx" ON "instance_heartbeats"("seen_at");
CREATE INDEX IF NOT EXISTS "job_runs_job_started_at_idx" ON "job_runs"("job", "started_at" DESC);
CREATE INDEX IF NOT EXISTS "job_runs_started_at_idx" ON "job_runs"("started_at");
CREATE UNIQUE INDEX IF NOT EXISTS "legal_page_versions_slug_locale_version_key" ON "legal_page_versions"("slug", "locale", "version");
CREATE INDEX IF NOT EXISTS "support_grants_user_id_expires_at_idx" ON "support_grants"("user_id", "expires_at");
CREATE INDEX IF NOT EXISTS "support_grants_business_id_idx" ON "support_grants"("business_id");

-- ---- constraints on existing tables: added NOT VALID, validated right after (only guarded, so a re-run is a no-op) ---------------------------------------

DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT * FROM (VALUES
      ('businesses', 'businesses_plan_fkey',
        'FOREIGN KEY ("plan") REFERENCES "plans"("key") ON DELETE RESTRICT ON UPDATE CASCADE'),
      ('platform_setting_revisions', 'platform_setting_revisions_change_set_id_fkey',
        'FOREIGN KEY ("change_set_id") REFERENCES "setting_change_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE'),
      ('tenant_setting_overrides', 'tenant_setting_overrides_business_id_fkey',
        'FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE'),
      ('legal_page_versions', 'legal_page_versions_slug_locale_fkey',
        'FOREIGN KEY ("slug", "locale") REFERENCES "legal_pages"("slug", "locale") ON DELETE CASCADE ON UPDATE CASCADE'),
      ('support_grants', 'support_grants_user_id_fkey',
        'FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE'),
      ('support_grants', 'support_grants_business_id_fkey',
        'FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE'),
      ('users', 'users_platform_role_check',
        'CHECK ("platform_role" IS NULL OR ("role" = ''admin'' AND "platform_role" IN (''owner'', ''ops'', ''support'', ''read_only'')))'),
      ('businesses', 'businesses_suspended_check',
        'CHECK (("suspended_at" IS NULL) = ("suspended_by" IS NULL) AND ("suspended_reason" IS NULL OR char_length("suspended_reason") <= 500))')
    ) AS t(tbl, name, def)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c.name AND conrelid = to_regclass('public.' || quote_ident(c.tbl))) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s NOT VALID', c.tbl, c.name, c.def);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c.name AND conrelid = to_regclass('public.' || quote_ident(c.tbl)) AND NOT convalidated) THEN
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', c.tbl, c.name);
    END IF;
  END LOOP;
END $$;

RESET lock_timeout;
