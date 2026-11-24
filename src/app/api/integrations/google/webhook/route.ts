import { NextResponse } from 'next/server';
import { getCalendarConnectionByChannel } from '@/lib/db/calendar';
import { safeEqualHex } from '@/lib/integrations/google/config';
import { syncConnection } from '@/lib/integrations/google/sync';
import { channelToken } from '@/lib/integrations/google/watch';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
const log = logger('gcal.webhook');

/**
 * POST /api/integrations/google/webhook   PUBLIC path (src/lib/auth.ts); authenticated by the channel itself:
 * X-Goog-Channel-ID must be a channel we created, X-Goog-Resource-ID must match, and X-Goog-Channel-Token must equal
 * HMAC(secret, connection.channel), all compared in constant time. Always answers 200 immediately (Google retries on anything else and
 * the response must not reveal which check failed); the sync runs in the background and is coalesced by the connection lease.
 * Google sends no body and no event data: this only says "something changed, go look".
 */
export async function POST(req: Request) {
  const done = () => new NextResponse(null, { status: 200, headers: { 'cache-control': 'no-store' } });
  try {
    const channelId = req.headers.get('x-goog-channel-id') ?? '';
    const resourceId = req.headers.get('x-goog-resource-id') ?? '';
    const token = req.headers.get('x-goog-channel-token') ?? '';
    const state = req.headers.get('x-goog-resource-state') ?? '';
    if (!channelId || channelId.length > 128) return done();
    const conn = await getCalendarConnectionByChannel(channelId);
    // Always run the comparison, even for an unknown channel, so timing does not tell which check failed.
    const expected = channelToken(conn?.id ?? 'unknown', channelId);
    const tokenOk = safeEqualHex(expected, token);
    const resourceOk = Boolean(conn && conn.watch_resource_id && resourceId && conn.watch_resource_id === resourceId);
    if (!conn || !tokenOk || !resourceOk) { log.warn('rejected', { known: Boolean(conn) }); return done(); }
    if (conn.status === 'active' || conn.status === 'error') {
      if (state !== 'sync') void syncConnection(conn.id).catch((err) => log.warn('sync_failed', { connection: conn.id, err }));
    }
  } catch (err) {
    log.error('failed', { err });
  }
  return done();
}
