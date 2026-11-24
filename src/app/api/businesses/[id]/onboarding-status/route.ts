import { ok, fail } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { billingEnforced, isProvisioningAllowed, getBusiness, getKnowledgeBase, listAuditEvents, prisma } from '@/lib/db';
import type { BillingStatus } from '@/lib/types';
import { isMockPoolNumber } from '@/lib/providers/twilio';
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
      prisma.call.findFirst({ where: { businessId: id, kind: 'customer' }, orderBy: { startedAt: 'asc' }, select: { startedAt: true } }),
      prisma.call.findFirst({
        where: { businessId: id, kind: 'customer' }, orderBy: { startedAt: 'desc' },
        select: { startedAt: true, language: true, durationSec: true, status: true },
      }),
      prisma.booking.findFirst({ where: { businessId: id }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      listAuditEvents({ business_id: id, action: 'knowledge.extracted', limit: 1 }),
    ]);
    // Partial provisioning state: only meaningful while the business is not live.
    const provisionEvents = business.status === 'live' ? [] : await listAuditEvents({ business_id: id, limit: 20 }).then(
      (rows) => rows.filter((e) => e.action.startsWith('provision.')),
    );
    const latestProvision = provisionEvents[0];
    const failedLast = latestProvision && (latestProvision.action === 'provision.partial' || latestProvision.action === 'provision.number_failed'
      || latestProvision.action === 'provision.number_record_failed');
    const provisionMeta = (latestProvision?.meta ?? {}) as { stage?: unknown; error?: unknown };
    const lastErr = failedLast
      ? { stage: typeof provisionMeta.stage === 'string' ? provisionMeta.stage : 'number', error: typeof provisionMeta.error === 'string' ? provisionMeta.error : null, at: latestProvision.at }
      : null;

    const billingStatus = (business.billing_status ?? 'none') as BillingStatus;
    const enforced = billingEnforced();
    const provisioning_allowed = auth.principal.kind === 'admin' || isProvisioningAllowed(business);
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
      vertical: business.vertical ?? 'hvac',
      locale: business.locale_default === 'es' ? 'es' : 'en',
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
      phone_mock: Boolean(business.phone && isMockPoolNumber(business.phone)),
      status: business.status,
      provision_partial: business.phone && business.status !== 'live' && !provisioned
        ? { phone: business.phone, stage: lastErr?.stage ?? 'agent', error: lastErr?.error ?? null, at: lastErr?.at ?? business.created_at }
        : null,
      provision_last_error: lastErr,
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
