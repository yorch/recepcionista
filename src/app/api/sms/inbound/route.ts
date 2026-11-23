import { getBusinessByPhone, prisma } from '@/lib/db';
import { phoneKey } from '@/lib/format';
import { routeGratitudeReply } from '@/lib/gratitude/reply';
import { applyInboundKeyword } from '@/lib/messaging/inbound';
import { normalizeInbound, twiml } from '@/lib/messaging/keywords';
import { verifyTwilioSignature } from '@/lib/providers/twilio';
import { logger } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = logger('sms/inbound');

const xml = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/xml; charset=utf-8' } });

/**
 * THE inbound-SMS webhook: point the Twilio number's "A message comes in" URL here (and only here; a number has
 * one inbound URL). STOP-class keywords opt the sender out of this business's texts, START-class keywords opt
 * back in, HELP returns contact info, and a 1-5 reply to a gratitude text is routed to the review/owner logic.
 * Signature verified, fails closed. The business is resolved from the Twilio number the text was sent TO.
 */
export async function POST(req: Request) {
  try {
    const fields: Record<string, string> = {};
    (await req.formData().catch(() => new FormData())).forEach((v, k) => {
      if (typeof v === 'string') fields[k] = v;
    });
    const verdict = verifyTwilioSignature(req, fields);
    if (!verdict.ok) {
      log.warn('signature.rejected', { error: verdict.error });
      return xml(twiml(), 403);
    }

    const from = fields.From ?? '';
    const to = fields.To ?? '';
    const business = to ? await getBusinessByPhone(to) : null;
    if (!business || !from) {
      log.warn('unrouted', { to: to || null, matched: Boolean(business) });
      return xml(twiml());
    }

    const reply = await applyInboundKeyword(business, from, fields.Body);
    if (reply) return xml(reply);

    // A bare 1-5 answers the most recent gratitude text we sent to this number.
    const rating = /^[1-5]$/.test(normalizeInbound(fields.Body)) ? Number(normalizeInbound(fields.Body)) : null;
    if (rating) {
      const key = phoneKey(from);
      const recent = await prisma.smsLog.findMany({
        where: { businessId: business.id, kind: 'gratitude', bookingId: { not: null }, status: { in: ['sent', 'mock'] } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
      const hit = recent.find((r) => phoneKey(r.toPhone) === key);
      if (hit?.bookingId) {
        await routeGratitudeReply(hit.bookingId, rating);
        return xml(twiml());
      }
    }

    return xml(twiml()); // not a keyword: no auto-reply
  } catch (err) {
    log.error('failed', { err });
    return xml(twiml(), 500);
  }
}
