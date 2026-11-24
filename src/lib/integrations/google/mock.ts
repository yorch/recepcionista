/**
 * In-memory fake Google for GOOGLE_OAUTH_MOCK=true (non-production only). Enough to click through connect, pick a calendar,
 * push events, and SYNC events the "owner" adds (`addMockGoogleEvent`, reached through POST /api/integrations/google/mock-event) so a
 * local run or the end-to-end script can watch a busy block appear. Never reached in production (googleMockEnabled is false there).
 */
import { GOOGLE_SCOPES } from './config';

interface Stored { event: Record<string, unknown>; version: number }
// On globalThis: the bundler can load this module once per route, and the fake must be ONE calendar for the whole process.
const g = globalThis as { __mockGoogle?: { events: Map<string, Stored>; version: number } };
const state = (g.__mockGoogle ??= { events: new Map<string, Stored>(), version: 1 });
const events = state.events; // `${calendarId}|${eventId}`
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const key = (calendarId: string, id: string) => `${calendarId}|${id}`;

/** An event created in "Google" by the owner (not by this app). Returns its id. */
export function addMockGoogleEvent(calendarId: string, ev: { start: string; end: string; summary?: string; transparency?: 'opaque' | 'transparent' }): string {
  const id = `mockext${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  events.set(key(calendarId, id), {
    version: ++state.version,
    event: { id, status: 'confirmed', etag: `"${state.version}"`, summary: ev.summary ?? 'Busy', start: { dateTime: ev.start }, end: { dateTime: ev.end }, transparency: ev.transparency ?? 'opaque' },
  });
  return id;
}

/** Owner-side deletion of an event (any event, including one this app pushed). */
export function deleteMockGoogleEvent(calendarId: string, id: string): boolean {
  const s = events.get(key(calendarId, id));
  if (!s) return false;
  events.set(key(calendarId, id), { version: ++state.version, event: { ...s.event, status: 'cancelled' } });
  return true;
}

export async function mockGoogleFetch(url: string, init?: RequestInit): Promise<Response> {
  const u = new URL(url);
  const method = (init?.method ?? 'GET').toUpperCase();
  if (u.pathname === '/token') {
    return json({ access_token: `mock-access-${Date.now()}`, refresh_token: 'mock-refresh', expires_in: 3600, scope: GOOGLE_SCOPES.join(' '), token_type: 'Bearer' });
  }
  if (u.pathname === '/revoke') return json({});
  if (u.pathname.endsWith('/channels/stop')) return json({}, 204);
  if (u.pathname.endsWith('/users/me/calendarList') || u.pathname.endsWith('/users/me/calendarList/primary')) {
    const primary = { id: 'mock.owner@example.test', summary: 'Mock owner', primary: true, accessRole: 'owner', timeZone: 'UTC' };
    return u.pathname.endsWith('/primary') ? json(primary) : json({ items: [primary, { id: 'mock-work@group.calendar.google.com', summary: 'Mock work', accessRole: 'owner' }] });
  }
  if (u.pathname.endsWith('/events/watch')) return json({ resourceId: 'mock-resource', expiration: String(Date.now() + 7 * 864e5) });
  const m = u.pathname.match(/\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
  if (m) {
    const cal = decodeURIComponent(m[1]);
    const id = m[2];
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (method === 'GET' && !id) {
      // Full listing: every live event of the calendar. Incremental (syncToken): only what changed since that token (cancellations included).
      const since = /^mock-sync-(\d+)$/.exec(u.searchParams.get('syncToken') ?? '')?.[1];
      const items = [...events.entries()]
        .filter(([k, s]) => k.startsWith(`${cal}|`) && (since ? s.version > Number(since) : s.event.status !== 'cancelled'))
        .map(([, s]) => s.event);
      return json({ items, nextSyncToken: `mock-sync-${state.version}` });
    }
    if (method === 'POST') { const ev = { ...body, etag: `"${++state.version}"` }; events.set(key(cal, String(body.id)), { event: ev, version: state.version }); return json(ev); }
    if (method === 'GET' && id) { const s = events.get(key(cal, id)); return s && s.event.status !== 'cancelled' ? json(s.event) : json({ error: { status: 'NOT_FOUND' } }, 404); }
    if (method === 'PATCH' && id) { const ev = { ...(events.get(key(cal, id))?.event ?? {}), ...body, etag: `"${++state.version}"` }; events.set(key(cal, id), { event: ev, version: state.version }); return json(ev); }
    if (method === 'DELETE' && id) { events.delete(key(cal, id)); return new Response(null, { status: 204 }); }
  }
  return json({ error: { status: 'NOT_FOUND' } }, 404);
}

/** Test helper: forget everything. */
export function resetMockGoogle(): void { events.clear(); state.version = 1; }
