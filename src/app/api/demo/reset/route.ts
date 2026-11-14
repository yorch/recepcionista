/**
 * Restores the seeded demo state and clears generated audio. Runs the seed
 * in-process against Postgres (no subprocess), so a reset is one transaction
 * batch rather than a child Bun process racing the dev server's connection.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok, fail } from '@/lib/http';
import { clearAll, prisma } from '@/lib/db';
import {
  DEMO_BUSINESS_ID, demoBookings, demoBriefing, demoBusiness, demoCalls,
  demoMessages, DEMO_FAQS, DEMO_PRICING_NOTES, DEMO_SERVICES, SYSTEM_PROMPT, CALL_SCRIPT,
} from '@/lib/demo/seed-data';

export const dynamic = 'force-dynamic';

export async function POST() {
  try {
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

    const audioDir = path.join(process.cwd(), 'public/audio');
    if (fs.existsSync(audioDir)) {
      for (const f of fs.readdirSync(audioDir)) {
        if (/^briefing-/.test(f)) fs.unlinkSync(path.join(audioDir, f));
      }
    }
    return ok({ reset: true });
  } catch (err) {
    return fail(err, 500);
  }
}
