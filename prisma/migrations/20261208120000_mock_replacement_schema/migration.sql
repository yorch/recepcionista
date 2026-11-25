-- Mock replacement schema (phase 1 of the "replace the mocks with real behaviour" work). Hand written, re-runnable (IF NOT EXISTS / guarded), additive:
-- every new column has a default that reproduces the behaviour from before this migration, and no row is dropped.
--
--  1. businesses: own AI line (ElevenLabs phone-number id + Twilio phone sid), review URL, assistant name, deposit policy, scheduling config,
--     go-live content confirmation, native transfer opt-in.
--  2. bookings: crew (the overlap EXCLUSION constraint becomes per business AND crew), deposit_source/marked_by/marked_at, created_via.
--  3. briefing_audio: briefing audio kept in Postgres (<= 5 MB), cascades with its briefing.
--  4. inbound_messages: the owner's inbox of customer texts (deduped on the Twilio MessageSid).
--  5. sms_log.kind additionally allows 'owner_inbox_reply' and 'inbox_autoreply' ('manual' was already allowed).
--  6. businesses.timezone only accepts IANA-shaped names (a legacy non-IANA value is repaired to the default the app already fell back to).
-- All CHECK constraints are added NOT VALID and validated at the end, so an unexpected row fails loudly with its count.

-- 1. businesses ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE "public"."businesses"
  ADD COLUMN IF NOT EXISTS "elevenlabs_phone_number_id" TEXT,
  ADD COLUMN IF NOT EXISTS "twilio_phone_sid" TEXT,
  ADD COLUMN IF NOT EXISTS "review_url" TEXT,
  ADD COLUMN IF NOT EXISTS "assistant_name" TEXT,
  ADD COLUMN IF NOT EXISTS "deposit_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "deposit_mode" TEXT NOT NULL DEFAULT 'fixed',
  ADD COLUMN IF NOT EXISTS "deposit_fixed_cents" INTEGER,
  ADD COLUMN IF NOT EXISTS "deposit_percent" INTEGER,
  ADD COLUMN IF NOT EXISTS "deposit_min_cents" INTEGER,
  ADD COLUMN IF NOT EXISTS "deposit_max_cents" INTEGER,
  ADD COLUMN IF NOT EXISTS "slot_minutes" INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS "min_lead_minutes" INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS "horizon_days" INTEGER NOT NULL DEFAULT 14,
  ADD COLUMN IF NOT EXISTS "buffer_minutes" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "crews" SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "content_confirmed_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "content_confirmed_hash" TEXT,
  ADD COLUMN IF NOT EXISTS "native_transfer_enabled" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS "businesses_elevenlabs_phone_number_id_key" ON "public"."businesses"("elevenlabs_phone_number_id");
CREATE UNIQUE INDEX IF NOT EXISTS "businesses_twilio_phone_sid_key" ON "public"."businesses"("twilio_phone_sid");

-- A legacy zone that is not IANA-shaped (e.g. 'EST', '+01:00') already fell back to America/New_York in every read (tzOf); make that explicit.
UPDATE "public"."businesses" SET "timezone" = 'America/New_York'
 WHERE "timezone" !~ '^(UTC|[A-Za-z][A-Za-z_-]*(/[A-Za-z0-9_+-]+)+)$';

-- 2. bookings -----------------------------------------------------------------------------------------------------------------------
ALTER TABLE "public"."bookings"
  ADD COLUMN IF NOT EXISTS "crew" SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "deposit_source" TEXT,
  ADD COLUMN IF NOT EXISTS "deposit_marked_by" TEXT,
  ADD COLUMN IF NOT EXISTS "deposit_marked_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "created_via" TEXT NOT NULL DEFAULT 'ai';

-- A deposit that Stripe took is 'stripe'; a paid deposit without any Stripe reference (mock/demo) stays NULL (unknown).
UPDATE "public"."bookings" SET "deposit_source" = 'stripe'
 WHERE "deposit_source" IS NULL AND "deposit_paid" AND ("stripe_payment_intent_id" IS NOT NULL OR "stripe_checkout_session_id" IS NOT NULL);

-- The overlap guard becomes per (business, crew). Every existing row is crew 1, so single-crew data behaves exactly as before.
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

-- 3. briefing_audio -----------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "public"."briefing_audio" (
    "id" TEXT NOT NULL,
    "briefing_id" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "voice_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "briefing_audio_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "briefing_audio_briefing_id_key" ON "public"."briefing_audio"("briefing_id");
CREATE INDEX IF NOT EXISTS "briefing_audio_created_at_idx" ON "public"."briefing_audio"("created_at");

-- 4. inbound_messages ---------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "public"."inbound_messages" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "from_e164" TEXT NOT NULL,
    "from_phone" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "twilio_message_sid" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'new',
    "handled_at" TIMESTAMPTZ(6),
    "handled_by" TEXT,
    "forwarded_to_owner_at" TIMESTAMPTZ(6),
    "auto_replied_at" TIMESTAMPTZ(6),
    "booking_id" TEXT,

    CONSTRAINT "inbound_messages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "inbound_messages_twilio_message_sid_key" ON "public"."inbound_messages"("twilio_message_sid");
CREATE INDEX IF NOT EXISTS "inbound_messages_business_id_received_at_idx" ON "public"."inbound_messages"("business_id", "received_at");
CREATE INDEX IF NOT EXISTS "inbound_messages_business_id_status_received_at_idx" ON "public"."inbound_messages"("business_id", "status", "received_at");
CREATE INDEX IF NOT EXISTS "inbound_messages_business_id_from_e164_idx" ON "public"."inbound_messages"("business_id", "from_e164");
CREATE INDEX IF NOT EXISTS "inbound_messages_booking_id_idx" ON "public"."inbound_messages"("booking_id");

-- Foreign keys (guarded) --------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'briefing_audio_briefing_id_fkey' AND conrelid = 'public.briefing_audio'::regclass) THEN
    ALTER TABLE "public"."briefing_audio" ADD CONSTRAINT "briefing_audio_briefing_id_fkey" FOREIGN KEY ("briefing_id") REFERENCES "public"."briefings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inbound_messages_business_id_fkey' AND conrelid = 'public.inbound_messages'::regclass) THEN
    ALTER TABLE "public"."inbound_messages" ADD CONSTRAINT "inbound_messages_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inbound_messages_booking_id_fkey' AND conrelid = 'public.inbound_messages'::regclass) THEN
    ALTER TABLE "public"."inbound_messages" ADD CONSTRAINT "inbound_messages_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- 5. sms_log.kind: replace the closed list (guarded: only when it does not list the new kinds yet) --------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'sms_log_kind_check' AND conrelid = 'public.sms_log'::regclass AND pg_get_constraintdef(oid) LIKE '%owner_inbox_reply%'
  ) THEN
    ALTER TABLE "public"."sms_log" DROP CONSTRAINT IF EXISTS "sms_log_kind_check";
    ALTER TABLE "public"."sms_log" ADD CONSTRAINT "sms_log_kind_check"
      CHECK ("kind" IN ('confirmation', 'payment_link', 'gratitude', 'review_request', 'owner_alert', 'manual', 'owner_inbox_reply', 'inbox_autoreply', 'other')) NOT VALID;
  END IF;
END $$;

-- 6. CHECK constraints (NOT VALID, validated below) -----------------------------------------------------------------------------------
DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('businesses', 'businesses_timezone_check',        'CHECK ("timezone" ~ ''^(UTC|[A-Za-z][A-Za-z_-]*(/[A-Za-z0-9_+-]+)+)$'')'),
      ('businesses', 'businesses_el_phone_number_id_check', 'CHECK ("elevenlabs_phone_number_id" IS NULL OR char_length("elevenlabs_phone_number_id") BETWEEN 1 AND 100)'),
      ('businesses', 'businesses_twilio_phone_sid_check',   'CHECK ("twilio_phone_sid" IS NULL OR char_length("twilio_phone_sid") BETWEEN 1 AND 64)'),
      ('businesses', 'businesses_review_url_check',         'CHECK ("review_url" IS NULL OR ("review_url" ~ ''^https://[^[:space:]]+$'' AND char_length("review_url") <= 300))'),
      ('businesses', 'businesses_assistant_name_check',     'CHECK ("assistant_name" IS NULL OR (char_length(btrim("assistant_name")) >= 1 AND char_length("assistant_name") <= 40))'),
      ('businesses', 'businesses_deposit_mode_check',       'CHECK ("deposit_mode" IN (''fixed'', ''percent''))'),
      ('businesses', 'businesses_deposit_fixed_check',      'CHECK ("deposit_fixed_cents" IS NULL OR "deposit_fixed_cents" BETWEEN 100 AND 100000)'),
      ('businesses', 'businesses_deposit_percent_check',    'CHECK ("deposit_percent" IS NULL OR "deposit_percent" BETWEEN 1 AND 100)'),
      ('businesses', 'businesses_deposit_min_check',        'CHECK ("deposit_min_cents" IS NULL OR "deposit_min_cents" BETWEEN 100 AND 100000)'),
      ('businesses', 'businesses_deposit_max_check',        'CHECK ("deposit_max_cents" IS NULL OR "deposit_max_cents" BETWEEN 100 AND 100000)'),
      ('businesses', 'businesses_deposit_range_check',      'CHECK ("deposit_min_cents" IS NULL OR "deposit_max_cents" IS NULL OR "deposit_min_cents" <= "deposit_max_cents")'),
      ('businesses', 'businesses_deposit_fixed_range_check','CHECK ("deposit_fixed_cents" IS NULL OR (("deposit_min_cents" IS NULL OR "deposit_fixed_cents" >= "deposit_min_cents") AND ("deposit_max_cents" IS NULL OR "deposit_fixed_cents" <= "deposit_max_cents")))'),
      ('businesses', 'businesses_deposit_enabled_check',    'CHECK (NOT "deposit_enabled" OR ("deposit_mode" = ''fixed'' AND "deposit_fixed_cents" IS NOT NULL) OR ("deposit_mode" = ''percent'' AND "deposit_percent" IS NOT NULL))'),
      ('businesses', 'businesses_slot_minutes_check',       'CHECK ("slot_minutes" IN (15, 30, 60))'),
      ('businesses', 'businesses_min_lead_check',           'CHECK ("min_lead_minutes" BETWEEN 0 AND 10080)'),
      ('businesses', 'businesses_horizon_days_check',       'CHECK ("horizon_days" BETWEEN 1 AND 180)'),
      ('businesses', 'businesses_buffer_minutes_check',     'CHECK ("buffer_minutes" BETWEEN 0 AND 240)'),
      ('businesses', 'businesses_crews_check',              'CHECK ("crews" BETWEEN 1 AND 20)'),
      ('businesses', 'businesses_content_confirmed_check',  'CHECK (("content_confirmed_at" IS NULL) = ("content_confirmed_hash" IS NULL))'),
      ('bookings',   'bookings_crew_check',                 'CHECK ("crew" BETWEEN 1 AND 20)'),
      ('bookings',   'bookings_deposit_source_check',       'CHECK ("deposit_source" IS NULL OR "deposit_source" IN (''stripe'', ''manual''))'),
      ('bookings',   'bookings_deposit_manual_check',       'CHECK ("deposit_source" IS DISTINCT FROM ''manual'' OR "deposit_marked_at" IS NOT NULL)'),
      ('bookings',   'bookings_created_via_check',          'CHECK ("created_via" IN (''ai'', ''dashboard'', ''sms'', ''api'', ''system''))'),
      ('briefing_audio', 'briefing_audio_size_check',       'CHECK (octet_length("bytes") BETWEEN 1 AND 5242880)'),
      ('briefing_audio', 'briefing_audio_content_type_check','CHECK ("content_type" IN (''audio/mpeg'', ''audio/mp4'', ''audio/aac'', ''audio/wav'', ''audio/ogg''))'),
      ('briefing_audio', 'briefing_audio_voice_id_check',   'CHECK ("voice_id" IS NULL OR char_length("voice_id") <= 100)'),
      ('inbound_messages', 'inbound_messages_from_e164_check',  'CHECK ("from_e164" ~ ''^\+[1-9][0-9]{6,14}$'')'),
      ('inbound_messages', 'inbound_messages_from_phone_check', 'CHECK (char_length("from_phone") <= 64)'),
      ('inbound_messages', 'inbound_messages_body_check',       'CHECK (char_length("body") <= 1600)'),
      ('inbound_messages', 'inbound_messages_sid_check',        'CHECK (char_length("twilio_message_sid") BETWEEN 1 AND 64)'),
      ('inbound_messages', 'inbound_messages_status_check',     'CHECK ("status" IN (''new'', ''handled'', ''ignored''))'),
      ('inbound_messages', 'inbound_messages_handled_check',    'CHECK (("status" = ''new'' AND "handled_at" IS NULL) OR ("status" IN (''handled'', ''ignored'') AND "handled_at" IS NOT NULL))'),
      ('inbound_messages', 'inbound_messages_handled_by_check', 'CHECK ("handled_by" IS NULL OR char_length("handled_by") <= 100)')
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

-- 7. Validate every CHECK still NOT VALID (the ones above, plus the sms_log kind list), failing loudly with the offending row count --------
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
