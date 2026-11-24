/**
 * In-memory fake Google for GOOGLE_OAUTH_MOCK=true (non-production only). Enough to click through connect, pick a calendar,
 * push events and sync an empty calendar locally. Never reached in production (googleMockEnabled is false there).
 */
const events = new Map<string, Record<string, unknown>>();
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export async function mockGoogleFetch(url: string, init?: RequestInit): Promise<Response> {
  const u = new URL(url);
  const method = (init?.method ?? 'GET').toUpperCase();
  if (u.pathname === '/token') {
    return json({ access_token: `mock-access-${Date.now()}`, refresh_token: 'mock-refresh', expires_in: 3600, scope: 'mock', token_type: 'Bearer' });
  }
  if (u.pathname === '/revoke') return json({});
  if (u.pathname.endsWith('/channels/stop')) return json({}, 204);
  if (u.pathname.endsWith('/users/me/calendarList') || u.pathname.endsWith('/users/me/calendarList/primary')) {
    const primary = { id: 'mock.owner@example.test', summary: 'Mock owner', primary: true, accessRole: 'owner', timeZone: 'UTC' };
    return u.pathname.endsWith('/primary') ? json(primary) : json({ items: [primary, { id: 'mock-work@group.calendar.google.com', summary: 'Mock work', accessRole: 'owner' }] });
  }
  if (u.pathname.endsWith('/events/watch')) return json({ resourceId: 'mock-resource', expiration: String(Date.now() + 7 * 864e5) });
  const m = u.pathname.match(/\/calendars\/[^/]+\/events(?:\/([^/]+))?$/);
  if (m) {
    const id = m[1];
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (method === 'GET' && !id) return json({ items: [], nextSyncToken: `mock-sync-${Date.now()}` });
    if (method === 'POST') { const ev = { ...body, etag: `"${Date.now()}"` }; events.set(String(body.id), ev); return json(ev); }
    if (method === 'GET' && id) { const ev = events.get(id); return ev ? json(ev) : json({ error: { status: 'NOT_FOUND' } }, 404); }
    if (method === 'PATCH' && id) { const ev = { ...(events.get(id) ?? {}), ...body, etag: `"${Date.now()}"` }; events.set(id, ev); return json(ev); }
    if (method === 'DELETE' && id) { events.delete(id); return new Response(null, { status: 204 }); }
  }
  return json({ error: { status: 'NOT_FOUND' } }, 404);
}
