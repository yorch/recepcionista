/** The ONE place Google is called from: an injectable fetch (tests install a fake; mock mode installs an in-memory Google). */
import { googleMockEnabled } from './config';
import { mockGoogleFetch } from './mock';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
let override: FetchLike | null = null;

/** Test seam. Pass null to restore. */
export function setGoogleFetch(f: FetchLike | null): void { override = f; }

export function googleFetch(url: string, init?: RequestInit): Promise<Response> {
  if (override) return override(url, init);
  if (googleMockEnabled()) return mockGoogleFetch(url, init);
  return fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(20_000) });
}

export class GoogleApiError extends Error {
  constructor(public status: number, public reason: string, message?: string) {
    super(message ?? `google api ${status} ${reason}`);
    this.name = 'GoogleApiError';
  }
}

/** Never put a response body in an error: it can echo tokens. Only the structured `error` / reason fields survive. */
export async function toApiError(res: Response): Promise<GoogleApiError> {
  let reason = 'unknown';
  try {
    const j = (await res.json()) as { error?: string | { errors?: { reason?: string }[]; status?: string; message?: string }; error_description?: string };
    if (typeof j.error === 'string') reason = j.error;
    else if (j.error) reason = j.error.errors?.[0]?.reason ?? j.error.status ?? 'unknown';
  } catch { /* no body */ }
  return new GoogleApiError(res.status, String(reason).slice(0, 80));
}
