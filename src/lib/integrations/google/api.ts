/** Authenticated Google Calendar REST calls for one connection. Retries once on 401 with a forced refresh; 429/5xx surface as GoogleApiError. */
import { GOOGLE_API } from './config';
import { GoogleApiError, googleFetch, toApiError } from './http';
import { accessTokenFor, NeedsReauthError } from './tokens';

export interface ApiOptions { query?: Record<string, string | undefined>; body?: unknown; headers?: Record<string, string> }

export async function gcal(connectionId: string, method: string, path: string, opts: ApiOptions = {}): Promise<Response> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) q.set(k, v);
  const url = `${GOOGLE_API}${path}${q.size ? `?${q}` : ''}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await accessTokenFor(connectionId, { force: attempt === 1 });
    const res = await googleFetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...opts.headers },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 401 && attempt === 0) continue;
    if (res.status === 401) throw new NeedsReauthError();
    return res;
  }
  throw new GoogleApiError(401, 'unauthorized');
}

export async function gcalJson<T>(connectionId: string, method: string, path: string, opts: ApiOptions = {}): Promise<T> {
  const res = await gcal(connectionId, method, path, opts);
  if (!res.ok) throw await toApiError(res);
  return (res.status === 204 ? {} : await res.json()) as T;
}

export const calPath = (calendarId: string): string => `/calendars/${encodeURIComponent(calendarId)}`;

export interface CalendarListEntry { id: string; summary?: string; primary?: boolean; accessRole?: string }
export async function listCalendars(connectionId: string): Promise<CalendarListEntry[]> {
  const j = await gcalJson<{ items?: CalendarListEntry[] }>(connectionId, 'GET', '/users/me/calendarList', { query: { minAccessRole: 'writer', maxResults: '100' } });
  return j.items ?? [];
}
