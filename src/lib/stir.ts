/**
 * STIR/SHAKEN caller trust. Twilio reports the verification result of the caller's number as `StirStatus`
 * (the "verstat"), e.g. 'TN-Validation-Passed-A'. Pure: no database.
 */
export type Attestation = 'A' | 'B' | 'C' | 'none' | 'failed';

/**
 * Attestation level of a verstat value:
 *  - 'TN-Validation-Passed-A' | '-B' | '-C' -> 'A' | 'B' | 'C'
 *  - 'TN-Validation-Failed-*'               -> 'failed'
 *  - 'No-TN-Validation', empty, unknown     -> 'none'
 * Case-insensitive; surrounding whitespace is ignored.
 */
export function attestationLevel(status: string | null | undefined): Attestation {
  const s = String(status ?? '').trim().toLowerCase();
  if (!s) return 'none';
  const passed = /^tn-validation-passed-([abc])$/.exec(s);
  if (passed) return passed[1].toUpperCase() as 'A' | 'B' | 'C';
  if (s.startsWith('tn-validation-failed')) return 'failed';
  return 'none';
}

/** The number was fully verified by the originating carrier (attestation A). B and C are partial: not "verified". */
export const isCallerVerified = (status: string | null | undefined): boolean => attestationLevel(status) === 'A';

/** Keep the stored value to something a header can plausibly carry. */
export function cleanStirStatus(status: string | null | undefined): string | null {
  const s = String(status ?? '').trim();
  return s && s.length <= 64 && /^[A-Za-z0-9_.-]+$/.test(s) ? s : null;
}
