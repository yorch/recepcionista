/**
 * Phone normalisation to E.164 (libphonenumber-js, the "min" metadata: validity by length/pattern,
 * which is what we need to tell "a plausible number" from junk). Pure, no I/O, safe in any runtime.
 *
 * The legacy `phoneKey()` (last 10 digits, src/lib/format.ts) conflates numbers from different
 * countries; E.164 does not. New code should compare E.164 values.
 */
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/min';

/** Country assumed for numbers written without a '+' prefix. Override with DEFAULT_PHONE_COUNTRY (ISO 3166-1 alpha-2). */
export function defaultPhoneCountry(): CountryCode {
  const c = (process.env.DEFAULT_PHONE_COUNTRY || '').trim().toUpperCase();
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
