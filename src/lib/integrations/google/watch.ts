/** events.watch push channels: create, renew (new channel first, then stop the old one), stop. HTTPS only (Google refuses http). */
import crypto from 'node:crypto';
import { getCalendarConnectionById, updateCalendarSyncState } from '@/lib/db/calendar';
import { logger } from '@/lib/log';
import type { CalendarConnection } from '@/lib/types';
import { calPath, gcal } from './api';
import { hmac, safeEqualHex, webhookUrl } from './config';
import { toApiError } from './http';

const log = logger('gcal.watch');
/** Renew when fewer than this remains. */
export const RENEW_BEFORE_MS = 24 * 3600_000;
const REQUEST_TTL_MS = 7 * 24 * 3600_000;

export const channelToken = (connectionId: string, channelId: string): string => hmac('channel', `${connectionId}.${channelId}`);

export const watchPossible = (): boolean => webhookUrl().startsWith('https://');

/** Constant-time check of the token Google echoes back in X-Goog-Channel-Token. */
export function verifyChannelToken(connectionId: string, channelId: string, token: string | null | undefined): boolean {
  return Boolean(token) && safeEqualHex(channelToken(connectionId, channelId), String(token));
}

export async function stopChannel(connectionId: string, channelId: string | null, resourceId: string | null): Promise<void> {
  if (!channelId || !resourceId) return;
  try {
    const res = await gcal(connectionId, 'POST', '/channels/stop', { body: { id: channelId, resourceId } });
    if (!res.ok && res.status !== 404) log.warn('channel_stop_failed', { connection: connectionId, status: res.status });
  } catch (err) { log.warn('channel_stop_failed', { connection: connectionId, err }); }
}

/** Create (or renew) the channel. No-op without an https webhook URL (polling still covers the connection). Returns whether a channel is live. */
export async function ensureWatch(connectionId: string, opts: { force?: boolean; now?: Date } = {}): Promise<boolean> {
  const conn = await getCalendarConnectionById(connectionId);
  if (!conn || conn.status !== 'active' || !watchPossible()) return false;
  const now = opts.now ?? new Date();
  if (!opts.force && conn.watch_channel_id && conn.watch_expires_at && new Date(conn.watch_expires_at).getTime() - now.getTime() > RENEW_BEFORE_MS) return true;
  const channelId = crypto.randomUUID();
  const res = await gcal(conn.id, 'POST', `${calPath(conn.calendar_id)}/events/watch`, {
    body: { id: channelId, type: 'web_hook', address: webhookUrl(), token: channelToken(conn.id, channelId), expiration: String(now.getTime() + REQUEST_TTL_MS) },
  });
  if (!res.ok) throw await toApiError(res);
  const j = (await res.json()) as { resourceId?: string; expiration?: string };
  const expires = j.expiration ? new Date(Number(j.expiration)) : new Date(now.getTime() + REQUEST_TTL_MS);
  await updateCalendarSyncState(conn.id, { watch_channel_id: channelId, watch_resource_id: j.resourceId ?? null, watch_expires_at: expires });
  await stopChannel(conn.id, conn.watch_channel_id, conn.watch_resource_id); // overlap is allowed; the old one is no longer needed
  return true;
}

export const hasLiveChannel = (c: CalendarConnection, now: Date = new Date()): boolean =>
  Boolean(c.watch_channel_id && c.watch_expires_at && new Date(c.watch_expires_at) > now);
