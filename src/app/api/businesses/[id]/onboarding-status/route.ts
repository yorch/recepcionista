import { ok, fail } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { billingEnforced, billingStateAllows, getBusiness, getKnowledgeBase, listAuditEvents, prisma } from '@/lib/db';
import type { BillingStatus } from '@/lib/types';
import { nextStep, type OnboardingStatus } from './status';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<ReturnType<typeof ok<OnboardingStatus>> | ReturnType<typeof fail>> {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response as ReturnType<typeof fail>;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const business = await getBusiness(id);
    if (!business) return fail('business not found', 404);

    const [kb, firstCall, latestCall, firstBooking, extracted] = await Promise.all([
      getKnowledgeBase(id),
      prisma.call.findFirst({ where: { businessId: id }, orderBy: { startedAt: 'asc' }, select: { startedAt: true } }),
      prisma.call.findFirst({
        where: { businessId: id }, orderBy: { startedAt: 'desc' },
        select: { startedAt: true, language: true, durationSec: true, status: true },
      }),
      prisma.booking.findFirst({ where: { businessId: id }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      listAuditEvents({ business_id: id, action: 'knowledge.extracted', limit: 1 }),
    ]);

    const billingStatus = (business.billing_status ?? 'none') as BillingStatus;
    const enforced = billingEnforced();
    const provisioning_allowed = auth.principal.kind === 'admin' || !enforced || billingStateAllows(business);
    const provisioned = Boolean(business.phone) && business.status === 'live';
    const facts = {
      has_knowledge: Boolean(kb && kb.services.length > 0),
      owner_phone_verified: Boolean(business.owner_phone_verified_at),
      provisioning_allowed,
      provisioned,
      first_call_at: firstCall?.startedAt.toISOString() ?? null,
    };
    const meta = (extracted[0]?.meta ?? {}) as { url?: unknown };

    return ok<OnboardingStatus>({
      business_id: business.id,
      name: business.name,
      url: business.url ?? null,
      owner_name: business.owner_name ?? null,
      owner_phone: business.owner_phone ?? null,
      owner_phone_verified: facts.owner_phone_verified,
      owner_phone_verified_at: business.owner_phone_verified_at ?? null,
      has_knowledge: facts.has_knowledge,
      knowledge: kb ? { services: kb.services.length, faqs: kb.faqs.length, updated_at: kb.updated_at } : null,
      last_extracted: extracted[0]
        ? { url: typeof meta.url === 'string' ? meta.url : null, at: extracted[0].at }
        : null,
      billing_status: billingStatus,
      billing_enforced: enforced,
      provisioning_allowed,
      trial_ends_at: business.trial_ends_at ?? null,
      provisioned,
      phone: business.phone ?? null,
      phone_mock: Boolean(business.phone && business.phone.includes('555')),
      status: business.status,
      first_call_at: facts.first_call_at,
      latest_call: latestCall
        ? {
            started_at: latestCall.startedAt.toISOString(),
            language: latestCall.language ?? null,
            duration_sec: latestCall.durationSec ?? null,
            status: latestCall.status,
          }
        : null,
      first_booking_at: firstBooking?.createdAt.toISOString() ?? null,
      current_step: nextStep(facts),
    });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
