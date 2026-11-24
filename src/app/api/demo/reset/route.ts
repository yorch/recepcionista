/**
 * Restores the seeded demo state and clears generated audio. Runs the seed
 * in-process against Postgres (no subprocess), so a reset is one transaction
 * batch rather than a child Bun process racing the dev server's connection.
 */
import { guardAdmin } from '@/lib/admin-guard';
import { removeAllBriefingAudio } from '@/lib/briefing/audio-files';
import { ok, fail } from '@/lib/http';
import { demoModeEnabled } from '@/lib/auth';
import { clearAll, prisma, recordAudit } from '@/lib/db';
import { logger } from '@/lib/log';
import {
  DEMO_BUSINESS_ID, demoBookings, demoBriefing, demoBusiness, demoCalls,
  demoMessages, DEMO_FAQS, DEMO_PRICING_NOTES, DEMO_SERVICES, SYSTEM_PROMPT, CALL_SCRIPT,
} from '@/lib/demo/seed-data';

export const dynamic = 'force-dynamic';

const log = logger('api/demo/reset');

export async function POST(req: Request) {
  const denied = await guardAdmin(req);
  if (denied) return denied;
  if (!demoModeEnabled()) return fail('not found', 404);
  const started = Date.now();
  try {
    log.warn('requested', { effect: 'wipes every table, reseeds demo data' });
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

    await recordAudit({ actor_kind: 'admin_token', business_id: DEMO_BUSINESS_ID, action: 'demo.reset', target: 'demo', meta: {} }); // the wipe emptied the audit trail: leave one row saying why
    removeAllBriefingAudio();
    log.info('done', { ms: Date.now() - started });
    return ok({ reset: true });
  } catch (err) {
    log.error('failed', { ms: Date.now() - started, err });
    return fail(err, 500);
  }
}
