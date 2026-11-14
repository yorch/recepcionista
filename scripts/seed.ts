/**
 * Reset + load the demo dataset. Run: bun scripts/seed.ts
 * Idempotent: clears every table first, so it is safe mid-demo.
 */
import { clearAll, disconnect, prisma } from '../src/lib/db';
import {
  DEMO_BUSINESS_ID, demoBookings, demoBriefing, demoBusiness, demoCalls,
  demoMessages, DEMO_FAQS, DEMO_PRICING_NOTES, DEMO_SERVICES, SYSTEM_PROMPT, CALL_SCRIPT,
} from '../src/lib/demo/seed-data';

async function main() {
  await clearAll();

  await prisma.business.create({ data: demoBusiness() });

  await prisma.knowledgeBase.create({
    data: {
      businessId: DEMO_BUSINESS_ID,
      services: DEMO_SERVICES,
      faqs: DEMO_FAQS,
      pricingNotes: DEMO_PRICING_NOTES,
      systemPrompt: SYSTEM_PROMPT,
      callScript: CALL_SCRIPT,
    },
  });

  await prisma.call.createMany({ data: demoCalls() });
  await prisma.booking.createMany({ data: demoBookings() });
  await prisma.briefing.create({ data: demoBriefing() });
  await prisma.smsLog.createMany({ data: demoMessages() });

  const counts = {
    businesses: await prisma.business.count(),
    knowledge_bases: await prisma.knowledgeBase.count(),
    calls: await prisma.call.count(),
    bookings: await prisma.booking.count(),
    briefings: await prisma.briefing.count(),
    sms_log: await prisma.smsLog.count(),
  };

  console.log(`Seeded Postgres: ${JSON.stringify(counts)}`);
  console.log(`  business: Miami Cool Air Conditioning (${DEMO_BUSINESS_ID})`);
  await disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await disconnect();
  process.exit(1);
});
