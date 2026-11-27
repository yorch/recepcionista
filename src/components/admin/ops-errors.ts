import type { MessageKey, TFunction } from '@/lib/i18n/core';
import { adminErrorText, apiCode } from './errors';

const OWN = new Set(['not_acknowledgeable', 'invalid_filter', 'invalid_cursor', 'reason_required', 'maintenance']);

/** Localized text of an operations API failure: this area's own codes first, then the console's. */
export function opsErrorText(t: TFunction, err: unknown): string {
  const code = apiCode(err);
  if (code && OWN.has(code)) return t(`ao.err.${code}` as MessageKey);
  return adminErrorText(t, err);
}
