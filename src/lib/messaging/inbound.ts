/**
 * Inbound-SMS keyword side effects, shared by every route a Twilio number's webhook may point at
 * (/api/sms/inbound and the legacy /api/sms/gratitude-reply). Opt-outs are recorded here and nowhere else.
 */
import { recordOptIn, recordOptOut } from '@/lib/db';
import { helpReply, mentionsStopWord, parseKeyword, startReply, stopReply, twiml } from '@/lib/messaging/keywords';
import { logger } from '@/lib/log';
import type { Business } from '@/lib/types';

const log = logger('sms/inbound');

/**
 * Apply a STOP / START / HELP keyword for `business`. Returns the TwiML to answer with, or null when
 * the message is not a keyword (the caller then continues with its own handling).
 */
export async function applyInboundKeyword(business: Business, from: string, body: string | null | undefined): Promise<string | null> {
  const keyword = parseKeyword(body);
  if (keyword === 'stop') {
    await recordOptOut(business.id, from, 'stop_keyword');
    return twiml(stopReply(business.name));
  }
  if (keyword === 'start') {
    await recordOptIn(business.id, from);
    return twiml(startReply(business.name));
  }
  if (keyword === 'help') return twiml(helpReply(business.name, business.phone));
  if (mentionsStopWord(body)) log.warn('possible_revocation', { business: business.id });
  return null;
}
