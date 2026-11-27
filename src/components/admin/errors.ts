import { ApiError } from '@/hooks/use-api';
import { errorText } from '@/lib/i18n/api-errors';
import type { MessageKey, TFunction } from '@/lib/i18n/core';

export interface Problem { key: string; code: string; message: string }

const CODES = new Set([
  'unknown_key', 'env_only', 'invalid_value', 'duplicate_key', 'use_secret_field', 'nothing_to_change', 'reason_required', 'confirmation_required', 'ratchet_violation', 'out_of_bounds',
  'not_stricter', 'smtp_target_refused', 'verification_failed', 'invalid_body', 'locked_by_env', 'pair_required', 'stale_preview', 'superseded', 'secret_rollback_expired', 'not_rollbackable',
  'forbidden', 'settings_frozen', 'reauth_required', '2fa_enrollment_required', 'not_found', 'no_draft', 'body_too_large', 'invalid_slug', 'invalid_locale', 'too_many_changes', 'maintenance',
]);

export const apiCode = (err: unknown): string | null => (err instanceof ApiError ? ((err.payload as { code?: string } | undefined)?.code ?? null) : null);

export function problemsOf(err: unknown): Problem[] {
  if (!(err instanceof ApiError)) return [];
  const p = (err.payload as { problems?: Problem[] } | undefined)?.problems;
  return Array.isArray(p) ? p : [];
}

/** Localized text for an admin API failure: the machine `code` first (stable), then the generic error map, else the server's English sentence. */
export function adminErrorText(t: TFunction, err: unknown): string {
  const code = apiCode(err);
  if (code && CODES.has(code)) return t(`ac.err.${code}` as MessageKey);
  return errorText(t, err);
}

/** The phrase the server wants typed, parsed from its 422 `confirmation_required` message ("... exactly: <phrase>"). */
export function phraseFromError(err: unknown): string | null {
  if (apiCode(err) !== 'confirmation_required' || !(err instanceof ApiError)) return null;
  const m = /exactly:\s*(.+)$/.exec(err.message);
  return m ? m[1].trim() : null;
}
