import { getBusinessByPhone, recordOptIn, recordOptOut } from '@/lib/db';
import { verifyTwilioSignature } from '@/lib/providers/twilio';
import { helpReply, parseKeyword, startReply, stopReply, twiml } from '@/lib/messaging/keywords';
import { logger } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = logger('sms/inbound');

const xml = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/xml; charset=utf-8' } });

/**
 * Twilio inbound-SMS webhook: STOP-class keywords opt the sender out of this business's texts,
 * START-class keywords opt back in, HELP returns contact info. Signature verified, fails closed.
 * The business is resolved from the Twilio number the text was sent TO.
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
    const keyword = parseKeyword(fields.Body);
    const business = to ? await getBusinessByPhone(to) : null;
    if (!business || !from) {
      log.warn('unrouted', { to: to || null, matched: Boolean(business) });
      return xml(twiml());
    }

    if (keyword === 'stop') {
      await recordOptOut(business.id, from, 'stop_keyword');
      return xml(twiml(stopReply(business.name)));
    }
    if (keyword === 'start') {
      await recordOptIn(business.id, from);
      return xml(twiml(startReply(business.name)));
    }
    if (keyword === 'help') return xml(twiml(helpReply(business.name, business.phone)));

    return xml(twiml()); // not a keyword: no auto-reply
  } catch (err) {
    log.error('failed', { err });
    return xml(twiml(), 500);
  }
}
