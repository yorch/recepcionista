-- Pause / forward switch (per-business call handling mode).
--   call_mode                  'ai' (default) | 'paused' | 'forward'
--   forward_number / _e164     the human number 'forward' dials (E.164 form maintained by the db layer)
--   forward_number_verified_at set by the SMS-code flow (cleared when the number changes); the number is only dialled when set,
--                              or when it equals the verified owner phone
--   forward_during_hours       forward only inside business hours; the AI answers outside them
-- Zero data change for existing rows (defaults keep every business on 'ai').

-- AlterTable
ALTER TABLE "public"."businesses"
  ADD COLUMN "call_mode" TEXT NOT NULL DEFAULT 'ai',
  ADD COLUMN "forward_number" TEXT,
  ADD COLUMN "forward_number_e164" TEXT,
  ADD COLUMN "forward_number_verified_at" TIMESTAMPTZ(6),
  ADD COLUMN "forward_during_hours" BOOLEAN NOT NULL DEFAULT false;

-- Not modelled by Prisma (no drift): the mode is one of three values; a forward number is always E.164 when present;
-- a verified number must have a number.
ALTER TABLE "public"."businesses"
  ADD CONSTRAINT "businesses_call_mode_check" CHECK ("call_mode" IN ('ai', 'paused', 'forward')),
  ADD CONSTRAINT "businesses_forward_number_e164_check" CHECK ("forward_number_e164" IS NULL OR "forward_number_e164" ~ '^\+[1-9][0-9]{6,14}$'),
  ADD CONSTRAINT "businesses_forward_verified_check" CHECK ("forward_number_verified_at" IS NULL OR "forward_number_e164" IS NOT NULL);

-- ============================================================================
-- Remaining free-form enum columns (changelog "L1 Free-form enums") and the sms_log -> bookings link (changelog "L3")
-- ============================================================================
-- The application only ever writes the values below (src/lib/types.ts), so a legacy row outside them can only come from
-- hand-edited SQL. Such rows are first normalised to the safe neutral value, then the CHECKs are added VALIDATED (like every
-- other CHECK in this repo: tests/db/migration.test.ts asserts there is no NOT VALID constraint left).
UPDATE "public"."businesses" SET "status" = 'onboarding' WHERE "status" NOT IN ('onboarding', 'live', 'paused');
UPDATE "public"."calls" SET "status" = 'completed' WHERE "status" NOT IN ('in_progress', 'completed', 'handed_off', 'failed');
UPDATE "public"."calls" SET "urgency" = 'unsure' WHERE "urgency" NOT IN ('emergency', 'routine', 'unsure');
UPDATE "public"."bookings" SET "status" = 'confirmed' WHERE "status" NOT IN ('pending', 'confirmed', 'completed', 'cancelled');
UPDATE "public"."sms_log" SET "kind" = 'other' WHERE "kind" NOT IN ('confirmation', 'payment_link', 'gratitude', 'review_request', 'owner_alert', 'manual', 'other');
UPDATE "public"."sms_log" SET "status" = 'failed'
  WHERE "status" NOT IN ('queued', 'sent', 'failed', 'mock', 'blocked_opt_out', 'blocked_quiet_hours', 'blocked_no_consent', 'blocked_cap', 'blocked_owner_unverified');

ALTER TABLE "public"."businesses" ADD CONSTRAINT "businesses_status_check" CHECK ("status" IN ('onboarding', 'live', 'paused'));
ALTER TABLE "public"."calls" ADD CONSTRAINT "calls_status_check" CHECK ("status" IN ('in_progress', 'completed', 'handed_off', 'failed'));
ALTER TABLE "public"."calls" ADD CONSTRAINT "calls_urgency_check" CHECK ("urgency" IN ('emergency', 'routine', 'unsure'));
ALTER TABLE "public"."bookings" ADD CONSTRAINT "bookings_status_check" CHECK ("status" IN ('pending', 'confirmed', 'completed', 'cancelled'));
ALTER TABLE "public"."sms_log" ADD CONSTRAINT "sms_log_kind_check" CHECK ("kind" IN ('confirmation', 'payment_link', 'gratitude', 'review_request', 'owner_alert', 'manual', 'other'));
ALTER TABLE "public"."sms_log" ADD CONSTRAINT "sms_log_status_check" CHECK ("status" IN ('queued', 'sent', 'failed', 'mock', 'blocked_opt_out', 'blocked_quiet_hours', 'blocked_no_consent', 'blocked_cap', 'blocked_owner_unverified'));

-- sms_log.booking_id referenced bookings with no foreign key. Clear dangling ids first (a booking that no longer exists), then link.
UPDATE "public"."sms_log" SET "booking_id" = NULL
  WHERE "booking_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "public"."bookings" b WHERE b."id" = "sms_log"."booking_id");

-- CreateIndex
CREATE INDEX "sms_log_booking_id_idx" ON "public"."sms_log"("booking_id");

-- AddForeignKey
ALTER TABLE "public"."sms_log" ADD CONSTRAINT "sms_log_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
