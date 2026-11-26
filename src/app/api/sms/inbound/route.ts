import { countryForBusiness, getBusinessByPhone, prisma } from '@/lib/db';
import { sameNumber, toE164 } from '@/lib/phone';
import { routeGratitudeReply } from '@/lib/gratitude/reply';
import { applyInboundKeyword } from '@/lib/messaging/inbound';
import { normalizeInbound, twiml } from '@/lib/messaging/keywords';
import { mockSmsAllowed } from '@/lib/messaging/delivery';
import { verifyTwilioSignature } from '@/lib/providers/twilio';
import { resolveInboundRoute } from '@/lib/messaging/sender';
import { handleAmbiguousInbound } from '@/lib/messaging/inbound-ambiguous';
import { handleOwnerSms } from '@/lib/voice/owner/sms';
import { handleCancelReply } from '@/lib/messaging/sms-cancel';
import { handleInboundText } from '@/lib/messaging/inbox';
import { meterSms } from '@/lib/messaging';
import { smsSegments } from '@/lib/messaging/policy';
import { logger } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = logger('sms/inbound');

const xml = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/xml; charset=utf-8' } });

/**
 * THE inbound-SMS webhook: point the Twilio number's "A message comes in" URL here (and only here; a number has
 * one inbound URL). STOP-class keywords opt the sender out of this business's texts, START-class keywords opt
 * back in, HELP returns contact info, a bare C cancels the sender's single upcoming booking, and a 1-5 reply to a gratitude text is routed to the review/owner logic.
 * Any other text is stored in the owner's inbox, forwarded to the verified owner phone and acknowledged once (messaging/inbox).
 * Signature verified, fails closed. The business is resolved from the Twilio number the text was sent TO (its own line); a text sent to a number that is not a
 * tenant's own is routed ONLY by the recorded sender (messaging/sender resolveInboundRoute); an ambiguous one runs nothing business-specific (inbound-ambiguous).
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
    const tenant = to ? await getBusinessByPhone(to) : null;
    // WHO is this text for? A tenant's own number: that tenant. Any other number (the shared platform sender, a number that left the pool): ONLY the businesses that
    // actually sent a text FROM it TO this customer (sms_log.from_e164). Never "whichever business texted last". More than one candidate is never guessed:
    // no cancel, no rating, no inbox row; STOP is honoured for all of them, anything else gets a neutral acknowledgement and the owners are flagged.
    const route = await resolveInboundRoute(tenant, to, from, new Date(), mockSmsAllowed() ? ['sent', 'mock'] : ['sent']);
    if (route.kind === 'ambiguous' && from) {
      return xml(await handleAmbiguousInbound(route.candidates, from, fields.Body));
    }
    const business = route.business;
    if (!business || !from) {
      log.warn('unrouted', { to: to || null, matched: Boolean(business) });
      return xml(twiml());
    }
    if (route.kind === 'recorded_sender') log.info('routed_by_recorded_sender', { business: business.id });

    const reply = await applyInboundKeyword(business, from, fields.Body);
    if (reply) {
      return xml(reply);
    }

    // Owner call-in confirmations ("YES <code>" / "NO <code>" / "UNDO <code>"): only from the verified owner phone, after STOP-class keywords.
    const ownerReply = await handleOwnerSms(business, from, fields.Body);
    if (ownerReply) {
      await meterSms(business.id, smsSegments(ownerReply));
      return xml(twiml(ownerReply));
    }

    // "Reply C to cancel" (the booking confirmation's footer): a bare C from the booking's own number cancels its next upcoming booking.
    // CANCEL / STOP / END ... are opt-out keywords and were handled above.
    const cancelReply = await handleCancelReply(business, from, fields.Body, { messageSid: fields.MessageSid });
    if (cancelReply !== null) return xml(cancelReply);

    // A bare 1-5 answers the most recent gratitude text we sent to this number.
    const rating = /^[1-5]$/.test(normalizeInbound(fields.Body)) ? Number(normalizeInbound(fields.Body)) : null;
    if (rating) {
      const country = countryForBusiness(business);
      const recent = await prisma.smsLog.findMany({
        where: { businessId: business.id, kind: 'gratitude', bookingId: { not: null }, status: { in: mockSmsAllowed() ? ['sent', 'mock'] : ['sent'] } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
      const hit = recent.find((r) => (r.toE164 ? r.toE164 === toE164(from, country) : sameNumber(r.toPhone, from, country)));
      if (hit?.bookingId) {
        await routeGratitudeReply(hit.bookingId, rating);
        return xml(twiml());
      }
    }

    // Everything else is a customer writing to the business: store it in the owner's inbox, forward it to the verified owner phone and
    // acknowledge it once (see messaging/inbox). The reply is sent through the normal send path (logged, opt-out and cap aware), not as TwiML.
    const outcome = await handleInboundText(business, { From: from, Body: fields.Body, MessageSid: fields.MessageSid, SmsMessageSid: fields.SmsMessageSid });
    log.info('inbox', { business: business.id, stored: outcome.stored, dropped: outcome.dropped ?? null, forward: outcome.forward ?? null, auto_reply: outcome.autoReply ?? null });
    return xml(twiml());
  } catch (err) {
    log.error('failed', { err });
    return xml(twiml(), 500);
  }
}
