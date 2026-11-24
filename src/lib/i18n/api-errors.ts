import { API_ERROR_PATTERNS, API_ERROR_SLUGS } from './catalog/error-keys';
import type { MessageKey, TFunction } from './core';

/** The message key for a known API error string, else null. */
export function apiErrorKey(raw: string | null | undefined): MessageKey | null {
  if (!raw) return null;
  const slug = API_ERROR_SLUGS[raw] ?? API_ERROR_PATTERNS.find((p) => p.re.test(raw))?.slug;
  return slug ? (`err.${slug}` as MessageKey) : null;
}

/** Localized text for an API error string (client-side mapping); unknown strings are shown as the server wrote them. */
export function apiErrorMessage(t: TFunction, raw: string | null | undefined, fallback?: MessageKey): string {
  const key = apiErrorKey(raw);
  if (key) return t(key, raw ? { n: (/\d+/.exec(raw)?.[0]) ?? '' } : undefined);
  if (raw && raw !== 'unauthorized') return raw;
  return t(fallback ?? 'err.generic');
}

/** Localized text for any thrown value (ApiError, Error, string, browser error): its message goes through the API error map. */
export function errorText(t: TFunction, err: unknown, fallback?: MessageKey): string {
  const raw = typeof err === 'string' ? err : err instanceof Error ? err.message : (err as { message?: unknown } | null)?.message;
  return apiErrorMessage(t, typeof raw === 'string' ? raw : undefined, fallback);
}
