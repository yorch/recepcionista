/**
 * Reset + load the demo dataset. Run: bun scripts/seed.ts
 * Idempotent: clears every table first, so it is safe mid-demo.
 *
 * Seeding replaces the stored knowledge base with the hand-written SYSTEM_PROMPT
 * and nulls business.agent_id, which would leave the live ElevenLabs agent speaking
 * a prompt that names only 3 of the 7 tools. So after loading we run the same
 * provision step the onboarding UI does: regenerate the prompt from the seeded
 * services/faqs (they are preserved) and re-register the agent. Pass --no-provision
 * to skip that if you want the raw seed state.
 */
import { clearAll, disconnect, prisma } from '../src/lib/db';
import {
  DEMO_BUSINESS_ID, demoBookings, demoBriefing, demoBusiness, demoCalls,
  demoMessages, DEMO_FAQS, DEMO_PRICING_NOTES, DEMO_SERVICES, SYSTEM_PROMPT, CALL_SCRIPT,
} from '../src/lib/demo/seed-data';
import { assertSafeDatabase } from './_safe-db';

assertSafeDatabase('seed');

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

  if (!process.argv.includes('--no-provision')) {
    await provisionDemoAgent();
  } else {
    console.log('  --no-provision: agent not re-registered (prompt names only 3 of 7 tools)');
  }
  await disconnect();
}

/**
 * Bring the seeded business back to a live, correctly-prompted state by calling
 * the app's own provision endpoint when one is running, and falling back to the
 * library functions directly otherwise. Never fails the seed: an unreachable
 * ElevenLabs must not leave the demo with no data.
 */
async function provisionDemoAgent() {
  const base = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/api/businesses/${DEMO_BUSINESS_ID}/provision`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.ADMIN_TOKEN ? { authorization: `Bearer ${process.env.ADMIN_TOKEN}` } : {}),
      },
      body: '{}',
      signal: AbortSignal.timeout(60_000),
    });
    const json = await res.json().catch(() => null);
    if (res.ok && json?.ok) {
      const d = json.data;
      console.log(`  provisioned via API: agent=${d.business.agent_id ?? 'none'} phone=${d.phone} prompt=${d.knowledge_base.system_prompt.length} chars`);
      return;
    }
    console.warn(`  provision endpoint returned ${res.status}; provisioning in-process instead`);
  } catch {
    // No dev server running — do it locally against the same libs.
  }

  try {
    const { getBusiness, getKnowledgeBase, updateBusiness, upsertKnowledgeBase } = await import('../src/lib/db');
    const { generateKnowledgeBase } = await import('../src/lib/kb');
    const { createOrUpdateAgent } = await import('../src/lib/voice/elevenlabs');

    const business = await getBusiness(DEMO_BUSINESS_ID);
    if (!business) return;
    const kb = await getKnowledgeBase(DEMO_BUSINESS_ID);
    if (!kb) return;

    const regenerated = await upsertKnowledgeBase(DEMO_BUSINESS_ID, generateKnowledgeBase(
      {
        name: business.name,
        services: kb.services,
        hours: business.hours ?? {},
        service_area: business.service_area ?? [],
        faqs: kb.faqs,
        pricing_notes: kb.pricing_notes,
        confidence: 'high',
        source: 'scrape',
      },
      business,
    ));

    const agent = await createOrUpdateAgent({ business, kb: regenerated });
    if (!agent.mock && agent.agent_id) await updateBusiness(DEMO_BUSINESS_ID, { agent_id: agent.agent_id });
    console.log(`  provisioned in-process: agent=${agent.agent_id} mock=${agent.mock} prompt=${regenerated.system_prompt.length} chars`);
  } catch (err) {
    console.warn('  agent re-registration skipped:', (err as Error).message);
  }
}

main().catch(async (err) => {
  console.error(err);
  await disconnect();
  process.exit(1);
});
