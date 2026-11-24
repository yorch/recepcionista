/** A fake Google (OAuth token endpoint + Calendar API + push watch) installed through setGoogleFetch. No live Google is ever contacted. */
export interface FakeEvent { id: string; status?: string; etag: string; v: number; start?: unknown; end?: unknown; summary?: string; description?: string; transparency?: string; eventType?: string; attendees?: unknown[]; extendedProperties?: { private?: Record<string, string> } }
export interface Call { method: string; url: string; path: string; query: URLSearchParams; body: Record<string, unknown> | null; headers: Record<string, string> }

export class FakeGoogle {
  calls: Call[] = [];
  events = new Map<string, FakeEvent>();
  version = 0;
  refreshError: string | null = null;
  tokenSeq = 0;
  gone = false;
  failStatus: number | null = null;
  calendars = [{ id: 'owner@example.test', summary: 'Owner', primary: true, accessRole: 'owner' }, { id: 'work@group.calendar.google.com', summary: 'Work', accessRole: 'writer' }];
  lastChannel: { id: string; token: string; address: string } | null = null;

  count(method: string, pathPart: string): number { return this.calls.filter((c) => c.method === method && c.path.includes(pathPart)).length; }
  reset() { this.calls = []; }

  /** Owner-side edit in Google (new etag, new version). */
  put(ev: Partial<FakeEvent> & { id: string }): FakeEvent {
    const prev = this.events.get(ev.id);
    const v = ++this.version;
    const merged = { ...(prev ?? {}), ...ev, v, etag: `"e${v}"` } as FakeEvent;
    this.events.set(ev.id, merged);
    return merged;
  }
  remove(id: string) { this.put({ id, status: 'cancelled' }); }

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    let body: Record<string, unknown> | null = null;
    const raw = init?.body ? String(init.body) : '';
    if (raw) { try { body = JSON.parse(raw); } catch { body = Object.fromEntries(new URLSearchParams(raw)); } }
    this.calls.push({ method, url, path: u.pathname, query: u.searchParams, body, headers });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

    if (u.host === 'oauth2.googleapis.com' && u.pathname === '/token') {
      if (body?.grant_type === 'refresh_token') {
        if (this.refreshError) return json({ error: this.refreshError }, 400);
        return json({ access_token: `at-${++this.tokenSeq}`, expires_in: 3600 });
      }
      return json({ access_token: `at-${++this.tokenSeq}`, refresh_token: 'rt-secret-value', expires_in: 3600, scope: 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly' });
    }
    if (u.pathname === '/revoke') return json({});
    if (this.failStatus) return json({ error: { errors: [{ reason: 'backendError' }] } }, this.failStatus);
    if (u.pathname.endsWith('/users/me/calendarList/primary')) return json(this.calendars[0]);
    if (u.pathname.endsWith('/users/me/calendarList')) return json({ items: this.calendars });
    if (u.pathname.endsWith('/channels/stop')) return new Response(null, { status: 204 });
    if (u.pathname.endsWith('/events/watch')) {
      this.lastChannel = { id: String(body?.id), token: String(body?.token), address: String(body?.address) };
      return json({ resourceId: 'res-1', expiration: String(Date.now() + 7 * 864e5) });
    }
    const m = u.pathname.match(/\/calendars\/[^/]+\/events(?:\/([^/]+))?$/);
    if (!m) return json({ error: { status: 'NOT_FOUND' } }, 404);
    const id = m[1] ? decodeURIComponent(m[1]) : undefined;
    if (method === 'GET' && !id) {
      const tok = u.searchParams.get('syncToken');
      if (tok && this.gone) { this.gone = false; return json({ error: { errors: [{ reason: 'fullSyncRequired' }] } }, 410); }
      const since = tok ? Number(tok.replace('st-', '')) : -1;
      const items = [...this.events.values()].filter((e) => e.v > since && (tok || e.status !== 'cancelled'));
      return json({ items, nextSyncToken: `st-${this.version}` });
    }
    if (method === 'GET' && id) { const e = this.events.get(id); return e ? json(e) : json({ error: { status: 'NOT_FOUND' } }, 404); }
    if (method === 'POST') {
      const eid = String(body?.id);
      if (this.events.has(eid)) return json({ error: { errors: [{ reason: 'duplicate' }] } }, 409);
      return json(this.put({ ...(body as object), id: eid }));
    }
    const cur = id ? this.events.get(id) : undefined;
    if (method === 'PATCH' && id) {
      if (!cur) return json({ error: { status: 'NOT_FOUND' } }, 404);
      if (headers['if-match'] && headers['if-match'] !== cur.etag) return json({ error: { errors: [{ reason: 'conditionNotMet' }] } }, 412);
      return json(this.put({ ...(body as object), id }));
    }
    if (method === 'DELETE' && id) {
      if (!cur) return json({ error: { status: 'NOT_FOUND' } }, 404);
      this.remove(id);
      return new Response(null, { status: 204 });
    }
    return json({ error: { status: 'NOT_FOUND' } }, 404);
  };
}
