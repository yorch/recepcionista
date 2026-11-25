/**
 * WHICH number a text is sent from, and which business an inbound text belongs to.
 *
 * Customer-facing texts (confirmations, the inbox auto-reply, owner replies, manual texts, payment links, the owner forward...) are sent through the platform's
 * Twilio MESSAGING SERVICE when TWILIO_MESSAGING_SERVICE_SID is set (`MessagingServiceSid`, no From): the service's sender pool holds the tenant numbers, all
 * registered under ONE platform A2P 10DLC campaign (docs/runbook.md section 3). Without it they go out from the TENANT's own Twilio line (which US carriers filter
 * unless that number is registered: `smsSenderProblem` warns at boot and in /api/health) and, if Twilio refuses that number as a sender, from the shared platform
 * sender (TWILIO_PHONE_NUMBER). Every text records the number that ACTUALLY sent it (sms_log.from_e164 / sender_kind).
 *
 * Inbound: a text sent TO a tenant's own number belongs to that tenant, unless another business also texted that customer from that number (a pool number shared
 * through the Messaging Service) or its sender is not known yet: then it is AMBIGUOUS. A text sent to a number that is not a tenant's own (the shared sender, a
 * number that left the pool) is matched ONLY by the exact recorded sender: the businesses that actually sent a text FROM that number TO that customer. Never by
 * "whichever business texted this customer last". More than one candidate is never guessed (`resolveInboundRoute`, sms/inbound).
 */
import { getBusiness, prisma } from '@/lib/db';
import { smsSenderProblem } from '@/lib/messaging/sender-config';
import { defaultPhoneCountry, toE164 } from '@/lib/phone';
import { isMockPoolNumber, isPlatformNumber } from '@/lib/providers/twilio';
import type { Business } from '@/lib/types';

/** The E.164 to send FROM for this business, or null (use the shared sender): a real, non-mock, non-shared number the business owns. */
export function tenantSmsSender(business: Pick<Business, 'phone' | 'phone_e164'> | null | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!business) return null;
  const e164 = business.phone_e164 ?? toE164(business.phone);
  if (!e164) return null;
  if (isMockPoolNumber(e164)) return null; // nothing exists at Twilio
  if (isPlatformNumber(e164, env)) return null; // the shared sender itself
  return e164;
}

/** How long after a text its reply is still attributed to the business that sent it (by the recorded sender). */
export const SHARED_SENDER_REPLY_DAYS = 30;
/** A Messaging Service text whose sender is still unknown (status callback not received) counts as a possible sender of a number for this long. */
export const UNRESOLVED_SENDER_DAYS = 3;


export { smsSenderProblem };

/** Statuses that count as "the text really went out". */
const DELIVERED = (statuses: string[] | undefined): string[] => statuses ?? ['sent', 'mock'];

export type InboundRoute =
  | { kind: 'tenant'; business: Business; candidates: [Business] }
  | { kind: 'recorded_sender'; business: Business; candidates: [Business] }
  | { kind: 'ambiguous'; business: null; candidates: Business[] }
  | { kind: 'none'; business: null; candidates: [] };

async function loadBusinesses(ids: string[]): Promise<Business[]> {
  const out: Business[] = [];
  for (const id of ids) {
    const b = await getBusiness(id);
    if (b) out.push(b);
  }
  return out;
}

/**
 * Which business does an inbound text (`from` a customer, sent `to` one of OUR numbers) belong to? Pure routing, no side effects.
 *  - `to` is a tenant's own number: that tenant, UNLESS another business is also a candidate: it texted this customer FROM that number (a pool number two tenants
 *    share through the Messaging Service) or sent a Messaging Service text whose sender is not known yet (within UNRESOLVED_SENDER_DAYS). Then `ambiguous`.
 *  - `to` is not a tenant's number (the shared platform sender, a number that left the pool): the businesses with a recorded text FROM that number TO this customer
 *    within SHARED_SENDER_REPLY_DAYS. None: `none`. One: that business. More than one: `ambiguous`. Never "the business that texted this customer last".
 * Only texts that really went out count (`statuses`). Callers must NOT run cancel ("C"), ratings or any other business-specific action for `ambiguous`.
 */
export async function resolveInboundRoute(
  tenant: Business | null, toRaw: string | null | undefined, fromRaw: string | null | undefined, now: Date = new Date(), statuses?: string[],
): Promise<InboundRoute> {
  const customer = toE164(fromRaw ?? '', defaultPhoneCountry());
  const dest = toE164(toRaw ?? '', defaultPhoneCountry());
  const ok = DELIVERED(statuses);
  const since = new Date(now.getTime() - SHARED_SENDER_REPLY_DAYS * 24 * 60 * 60_000);
  if (!customer || !/^\+[1-9]\d{7,14}$/.test(customer)) return tenant ? { kind: 'tenant', business: tenant, candidates: [tenant] } : { kind: 'none', business: null, candidates: [] };
  const exact = dest
    ? (await prisma.smsLog.findMany({
      where: { fromE164: dest, toE164: customer, status: { in: ok }, createdAt: { gte: since } }, select: { businessId: true }, distinct: ['businessId'], take: 20,
    })).map((r) => r.businessId)
    : [];
  if (tenant) {
    const unknown = (await prisma.smsLog.findMany({
      where: { senderKind: 'service', fromE164: null, toE164: customer, status: { in: ok }, businessId: { not: tenant.id }, createdAt: { gte: new Date(now.getTime() - UNRESOLVED_SENDER_DAYS * 24 * 60 * 60_000) } },
      select: { businessId: true }, distinct: ['businessId'], take: 20,
    })).map((r) => r.businessId);
    const others = [...new Set([...exact, ...unknown])].filter((id) => id !== tenant.id);
    if (others.length === 0) return { kind: 'tenant', business: tenant, candidates: [tenant] };
    return { kind: 'ambiguous', business: null, candidates: [tenant, ...(await loadBusinesses(others))] };
  }
  const found = await loadBusinesses([...new Set(exact)]);
  if (found.length === 0) return { kind: 'none', business: null, candidates: [] };
  if (found.length === 1) return { kind: 'recorded_sender', business: found[0], candidates: [found[0]] };
  return { kind: 'ambiguous', business: null, candidates: found };
}
