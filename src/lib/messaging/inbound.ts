/**
 * Inbound-SMS keyword side effects, shared by every route a Twilio number's webhook may point at
 * (/api/sms/inbound and the legacy /api/sms/gratitude-reply). Opt-outs are recorded here and nowhere else.
 */
import { countryForBusiness, recordFollowupConsentFromReply, recordOptIn, recordOptOut } from '@/lib/db';
import { meterSms } from '@/lib/messaging';
import { smsSegments } from '@/lib/messaging/policy';
import { consentReply, helpReply, isPositiveKeyword, mentionsStopWord, parseKeyword, startReply, stopReply, twiml } from '@/lib/messaging/keywords';
import { logger } from '@/lib/log';
import type { Business } from '@/lib/types';

const log = logger('sms/inbound');

/** Where a customer-granted follow-up consent came from (bookings.followup_consent_source). */
export const FOLLOWUP_CONSENT_REPLY_SOURCE = 'inbound_keyword';

/**
 * Apply a STOP / START / HELP / YES keyword for `business`. Returns the TwiML to answer with, or null when
 * the message is not a keyword (the caller then continues with its own handling).
 * The auto-replies are sent by Twilio, not by us, but they are billed texts: they are counted against the plan
 * (never blocked by it: a STOP confirmation must always go out).
 */
export async function applyInboundKeyword(business: Business, from: string, body: string | null | undefined): Promise<string | null> {
  const country = countryForBusiness(business);
  const keyword = parseKeyword(body);
  if (keyword === 'stop') {
    await recordOptOut(business.id, from, 'stop_keyword', country);
    const reply = stopReply(business.name);
    await meterSms(business.id, smsSegments(reply));
    return twiml(reply);
  }
  if (keyword === 'start') {
    await recordOptIn(business.id, from, country);
    // START is also an explicit opt in to the follow-up text on their latest booking.
    await recordFollowupConsentFromReply(business.id, from, `${FOLLOWUP_CONSENT_REPLY_SOURCE}:start`, country);
    const reply = startReply(business.name);
    await meterSms(business.id, smsSegments(reply));
    return twiml(reply);
  }
  if (keyword === 'help') {
    const reply = helpReply(business.name, business.phone);
    await meterSms(business.id, smsSegments(reply));
    return twiml(reply);
  }
  if (isPositiveKeyword(body)) {
    // A customer's own YES / Y / SI is the re-permission path for bookings made before follow-up consent was recorded.
    const res = await recordFollowupConsentFromReply(business.id, from, `${FOLLOWUP_CONSENT_REPLY_SOURCE}:yes`, country);
    if (res.granted) {
      const reply = consentReply(business.name);
      await meterSms(business.id, smsSegments(reply));
      return twiml(reply);
    }
    return null;
  }
  if (mentionsStopWord(body)) log.warn('possible_revocation', { business: business.id });
  return null;
}
