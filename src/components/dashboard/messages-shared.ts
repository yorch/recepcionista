import { ApiError } from '@/hooks/use-api';
import { errorText } from '@/lib/i18n/api-errors';
import type { MessageKey, TFunction } from '@/lib/i18n/core';

const CODES = new Set(['empty', 'too_long', 'invalid_recipient', 'unknown_recipient', 'not_allowed', 'rate_limited', 'quiet_hours', 'opted_out', 'cap_reached', 'send_failed']);

/** Localized text of a failed messages request: the server's machine `code` when it sent one, else the generic API error map. */
export function messageErrorText(t: TFunction, err: unknown): string {
  const code = err instanceof ApiError ? (err.payload as { code?: unknown } | undefined)?.code : undefined;
  if (typeof code === 'string' && CODES.has(code)) return t(`msg.err.${code}` as MessageKey);
  return errorText(t, err);
}

export const STATUS_TONE: Record<string, string> = {
  sent: 'routine', handled: 'routine', mock: 'unsure', queued: 'neutral', new: 'brand', ignored: 'neutral', failed: 'emergency',
};
export const statusTone = (status: string): string => STATUS_TONE[status] ?? (status.startsWith('blocked') ? 'unsure' : 'neutral');
