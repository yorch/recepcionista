-- One ElevenLabs agent per business. A shared agent maps every tool call to a
-- single tenant (cross-tenant bookings), so keep only the oldest claimant of a
-- duplicated agent id; the others are re-provisioned with their own agent.
UPDATE "public"."businesses" b
SET "agent_id" = NULL
WHERE "agent_id" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "public"."businesses" o
    WHERE o."agent_id" = b."agent_id"
      AND (o."created_at", o."id") < (b."created_at", b."id")
  );

-- Partial unique index (hand-written: Prisma cannot express the WHERE clause).
CREATE UNIQUE INDEX "businesses_agent_id_unique" ON "public"."businesses" ("agent_id") WHERE "agent_id" IS NOT NULL;
