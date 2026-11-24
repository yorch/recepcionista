/**
 * Validation of a call-forwarding destination. Pure (no I/O), so it is unit tested without a database.
 *
 * A forwarded call is a call WE place from the business line on the owner's behalf, so the destination is a toll-fraud /
 * pumping surface. A forward number must be:
 *  - strict E.164 (so never a short code, an extension or a 3-digit service number),
 *  - in an allowed country (FORWARD_ALLOWED_COUNTRY_CODES, defaulting to SMS_ALLOWED_COUNTRY_CODES, default "1"),
 *  - not a premium-rate, shared-cost, satellite/international-network or "one-ring scam" prefix (list below),
 *  - not one of the business's own lines (the AI number: that would loop the call back into itself).
 * It must additionally be VERIFIED (SMS code, or the verified owner phone) before a call is ever dialled
 * (see call-mode.ts `trustedForwardNumber`).
 */
import { toE164 } from '@/lib/phone';
import { allowedCountryCodes, countryAllowed } from '@/lib/messaging/recipient';

/** NANP area codes that are premium-rate or international-rate Caribbean destinations (the classic "one ring" callback scams). */
const NANP_BLOCKED_AREA = new Set([
  '900', '976', // premium-rate
  '242', '246', '264', '268', '284', '345', '441', '473', '649', '658', '664', '721', '758', '767', '784', '809', '829', '849', '868', '869', '876', // Caribbean (international rates)
]);

const NANP_NON_GEOGRAPHIC = new Set(['500', '521', '522', '523', '533', '544', '566', '577', '588', '600', '700']);

/** E.164 prefixes (with the +) that are premium, shared-cost, personal-number, international-network or satellite ranges. */
const BLOCKED_PREFIXES = [
  '+44 9', '+44 70', '+44 84', '+44 87', // UK premium / personal / non-geographic
  '+979', '+881', '+882', '+883', '+870', '+871', '+872', '+873', '+874', '+800', '+808', '+888',
  '+90 900', '+49 900', '+49 137', '+49 180', '+33 89', '+39 89', '+34 80', '+34 90', '+52 900',
].map((p) => p.replace(/\s/g, ''));

export type ForwardNumberCheck = { ok: true; e164: string } | { ok: false; error: string };

/** The configured allow-list for forward destinations (FORWARD_ALLOWED_COUNTRY_CODES, else the SMS list). */
export function forwardAllowedCountryCodes(env: Record<string, string | undefined> = process.env): string[] {
  const own = env.FORWARD_ALLOWED_COUNTRY_CODES;
  return own && own.trim() ? allowedCountryCodes(own) : allowedCountryCodes(env.SMS_ALLOWED_COUNTRY_CODES);
}

/**
 * Normalise and vet a destination. `country` is the business's ISO country (to read a national-format number).
 * `ownLines` are the business's own numbers in E.164 (never a valid destination).
 */
export function validateForwardNumber(
  raw: unknown,
  country: string,
  opts: { ownLines?: (string | null | undefined)[]; codes?: string[] } = {},
): ForwardNumberCheck {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'a phone number is required' };
  if (raw.length > 40) return { ok: false, error: 'that is not a valid phone number' };
  // Short codes, extensions and anything with letters are never a destination.
  if (/[a-z]/i.test(raw) || /(?:ext|x|#|;|,)/i.test(raw)) return { ok: false, error: 'extensions and codes are not supported: enter a full phone number' };
  const e164 = toE164(raw, country);
  if (!e164 || !/^\+[1-9]\d{7,14}$/.test(e164)) return { ok: false, error: 'enter a full phone number (include the country code for non-US numbers)' };
  const codes = opts.codes ?? forwardAllowedCountryCodes();
  if (!countryAllowed(e164, codes)) return { ok: false, error: 'forwarding to that country is not enabled for this account' };
  if (e164.startsWith('+1')) {
    const area = e164.slice(2, 5);
    if (NANP_BLOCKED_AREA.has(area)) return { ok: false, error: 'premium-rate and international-rate numbers cannot be used for forwarding' };
    // N11 (211 ... 911) is a service code, never a subscriber area code; 500/533/544/566/577/588/600/700 are non-geographic.
    if (/^[2-9]11$/.test(area) || NANP_NON_GEOGRAPHIC.has(area)) return { ok: false, error: 'enter a regular phone number' };
  }
  if (BLOCKED_PREFIXES.some((p) => e164.startsWith(p))) return { ok: false, error: 'premium-rate and non-geographic numbers cannot be used for forwarding' };
  if ((opts.ownLines ?? []).some((own) => own && own === e164)) return { ok: false, error: 'that is your assistant number: forwarding to it would loop the call' };
  return { ok: true, e164 };
}
