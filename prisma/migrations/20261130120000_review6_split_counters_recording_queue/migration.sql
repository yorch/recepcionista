-- Review 6 (M1): voicemail and forwarded-call seconds get their OWN counters (and caps), so anonymous voicemail / carrier-voicemail
-- traffic can never use up the plan's AI call minutes. `call_seconds` keeps meaning "AI conversation seconds" only. Usage recorded
-- before this migration (forward / voicemail seconds that were added to call_seconds) cannot be told apart and stays where it is.
-- Review 6 (M1): live-forward leases (cap on simultaneous forwards + reserved minutes).
-- Review 6 (M2): durable provider-side recording deletion queue, written in the same transaction as the call-row DELETE.

-- AlterTable
ALTER TABLE "public"."usage_counters" ADD COLUMN     "forward_seconds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "voicemail_seconds" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "public"."usage_counters" ADD CONSTRAINT "usage_counters_split_nonnegative_check" CHECK ("voicemail_seconds" >= 0 AND "forward_seconds" >= 0);

-- CreateTable
CREATE TABLE "public"."forward_leases" (
    "business_id" TEXT NOT NULL,
    "call_sid" TEXT NOT NULL,
    "reserved_seconds" INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "forward_leases_pkey" PRIMARY KEY ("business_id","call_sid")
);

-- CreateIndex
CREATE INDEX "forward_leases_expires_at_idx" ON "public"."forward_leases"("expires_at");

ALTER TABLE "public"."forward_leases" ADD CONSTRAINT "forward_leases_reserved_check" CHECK ("reserved_seconds" > 0);

-- CreateTable
CREATE TABLE "public"."pending_recording_deletions" (
    "id" TEXT NOT NULL,
    "account_sid" TEXT NOT NULL,
    "recording_sid" TEXT NOT NULL,
    "business_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "alerted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_recording_deletions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pending_recording_deletions_next_attempt_at_idx" ON "public"."pending_recording_deletions"("next_attempt_at");

-- CreateIndex
CREATE INDEX "pending_recording_deletions_business_id_idx" ON "public"."pending_recording_deletions"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX "pending_recording_deletions_account_sid_recording_sid_key" ON "public"."pending_recording_deletions"("account_sid", "recording_sid");

-- Shape checks (not expressible in Prisma, invisible to its drift check): Twilio SIDs only, bounded error text.
ALTER TABLE "public"."pending_recording_deletions" ADD CONSTRAINT "pending_recording_deletions_sid_check" CHECK ("account_sid" ~ '^AC[0-9a-fA-F]{32}$' AND "recording_sid" ~ '^RE[0-9a-fA-F]{32}$' AND "attempts" >= 0);
