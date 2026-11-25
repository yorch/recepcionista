/**
 * An inbound text whose business cannot be told (messaging/sender resolveInboundRoute: more than one business sent from that number to that customer, or a
 * Messaging Service sender is not known yet). Nothing business-specific is run for it: no "C" cancel, no 1-5 rating, no inbox row, no auto-reply, no owner forward
 * of the customer's words (which would hand them to a business that may never have texted this customer). What happens instead:
 *  - STOP is ALWAYS honoured, for every candidate: each of them texted this customer from the number the customer is telling to stop, so stopping all of them is what
 *    the customer asked for (and the compliance requirement); the confirmation names no business.
 *  - anything else gets a neutral acknowledgement (no business name, no question to the customer), and every candidate's owner is flagged once per 6 hours per customer:
 *    an audit event `sms.inbound_ambiguous` (last 4 digits only, never the words) and, to a verified owner phone, a text that holds no customer words.
 * The customer's words are NOT stored (documented in docs/known-limitations.md): the only way to avoid that is the pinned sender (TWILIO_MESSAGING_SERVICE_PIN_SENDER).
 */
import { claimEvent, countryForBusiness, recordAudit, recordOptOut } from '@/lib/db';
import { inboxLanguage } from '@/lib/messaging/inbox-copy';
import { parseKeyword, twiml } from '@/lib/messaging/keywords';
import { alertOwner } from '@/lib/voice/owner-alert';
import { logger } from '@/lib/log';
import type { Business } from '@/lib/types';

const log = logger('sms/inbound-ambiguous');
const FLAG_WINDOW_MS = 6 * 60 * 60_000;

export const neutralStopReply = (): string => 'You are unsubscribed and will receive no more texts from this number. Reply START to resubscribe.';
export function neutralAckReply(body: string | null | undefined): string {
  return inboxLanguage({ locale_default: 'en' }, body ?? '') === 'es'
    ? 'Gracias, recibimos su mensaje. Si es urgente, llame directamente al negocio.'
    : 'Thanks, we got your message. If it is urgent, please call the business directly.';
}
const ownerFlagText = (b: Pick<Business, 'locale_default'>, last4: string): string => b.locale_default === 'es'
  ? `Un cliente (...${last4}) respondio a un numero de texto que usan varios negocios y no se pudo saber para cual era. Su mensaje no se guardo. Si le escribe a su numero directo, lo vera en Mensajes.`
  : `A customer (...${last4}) replied to a text number several businesses use, and we could not tell which one it was for. Their message was not stored. If they text your own number directly you will see it in Messages.`;

/** Handle the ambiguous text: returns the TwiML answer. Never throws on a flag failure. */
export async function handleAmbiguousInbound(candidates: Business[], from: string, body: string | null | undefined, now: Date = new Date()): Promise<string> {
  const stop = parseKeyword(body) === 'stop';
  const last4 = from.replace(/\D/g, '').slice(-4);
  if (stop) {
    for (const b of candidates) await recordOptOut(b.id, from, 'stop_keyword', countryForBusiness(b));
  }
  for (const b of candidates) {
    try {
      await recordAudit({
        actor_kind: 'system', business_id: b.id, action: 'sms.inbound_ambiguous', target: `customer:...${last4}`,
        meta: { candidates: candidates.length, stop, customer_last4: last4 },
      });
      if (stop || !(await claimEvent('inbound-ambiguous', `${b.id}:${from}`, FLAG_WINDOW_MS))) continue; // a STOP is not an alert: nothing was lost; one flag per customer per window
      await alertOwner(b, ownerFlagText(b, last4), { class: 'notice', logBody: `Ambiguous customer text (...${last4}); the words were not stored.` });
    } catch (err) {
      log.warn('flag_failed', { business: b.id, err });
    }
  }
  log.warn('routed_ambiguous', { candidates: candidates.map((c) => c.id), stop, at: now.toISOString() });
  return twiml(stop ? neutralStopReply() : neutralAckReply(body));
}
