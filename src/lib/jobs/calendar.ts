/**
 * Google Calendar job (every tick; per-connection work is gated by its own schedule + lease):
 *  - fallback poll: sync each healthy connection every POLL_EVERY_MS (push notifications are an optimisation, not a guarantee);
 *  - failing connections back off exponentially (15 min x 2^(n-1), capped at 6 h) and become needs_reauth after FAILURES_BEFORE_REAUTH;
 *  - watch renewal before expiry (RENEW_BEFORE_MS ahead);
 *  - reconcile: push upcoming bookings that are missing/stale in Google (retries failed pushes, backfills after a reconnect);
 *  - privacy sweep: delete Google events of anonymised bookings.
 */
import { listCalendarConnections } from '@/lib/db/calendar';
import { logger } from '@/lib/log';
import type { CalendarConnection } from '@/lib/types';
import { reconcileConnection } from '@/lib/integrations/google/push';
import { redactAnonymizedBookingEvents } from '@/lib/integrations/google/privacy';
import { failureCount, syncConnection } from '@/lib/integrations/google/sync';
import { ensureWatch, RENEW_BEFORE_MS } from '@/lib/integrations/google/watch';
import { googleConfigured } from '@/lib/integrations/google/config';

const log = logger('jobs.calendar');
export const POLL_EVERY_MS = 15 * 60_000;
export const MAX_BACKOFF_MS = 6 * 3600_000;
export const MAX_CONNECTIONS_PER_TICK = 20;

export interface CalendarJobResult { processed: number; errors: number; items: { business_id?: string; outcome: string; detail?: Record<string, unknown> }[]; counts: Record<string, number> }

/** Pure: is this connection due for its next poll? */
export function pollDue(c: CalendarConnection, now: Date): boolean {
  if (c.status !== 'active' && c.status !== 'error') return false;
  if (c.status === 'error') {
    const n = Math.max(1, failureCount(c.last_error));
    const wait = Math.min(MAX_BACKOFF_MS, POLL_EVERY_MS * 2 ** (n - 1));
    return now.getTime() - new Date(c.updated_at).getTime() >= wait;
  }
  return !c.last_sync_at || now.getTime() - new Date(c.last_sync_at).getTime() >= POLL_EVERY_MS;
}

export async function runGoogleCalendarWork(opts: { now?: Date; force?: boolean } = {}): Promise<CalendarJobResult> {
  const now = opts.now ?? new Date();
  const out: CalendarJobResult = { processed: 0, errors: 0, items: [], counts: { synced: 0, renewed: 0, pushed: 0, redacted: 0, failed: 0 } };
  if (!googleConfigured()) return out;
  const all = [...(await listCalendarConnections({ status: 'active' })), ...(await listCalendarConnections({ status: 'error' }))];
  let n = 0;
  for (const c of all) {
    if (n >= MAX_CONNECTIONS_PER_TICK) break;
    const needsRenewal = c.status === 'active' && (!c.watch_expires_at || new Date(c.watch_expires_at).getTime() - now.getTime() < RENEW_BEFORE_MS);
    if (!opts.force && !pollDue(c, now) && !needsRenewal) continue;
    n++;
    try {
      if (opts.force || pollDue(c, now)) {
        const r = await syncConnection(c.id, { now });
        if (r.outcome === 'synced') {
          out.counts.synced++;
          const rec = await reconcileConnection({ ...c, status: 'active' }, 100, now);
          out.counts.pushed += rec.pushed;
          out.counts.failed += rec.failed;
        } else if (r.outcome === 'failed') { out.errors++; out.counts.failed++; }
        out.items.push({ business_id: c.business_id, outcome: r.outcome });
      }
      if (needsRenewal) { if (await ensureWatch(c.id, { now })) out.counts.renewed++; }
      out.processed++;
    } catch (err) {
      out.errors++;
      log.warn('connection_failed', { connection: c.id, err });
      out.items.push({ business_id: c.business_id, outcome: 'error' });
    }
  }
  const red = await redactAnonymizedBookingEvents(100);
  out.counts.redacted = red.deleted;
  return out;
}
