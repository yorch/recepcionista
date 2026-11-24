import { NextResponse } from 'next/server';
import { claimEvent, recordAudit } from '@/lib/db';
import { upsertCalendarConnection } from '@/lib/db/calendar';
import { readCookie } from '@/lib/auth';
import { appBase, googleMockRefused } from '@/lib/integrations/google/config';
import { exchangeCode, fetchPrimary, resetForNewAccount } from '@/lib/integrations/google/oauth';
import { scoped } from '@/lib/integrations/google/route-helpers';
import { openVerifier, PKCE_COOKIE, verifyState } from '@/lib/integrations/google/state';
import { syncConnection } from '@/lib/integrations/google/sync';
import { ensureWatch } from '@/lib/integrations/google/watch';
import { GOOGLE_SCOPES } from '@/lib/integrations/google/config';
import { logger } from '@/lib/log';
import { fail } from '@/lib/http';

export const dynamic = 'force-dynamic';
const log = logger('gcal.callback');

function back(result: string, extra: Record<string, string> = {}): NextResponse {
  const q = new URLSearchParams({ gcal: result, ...extra });
  const res = NextResponse.redirect(`${appBase()}/dashboard/settings?${q}#google-calendar`, 302);
  res.cookies.set(PKCE_COOKIE, '', { path: '/api/integrations/google', maxAge: 0 });
  res.headers.set('cache-control', 'no-store');
  return res;
}

/**
 * GET /api/integrations/google/callback   OWNER session (the browser's cookie rides the top-level redirect).
 * Validates state (signature, expiry, user + business + session binding, single use) and the PKCE cookie, exchanges the code,
 * stores the tokens ENCRYPTED, then sends the owner to Settings to pick the calendar. Tokens are never logged or put in a URL.
 */
export async function GET(req: Request) {
  if (googleMockRefused()) return fail('GOOGLE_OAUTH_MOCK is not allowed in production', 503);
  const r = await scoped(req, 'owner');
  if (!r.ok) return r.response;
  const { s } = r;
  const q = new URL(req.url).searchParams;
  const st = verifyState(q.get('state'));
  if (!st || st.b !== s.businessId || st.u !== s.actor.user_id || st.s !== s.sessionId) return back('error', { reason: 'state' });
  if (q.get('error')) {
    await recordAudit({ actor_kind: s.actor.kind, actor_user_id: s.actor.user_id, business_id: s.businessId, action: 'calendar.connect_denied', target: `business:${s.businessId}`, ip: s.ip, meta: { reason: String(q.get('error')).slice(0, 60) } });
    return back('denied');
  }
  const code = q.get('code');
  const verifier = openVerifier(readCookie(req.headers.get('cookie'), PKCE_COOKIE), st.n);
  if (!code || !verifier) return back('error', { reason: 'state' });
  if (!(await claimEvent('gcal-state', st.n, 60_000))) return back('error', { reason: 'replay' }); // a state is single use
  try {
    const tok = await exchangeCode(code, verifier);
    if (!tok.refresh_token) return back('error', { reason: 'no_refresh_token' });
    const granted = (tok.scope ?? '').split(/\s+/);
    if (tok.scope && !GOOGLE_SCOPES.every((sc) => granted.includes(sc))) return back('error', { reason: 'scopes' });
    const primary = await fetchPrimary(tok.access_token);
    // A different Google account than before: first clean the old account's pushed events / blocks (through the old tokens).
    // The SAME account keeps the calendar the owner picked (upsertCalendarConnection leaves calendar_id alone on a reconnect).
    const leftBehind = await resetForNewAccount(s.businessId, primary.email);
    const conn = await upsertCalendarConnection({
      business_id: s.businessId, connected_by_user_id: s.actor.user_id, account_email: primary.email, calendar_id: 'primary',
      access_token: tok.access_token, refresh_token: tok.refresh_token, token_expires_at: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000), scopes: tok.scope ?? GOOGLE_SCOPES.join(' '),
    });
    await recordAudit({ actor_kind: s.actor.kind, actor_user_id: s.actor.user_id, business_id: s.businessId, action: 'calendar.connected', target: `calendar:${conn.id}`, ip: s.ip, meta: { account: primary.email, ...(leftBehind !== null ? { account_changed: true, old_events_not_deleted: leftBehind } : {}) } });
    void (async () => { try { await ensureWatch(conn.id); await syncConnection(conn.id); } catch (err) { log.warn('post_connect_failed', { connection: conn.id, err }); } })();
    return back('connected', { pick: '1' });
  } catch (err) {
    log.warn('exchange_failed', { business: s.businessId, err });
    await recordAudit({ actor_kind: s.actor.kind, actor_user_id: s.actor.user_id, business_id: s.businessId, action: 'calendar.connect_failed', target: `business:${s.businessId}`, ip: s.ip });
    return back('error', { reason: 'exchange' });
  }
}
