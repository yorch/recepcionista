-- Owner voice replies: the owner phones the business line and asks the assistant to text a customer back. The reply is recorded here and
-- sent only when the owner confirms by SMS (YES <code>) from the verified phone. Hand-written and re-runnable (IF NOT EXISTS / guarded DO blocks).

-- CreateTable
CREATE TABLE IF NOT EXISTS "public"."owner_replies" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "call_id" TEXT,
    "lead_kind" TEXT NOT NULL,
    "lead_call_id" TEXT,
    "lead_booking_id" TEXT,
    "to_e164" TEXT NOT NULL,
    "to_name" TEXT,
    "body" TEXT NOT NULL,
    "segments" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "refuse_reason" TEXT,
    "owner_trust" TEXT NOT NULL DEFAULT 'unverified',
    "sms_log_id" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "decided_at" TIMESTAMPTZ(6),
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "owner_replies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "owner_replies_business_id_created_at_idx" ON "public"."owner_replies"("business_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "owner_replies_business_id_to_e164_created_at_idx" ON "public"."owner_replies"("business_id", "to_e164", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "owner_replies_call_id_idx" ON "public"."owner_replies"("call_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "owner_replies_lead_call_id_idx" ON "public"."owner_replies"("lead_call_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "owner_replies_lead_booking_id_idx" ON "public"."owner_replies"("lead_booking_id");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'owner_replies_business_id_fkey' AND conrelid = 'public.owner_replies'::regclass) THEN
    ALTER TABLE "public"."owner_replies" ADD CONSTRAINT "owner_replies_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'owner_replies_call_id_fkey' AND conrelid = 'public.owner_replies'::regclass) THEN
    ALTER TABLE "public"."owner_replies" ADD CONSTRAINT "owner_replies_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'owner_replies_lead_call_id_fkey' AND conrelid = 'public.owner_replies'::regclass) THEN
    ALTER TABLE "public"."owner_replies" ADD CONSTRAINT "owner_replies_lead_call_id_fkey" FOREIGN KEY ("lead_call_id") REFERENCES "public"."calls"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'owner_replies_lead_booking_id_fkey' AND conrelid = 'public.owner_replies'::regclass) THEN
    ALTER TABLE "public"."owner_replies" ADD CONSTRAINT "owner_replies_lead_booking_id_fkey" FOREIGN KEY ("lead_booking_id") REFERENCES "public"."bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- CHECK constraints
DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('owner_replies_lead_kind_check',   'CHECK ("lead_kind" IN (''call'', ''booking''))'),
      ('owner_replies_status_check',      'CHECK ("status" IN (''proposed'', ''sending'', ''sent'', ''cancelled'', ''expired'', ''refused'', ''failed''))'),
      ('owner_replies_trust_check',       'CHECK ("owner_trust" IN (''verified'', ''unverified''))'),
      ('owner_replies_body_check',        'CHECK (char_length("body") BETWEEN 1 AND 320)'),
      ('owner_replies_segments_check',    'CHECK ("segments" BETWEEN 1 AND 10)'),
      ('owner_replies_e164_check',        'CHECK ("to_e164" ~ ''^\+[1-9][0-9]{6,14}$'')'),
      ('owner_replies_expiry_check',      'CHECK ("expires_at" > "created_at")'),
      ('owner_replies_sent_check',        'CHECK ("status" <> ''sent'' OR "sent_at" IS NOT NULL)'),
      ('owner_replies_decided_check',     'CHECK ("status" NOT IN (''sending'', ''sent'', ''cancelled'', ''refused'', ''failed'') OR "decided_at" IS NOT NULL)')
    ) AS t(cname, def)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c.cname AND conrelid = 'public.owner_replies'::regclass) THEN
      EXECUTE format('ALTER TABLE "public"."owner_replies" ADD CONSTRAINT %I %s NOT VALID', c.cname, c.def);
    END IF;
  END LOOP;
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'public.owner_replies'::regclass AND contype = 'c' AND NOT convalidated
  LOOP
    EXECUTE format('ALTER TABLE "public"."owner_replies" VALIDATE CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
