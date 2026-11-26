import { prisma, recordAudit } from '@/lib/db';
import { verifyTwilioSignature } from '@/lib/providers/twilio';
import { logger } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = logger('sms/status');
const E164 = /^\+[1-9]\d{7,14}$/;
/** Statuses that mean the carrier / Twilio did NOT deliver the text. 30007 = carrier filtering (unregistered A2P traffic), 30034 = unregistered 10DLC number. */
const UNDELIVERED = new Set(['failed', 'undelivered']);

/**
 * Twilio's per-message StatusCallback (every text carries it, providers/twilio postMessage). Two jobs, both keyed on the MessageSid we stored as sms_log.provider_id:
 *  1. learn the SENDER of a Messaging Service text: Twilio picks a pool number and reports it as `From`; it is stored (from_e164) only while the row has none. A reply to
 *     that number is routed by it (messaging/sender resolveInboundRoute);
 *  2. surface a delivery FAILURE: a text Twilio accepted (201) but the carrier did not deliver (most importantly an unregistered A2P number, 30007 / 30034) is audited
 *     as `sms.delivery_failed` (error code only, never the text). Nothing is retried and the sms_log status is not rewritten.
 * Signature verified, fails closed; always answers 200 with an empty body once the signature is good (Twilio retries on errors, and a row that is not written yet
 * would only be retried into the same answer: the next status update carries the same From).
 */
export async function POST(req: Request) {
  try {
    const fields: Record<string, string> = {};
    (await req.formData().catch(() => new FormData())).forEach((v, k) => { if (typeof v === 'string') fields[k] = v; });
    const verdict = verifyTwilioSignature(req, fields);
    if (!verdict.ok) {
      log.warn('signature.rejected', { error: verdict.error });
      return new Response('', { status: 403 });
    }
    const sid = (fields.MessageSid || fields.SmsSid || '').trim();
    if (!sid) return new Response('', { status: 200 });
    const from = (fields.From ?? '').trim();
    if (E164.test(from)) {
      const res = await prisma.smsLog.updateMany({ where: { providerId: sid, fromE164: null, senderKind: 'service' }, data: { fromE164: from } });
      if (res.count > 0) log.info('sender_learned', { rows: res.count });
    }
    const status = (fields.MessageStatus || fields.SmsStatus || '').trim().toLowerCase();
    if (UNDELIVERED.has(status)) {
      const row = await prisma.smsLog.findFirst({ where: { providerId: sid }, select: { id: true, businessId: true, kind: true } });
      const code = (fields.ErrorCode ?? '').trim().slice(0, 10);
      log.error('delivery_failed', { sid, code: code || null, status, business: row?.businessId ?? null, kind: row?.kind ?? null });
      if (row) {
        await recordAudit({ actor_kind: 'webhook', business_id: row.businessId, action: 'sms.delivery_failed', target: `sms:${row.id}`, meta: { status, error_code: code || null, kind: row.kind } });
      }
    }
    return new Response('', { status: 200 });
  } catch (err) {
    log.error('failed', { err });
    return new Response('', { status: 500 });
  }
}
