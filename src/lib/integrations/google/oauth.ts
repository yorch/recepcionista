/** OAuth 2.0 authorization-code + PKCE helpers, and disconnect. Tokens never appear in logs, audit meta or errors. */
import { recordAudit } from '@/lib/db';
import { prisma } from '@/lib/db/client';
import { withLease } from '@/lib/db/locks';
import {
  deleteEventLink, getCalendarConnection, getCalendarConnectionById, getDecryptedTokens, listEventLinksForConnection, recordOrphanedEvents, replaceBusyBlocks, setCalendarConnectionStatus,
  updateCalendarSyncState,
} from '@/lib/db/calendar';
import { logger } from '@/lib/log';
import type { CalendarConnection, CalendarEventLink } from '@/lib/types';
import { calPath, gcal } from './api';
import {
  clientCredentials, GOOGLE_API, GOOGLE_AUTH_URL, GOOGLE_REVOKE_URL, GOOGLE_SCOPES, googleMockEnabled, redirectUri,
} from './config';
import { googleFetch, toApiError } from './http';
import { postToken, type TokenResponse } from './tokens';
import { stopChannel } from './watch';

const log = logger('gcal.oauth');

/** The calendar is being synced right now and did not free up in time; the caller answers 409 and the owner tries again. */
export class SyncBusyError extends Error {
  constructor() { super('google calendar is syncing, try again in a moment'); this.name = 'SyncBusyError'; }
}
const SYNC_LEASE_KEY = (connectionId: string) => `gcal-sync:${connectionId}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn` while holding the connection's sync lease (the same `gcal-sync:<id>` lease syncConnection takes), waiting up to `waitMs`
 * for a running sync to finish. A calendar switch or an account change must not interleave with a sync that is writing the OLD
 * calendar's blocks and token. Throws SyncBusyError when the lease did not free up.
 */
export async function withSyncLease<T>(connectionId: string, fn: () => Promise<T>, waitMs = 20_000): Promise<T> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const r = await withLease(SYNC_LEASE_KEY(connectionId), 3 * 60_000, fn);
    if (r.acquired) return r.value;
    if (Date.now() >= deadline) throw new SyncBusyError();
    await sleep(200);
  }
}

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
export async function changeCalendar(connection: CalendarConnection, calendarId: string): Promise<void> {
  await withSyncLease(connection.id, async () => {
    // re-read under the lease: a sync that just finished may have stored a channel / token we must clean up
    const conn = (await getCalendarConnectionById(connection.id)) ?? connection;
    if (conn.status === 'revoked' || calendarId === conn.calendar_id) return;
    await dropRemoteState(conn, 'calendar_changed');
    await updateCalendarSyncState(conn.id, { calendar_id: calendarId, sync_token: null, watch_channel_id: null, watch_resource_id: null, watch_expires_at: null, last_sync_at: null, last_error: null });
  });
}

/**
 * Remember the pushed events that could not be deleted (the tokens are dead or Google refused), so the owner is told to remove them by hand.
 * Business-side facts only (service + start time of the booking); no token is kept. Never throws.
 */
async function rememberUndeleted(conn: CalendarConnection, links: CalendarEventLink[], reason: 'account_changed' | 'calendar_changed' | 'disconnected'): Promise<void> {
  if (links.length === 0) return;
  try {
    const bookings = await prisma.booking.findMany({ where: { id: { in: links.map((l) => l.booking_id) }, businessId: conn.business_id }, select: { id: true, service: true, scheduledAt: true } });
    const byId = new Map(bookings.map((b) => [b.id, b]));
    await recordOrphanedEvents(conn.business_id, links.map((l) => ({
      booking_id: l.booking_id, google_event_id: l.google_event_id, calendar_id: conn.calendar_id, account_email: conn.account_email,
      service: byId.get(l.booking_id)?.service ?? '', starts_at: byId.get(l.booking_id)?.scheduledAt ?? null, reason,
    })));
  } catch (err) { log.warn('orphans_not_recorded', { connection: conn.id, err }); }
}

/** Stop the push channel, delete the events we pushed to the current calendar (best effort; the links go either way) and drop the mirrored blocks. */
async function dropRemoteState(conn: CalendarConnection, reason: 'account_changed' | 'calendar_changed' = 'account_changed'): Promise<number> {
  await stopChannel(conn.id, conn.watch_channel_id, conn.watch_resource_id);
  const undeleted: CalendarEventLink[] = [];
  for (const l of await listEventLinksForConnection(conn.id, 5000)) {
    try {
      const res = await gcal(conn.id, 'DELETE', `${calPath(conn.calendar_id)}/events/${encodeURIComponent(l.google_event_id)}`);
      if (!res.ok && res.status !== 404 && res.status !== 410) undeleted.push(l);
    } catch { undeleted.push(l); }
    await deleteEventLink(l.booking_id);
  }
  // A DISCONNECTED row's events were left in the owner's calendar on purpose (their appointments): only a live connection owes a cleanup.
  if (conn.status !== 'revoked') await rememberUndeleted(conn, undeleted, reason);
  await replaceBusyBlocks(conn.id, []);
  return undeleted.length;
}

/**
 * Reconnecting with a DIFFERENT Google account: the pushed events live in the old account and the stored calendar id means nothing
 * in the new one. Delete them through the old tokens (still on the row until the upsert replaces them), drop the links and blocks.
 * Events that could not be deleted (the old tokens are dead) are counted and audited by the caller; this is the documented residual.
 * Returns the number of events that could not be removed, or null when nothing needed doing.
 */
export async function resetForNewAccount(businessId: string, newAccountEmail: string): Promise<number | null> {
  const conn = await getCalendarConnection(businessId);
  if (!conn || conn.account_email === newAccountEmail.trim().toLowerCase()) return null;
  return withSyncLease(conn.id, async () => {
    const fresh = await getCalendarConnectionById(conn.id);
    if (!fresh) return null;
    return dropRemoteState(fresh).catch(() => -1);
  });
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
    const undeleted: CalendarEventLink[] = [];
    for (const l of await listEventLinksForConnection(conn.id, 5000)) {
      try {
        const res = await gcal(conn.id, 'DELETE', `${calPath(conn.calendar_id)}/events/${encodeURIComponent(l.google_event_id)}`);
        if (!res.ok && res.status !== 404 && res.status !== 410) undeleted.push(l);
      } catch { undeleted.push(l); /* best effort: remembered below */ }
      await deleteEventLink(l.booking_id);
    }
    await rememberUndeleted(conn, undeleted, 'disconnected');
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
