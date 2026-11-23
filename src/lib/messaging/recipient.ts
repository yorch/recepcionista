/**
 * Outbound SMS recipient policy, enforced in the one place every text passes
 * through (providers/twilio sendSms). Pure: no I/O, easy to unit test.
 */
export const E164 = /^\+[1-9]\d{6,14}$/;

/** Env SMS_ALLOWED_COUNTRY_CODES, comma separated calling codes (default "1"). */
export function allowedCountryCodes(env: string | undefined = process.env.SMS_ALLOWED_COUNTRY_CODES): string[] {
  return (env ?? '1').split(',').map((c) => c.trim().replace(/^\+/, '').replace(/\D/g, '')).filter(Boolean);
}

/** True when an E.164 number starts with one of the allowed calling codes. */
export function countryAllowed(e164: string, codes: string[] = allowedCountryCodes()): boolean {
  const d = e164.replace(/\D/g, '');
  return codes.some((cc) => d.startsWith(cc));
}

export type RecipientCheck = { ok: true; to: string } | { ok: false; error: string };

/** Normalize loosely (10/11-digit US forms) then require strict E.164 and an allowed country. */
export function validateRecipient(raw: string, codes: string[] = allowedCountryCodes()): RecipientCheck {
  const digits = (raw ?? '').replace(/\D/g, '');
  let to = (raw ?? '').trim();
  if (digits.length === 10) to = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith('1')) to = `+${digits}`;
  else if (/^\+/.test(to)) to = `+${digits}`;
  else if (digits.length > 11) to = `+${digits}`;
  if (!E164.test(to)) return { ok: false, error: 'recipient must be an E.164 number like +13055550123' };
  if (!countryAllowed(to, codes)) return { ok: false, error: 'destination country is not allowed' };
  return { ok: true, to };
}
