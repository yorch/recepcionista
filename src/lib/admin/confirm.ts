/**
 * Server-side typed confirmation of the critical console actions (the console asks for the phrase; the server no longer trusts the UI to have asked). Pure apart from SettingsError.
 * Phrase formats are exactly what the console shows: `<verb> <business name>` (lower case, spaces collapsed, 120 characters) for suspend / release, the administrator's e-mail address for
 * a 2FA reset, `run <job>` for a critical job and `publish <slug>/<locale>` for a legal page. The verb is the one of the signed-in language, so both languages are accepted.
 * The break-glass Bearer token (a script, audited and mailed per use) types nothing: callers skip the check for it.
 */
import { SettingsError } from './settings-store';

export const normalizePhrase = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();
/** Same as the console's `tenantPhrase`. */
export const tenantPhraseOf = (verb: string, name: string): string => normalizePhrase(`${verb} ${name}`).slice(0, 120);
export const TENANT_VERBS = { suspend: ['suspend', 'suspender'], release: ['release', 'liberar'] } as const;

/** Throws 422 `confirmation_required` unless `given` equals one of `accepted` (case and extra spaces ignored). */
export function requireConfirmPhrase(given: unknown, accepted: readonly string[]): void {
  const g = typeof given === 'string' ? normalizePhrase(given) : '';
  if (!g || !accepted.some((a) => normalizePhrase(a) === g)) throw new SettingsError(422, 'confirmation_required', `type the confirmation phrase exactly: ${accepted[0]}`);
}

/** Throws 422 `reason_required` unless `reason` is at least `min` characters of text. Returns the trimmed text. */
export function requireReason(reason: unknown, min = 8, max = 500): string {
  const r = typeof reason === 'string' ? reason.trim() : '';
  if (r.length < min || r.length > max) throw new SettingsError(422, 'reason_required', `a reason of ${min} to ${max} characters is required`);
  return r;
}
