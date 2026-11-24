/** OAuth 2.0 authorization-code + PKCE helpers, and disconnect. Tokens never appear in logs, audit meta or errors. */
import { recordAudit } from '@/lib/db';
import {
  deleteEventLink, getCalendarConnection, getDecryptedTokens, listEventLinksForConnection, replaceBusyBlocks, setCalendarConnectionStatus,
  updateCalendarSyncState,
} from '@/lib/db/calendar';
import { logger } from '@/lib/log';
import type { CalendarConnection } from '@/lib/types';
import { calPath, gcal } from './api';
import {
  clientCredentials, GOOGLE_API, GOOGLE_AUTH_URL, GOOGLE_REVOKE_URL, GOOGLE_SCOPES, googleMockEnabled, redirectUri,
} from './config';
import { googleFetch, toApiError } from './http';
import { postToken, type TokenResponse } from './tokens';
import { stopChannel } from './watch';

const log = logger('gcal.oauth');

export function buildAuthUrl(state: string, challenge: string, loginHint?: string): string {
  const u = new URL(GOOGLE_AUTH_URL);
  const p = u.searchParams;
  p.set('client_id', clientCredentials().id || 'mock-client');
  p.set('redirect_uri', redirectUri());
  p.set('response_type', 'code');
  p.set('scope', GOOGLE_SCOPES.join(' '));
  p.set('access_type', 'offline');
  p.set('prompt', 'consent');
  p.set('include_granted_scopes', 'false');
  p.set('state', state);
  p.set('code_challenge', challenge);
  p.set('code_challenge_method', 'S256');
  if (loginHint) p.set('login_hint', loginHint);
  return u.toString();
}

export const exchangeCode = (code: string, verifier: string): Promise<TokenResponse> =>
  postToken({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri() });

/** The Google account's address = the id of its primary calendar (needs only the calendarlist scope). */
export async function fetchPrimary(accessToken: string): Promise<{ email: string; timeZone?: string }> {
  const res = await googleFetch(`${GOOGLE_API}/users/me/calendarList/primary`, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw await toApiError(res);
  const j = (await res.json()) as { id?: string; timeZone?: string };
  if (!j.id) throw new Error('google returned no primary calendar');
  return { email: j.id, timeZone: j.timeZone };
}

export const mockMode = googleMockEnabled;

/** Switch the synced calendar: forget the old sync state, drop mirrored blocks, remove events pushed to the OLD calendar (re-pushed to the new one by the reconcile job). */
export async function changeCalendar(conn: CalendarConnection, calendarId: string): Promise<void> {
  if (calendarId === conn.calendar_id) return;
  await stopChannel(conn.id, conn.watch_channel_id, conn.watch_resource_id);
  for (const l of await listEventLinksForConnection(conn.id, 5000)) {
    try { await gcal(conn.id, 'DELETE', `${calPath(conn.calendar_id)}/events/${encodeURIComponent(l.google_event_id)}`); } catch { /* best effort: the link goes either way */ }
    await deleteEventLink(l.booking_id);
  }
  await replaceBusyBlocks(conn.id, []);
  await updateCalendarSyncState(conn.id, { calendar_id: calendarId, sync_token: null, watch_channel_id: null, watch_resource_id: null, watch_expires_at: null, last_sync_at: null, last_error: null });
}

/**
 * Disconnect: stop the push channel, revoke the token at Google, wipe tokens + sync state + busy blocks locally.
 * `deleteEvents`: also remove the booking events we pushed from the owner's calendar (default: they stay, they are the owner's appointments).
 */
export async function disconnectGoogle(businessId: string, actor: { user_id: string | null; kind: 'user' | 'admin_token'; ip?: string | null }, deleteEvents = false): Promise<boolean> {
  const conn = await getCalendarConnection(businessId);
  if (!conn || conn.status === 'revoked') return false;
  try { await stopChannel(conn.id, conn.watch_channel_id, conn.watch_resource_id); } catch { /* best effort */ }
  if (deleteEvents) {
    for (const l of await listEventLinksForConnection(conn.id, 5000)) {
      try { await gcal(conn.id, 'DELETE', `${calPath(conn.calendar_id)}/events/${encodeURIComponent(l.google_event_id)}`); } catch { /* best effort */ }
      await deleteEventLink(l.booking_id);
    }
  }
  try {
    const t = await getDecryptedTokens(conn.id);
    const token = t?.refresh_token ?? t?.access_token;
    if (token) {
      const res = await googleFetch(GOOGLE_REVOKE_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString() });
      if (!res.ok) log.warn('revoke_failed', { connection: conn.id, status: res.status });
    }
  } catch (err) { log.warn('revoke_failed', { connection: conn.id, err }); }
  await setCalendarConnectionStatus(conn.id, 'revoked', null); // wipes tokens, sync token, channel, busy blocks
  await recordAudit({ actor_kind: actor.kind, actor_user_id: actor.user_id, business_id: businessId, action: 'calendar.disconnected', target: `calendar:${conn.id}`, ip: actor.ip ?? null, meta: { events_deleted: deleteEvents } });
  return true;
}
