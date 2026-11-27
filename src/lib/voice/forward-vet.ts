/**
 * The full forward-destination check for a business: the pure rules (validateForwardNumber) PLUS the lookups that need the
 * database / environment, so a forwarded call can never be a loop into ANY assistant line of the platform:
 *  - a number held by ANY business (this or another tenant) is an AI line: forwarding to it would hand the call to that line;
 *  - TWILIO_PHONE_NUMBER (the platform's own number) likewise.
 * Used wherever a forward target is set (verify start/confirm, adopting the owner phone) and again at dial time.
 */
import { configEnv } from '@/lib/config';
import { getBusinessByPhone } from '@/lib/db';
import { defaultPhoneCountry, phoneCountry, toE164 } from '@/lib/phone';
import { validateForwardNumber, type ForwardNumberCheck } from '@/lib/voice/forward-number';
import type { Business } from '@/lib/types';

export async function vetForwardNumber(business: Pick<Business, 'id' | 'phone_e164'>, raw: unknown): Promise<ForwardNumberCheck> {
  const country = phoneCountry(business.phone_e164) ?? defaultPhoneCountry();
  const check = validateForwardNumber(raw, country, { ownLines: [business.phone_e164] });
  if (!check.ok) return check;
  const platformNumber = toE164(configEnv().TWILIO_PHONE_NUMBER);
  if (platformNumber && platformNumber === check.e164) return { ok: false, error: 'that is an assistant number: forwarding to it would loop the call' };
  const holder = await getBusinessByPhone(check.e164);
  if (holder) return { ok: false, error: 'that is an assistant number: forwarding to it would loop the call' };
  return check;
}
