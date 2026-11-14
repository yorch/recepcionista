-- CreateTable
CREATE TABLE "public"."businesses" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT,
    "phone" TEXT,
    "owner_phone" TEXT,
    "owner_name" TEXT,
    "hours" JSONB NOT NULL DEFAULT '{}',
    "service_area" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'onboarding',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "businesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."knowledge_bases" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "services" JSONB NOT NULL DEFAULT '[]',
    "faqs" JSONB NOT NULL DEFAULT '[]',
    "pricing_notes" TEXT NOT NULL DEFAULT '',
    "system_prompt" TEXT NOT NULL DEFAULT '',
    "call_script" TEXT NOT NULL DEFAULT '',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_bases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."calls" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "call_sid" TEXT,
    "caller_phone" TEXT,
    "caller_name" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "duration_sec" INTEGER,
    "language" TEXT,
    "transcript" TEXT,
    "summary" TEXT,
    "urgency" TEXT NOT NULL DEFAULT 'unsure',
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "recording_url" TEXT,
    "flagged_reason" TEXT,

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."bookings" (
    "id" TEXT NOT NULL,
    "call_id" TEXT,
    "business_id" TEXT NOT NULL,
    "customer_name" TEXT NOT NULL,
    "customer_phone" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "scheduled_at" TIMESTAMP(3) NOT NULL,
    "address" TEXT,
    "price_estimate" INTEGER,
    "deposit_amount" INTEGER,
    "deposit_paid" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'confirmed',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."briefings" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "audio_url" TEXT,
    "transcript" TEXT NOT NULL,
    "stats" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "briefings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."sms_log" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "to_phone" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "booking_id" TEXT,
    "provider_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sms_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "businesses_phone_key" ON "public"."businesses"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_bases_business_id_key" ON "public"."knowledge_bases"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX "calls_call_sid_key" ON "public"."calls"("call_sid");

-- CreateIndex
CREATE INDEX "calls_business_id_started_at_idx" ON "public"."calls"("business_id", "started_at");

-- CreateIndex
CREATE INDEX "bookings_business_id_scheduled_at_idx" ON "public"."bookings"("business_id", "scheduled_at");

-- CreateIndex
CREATE UNIQUE INDEX "briefings_business_id_date_key" ON "public"."briefings"("business_id", "date");

-- CreateIndex
CREATE INDEX "sms_log_business_id_created_at_idx" ON "public"."sms_log"("business_id", "created_at");

-- AddForeignKey
ALTER TABLE "public"."knowledge_bases" ADD CONSTRAINT "knowledge_bases_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."calls" ADD CONSTRAINT "calls_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."bookings" ADD CONSTRAINT "bookings_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."bookings" ADD CONSTRAINT "bookings_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."briefings" ADD CONSTRAINT "briefings_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."sms_log" ADD CONSTRAINT "sms_log_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
