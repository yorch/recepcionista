/**
 * Phone normalisation to E.164 (libphonenumber-js, the "min" metadata: validity by length/pattern,
 * which is what we need to tell "a plausible number" from junk). Pure, no I/O, safe in any runtime.
 *
 * The legacy `phoneKey()` (last 10 digits, src/lib/format.ts) conflates numbers from different
 * countries; E.164 does not. New code should compare E.164 values.
 */
import { configEnv } from '@/lib/config';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/min';

/** Country assumed for numbers written without a '+' prefix. Override with DEFAULT_PHONE_COUNTRY (ISO 3166-1 alpha-2). */
export function defaultPhoneCountry(): CountryCode {
  const c = (configEnv().DEFAULT_PHONE_COUNTRY || '').trim().toUpperCase();
  return (/^[A-Z]{2}$/.test(c) ? c : 'US') as CountryCode;
}

/**
 * Normalise to E.164 ("+13055550142"), or null when the input is empty or not a valid number.
 * Numbers without a '+' are interpreted in `defaultCountry` (default: DEFAULT_PHONE_COUNTRY or US).
 */
export function toE164(raw: string | null | undefined, defaultCountry?: string): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 40) return null;
  const country = (defaultCountry ? defaultCountry.toUpperCase() : defaultPhoneCountry()) as CountryCode;
  try {
    const parsed = parsePhoneNumberFromString(s, country);
    return parsed && parsed.isValid() ? parsed.number : null;
  } catch {
    return null;
  }
}

/** ISO country of an E.164 number ("+13055550142" -> "US"); null when invalid or ambiguous. */
export function phoneCountry(e164: string | null | undefined): string | null {
  if (typeof e164 !== 'string' || !e164.startsWith('+')) return null;
  try {
    const parsed = parsePhoneNumberFromString(e164);
    return parsed && parsed.isValid() ? (parsed.country ?? null) : null;
  } catch {
    return null;
  }
}

/** True when both inputs are valid numbers and normalise to the same E.164. Invalid input never matches. */
export function sameNumber(a: string | null | undefined, b: string | null | undefined, defaultCountry?: string): boolean {
  const x = toE164(a, defaultCountry);
  return x !== null && x === toE164(b, defaultCountry);
}

// ---- NANP area codes (number purchase) ------------------------------------------------------------

/** Area code used for new numbers when neither TWILIO_AREA_CODE nor the business gives a usable one. */
export const DEFAULT_AREA_CODE = '305';

/** Toll-free / premium codes: never a LOCAL number a business can be bought in. */
const NON_GEOGRAPHIC_AREA_CODES = new Set(['800', '833', '844', '855', '866', '877', '888', '900', '500', '521', '522', '533', '544', '566', '577', '588']);

/** A plausible US/Canada geographic area code: NXX (N = 2-9), not N11, not 555, not toll-free/premium, and a real number prefix exists for it. */
export function isValidAreaCode(code: string | null | undefined): code is string {
  if (typeof code !== 'string' || !/^[2-9]\d{2}$/.test(code)) return false;
  if (code[1] === '1' && code[2] === '1') return false;
  if (code === '555' || NON_GEOGRAPHIC_AREA_CODES.has(code)) return false;
  try {
    const parsed = parsePhoneNumberFromString(`+1${code}2345678`);
    return Boolean(parsed && parsed.isValid());
  } catch {
    return false;
  }
}

/** The US/Canada area code of a phone number ("+13055550142" -> "305"), or null for anything else / an invalid code. */
export function areaCodeOf(raw: string | null | undefined, defaultCountry?: string): string | null {
  const e164 = toE164(raw, defaultCountry);
  if (!e164 || !/^\+1\d{10}$/.test(e164)) return null;
  const code = e164.slice(2, 5);
  return isValidAreaCode(code) ? code : null;
}

/** TWILIO_AREA_CODE when it is a valid area code, else DEFAULT_AREA_CODE (305). */
export function configuredAreaCode(env: NodeJS.ProcessEnv = configEnv()): string {
  const v = (env.TWILIO_AREA_CODE ?? '').trim();
  return isValidAreaCode(v) ? v : DEFAULT_AREA_CODE;
}

/** Area code to buy a business's number in: the area code of its OWN phone (the owner's) when valid, else the platform default. */
export function areaCodeForBusiness(
  b: { owner_phone?: string | null } | null | undefined,
  env: NodeJS.ProcessEnv = configEnv(),
): string {
  return areaCodeOf(b?.owner_phone ?? null) ?? configuredAreaCode(env);
}
