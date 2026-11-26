-- Review 23 A3: the index of the sender lookup, built CONCURRENTLY (no lock that blocks sms_log writes) in a migration file of its own. A file with exactly one
-- statement is not wrapped in a transaction block, which CREATE INDEX CONCURRENTLY requires (do not add a second statement here). If the build is interrupted it
-- leaves an INVALID index: mark the migration rolled back (`prisma migrate resolve --rolled-back 20261210120100_sms_log_from_index`) and deploy again; the
-- previous migration drops the invalid leftover first (docs/runbook.md section 4).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "sms_log_from_e164_to_e164_created_at_idx" ON "public"."sms_log"("from_e164", "to_e164", "created_at");
