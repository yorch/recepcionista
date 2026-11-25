/**
 * WHICH number a text is sent from, and which business an inbound text belongs to.
 *
 * Customer-facing texts (confirmations, the inbox auto-reply, owner replies, manual texts, payment links, the owner forward...) go out from the
 * TENANT's own Twilio line, the number the customer called and the one Twilio routes back to /api/sms/inbound for THIS business. That is what
 * makes "Reply STOP", "Reply C" and a customer's answer to the owner's dashboard reply work in a multi-tenant deployment.
 *
 * The shared platform sender (TWILIO_PHONE_NUMBER) is only the fallback: a tenant with no real number (mock-pool demo number, none yet), a number
 * Twilio refuses as a sender (sendSms retries from the shared sender), or the single-tenant install whose business line IS the shared number.
 * A text from the shared sender cannot be routed by its `To`, so the inbound webhook finds the business by the LAST OUTBOUND text sent to that
 * customer (`resolveInboundBusinesses`).
 */
import { getBusiness, prisma } from '@/lib/db';
import { toE164 } from '@/lib/phone';
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

/** How long after a text from the shared sender its reply is still attributed to the business that sent it. */
export const SHARED_SENDER_REPLY_DAYS = 30;

/**
 * The businesses that texted `from` (a customer's E.164) from the shared sender, most recent first. Used only when an inbound text was sent TO the
 * shared platform number (no business owns it). Only delivered texts count, and only the window above. [] when nobody did.
 */
export async function resolveInboundBusinesses(fromE164: string | null | undefined, now: Date = new Date(), statuses: string[] = ['sent', 'mock']): Promise<Business[]> {
  if (!fromE164 || !/^\+[1-9]\d{7,14}$/.test(fromE164)) return [];
  const since = new Date(now.getTime() - SHARED_SENDER_REPLY_DAYS * 24 * 60 * 60_000);
  const rows = await prisma.smsLog.findMany({
    where: { toE164: fromE164, status: { in: statuses }, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' }, select: { businessId: true }, take: 50,
  });
  const ids = [...new Set(rows.map((r) => r.businessId))];
  const out: Business[] = [];
  for (const id of ids) {
    const b = await getBusiness(id);
    if (b) out.push(b);
  }
  return out;
}
