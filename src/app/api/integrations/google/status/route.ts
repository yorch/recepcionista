import { prisma } from '@/lib/db/client';
import { getCalendarConnection } from '@/lib/db/calendar';
import { fail, ok } from '@/lib/http';
import { getBlockOnBusy } from '@/lib/integrations/google/busy';
import { googleConfigured, googleMockEnabled, googleMockRefused } from '@/lib/integrations/google/config';
import { scoped } from '@/lib/integrations/google/route-helpers';
import { hasLiveChannel } from '@/lib/integrations/google/watch';

export const dynamic = 'force-dynamic';

export interface GoogleStatus {
  configured: boolean; mock: boolean; mock_refused: boolean;
  connected: boolean; status: 'none' | 'active' | 'needs_reauth' | 'revoked' | 'error';
  account_email: string | null; calendar_id: string | null; last_sync_at: string | null; last_error: string | null;
  push_channel: boolean; block_on_busy: boolean;
  /** True while blocks are NOT being applied to availability (reauth needed / disconnected). */
  ignoring_blocks: boolean;
  external_changes: { at: string; booking_id: string; change: string }[];
}

/** GET /api/integrations/google/status   Staff+ read. Never returns a token or an event title. */
export async function GET(req: Request) {
  const r = await scoped(req, 'staff');
  if (!r.ok) return r.response;
  try {
    const businessId = r.s.businessId;
    const conn = await getCalendarConnection(businessId);
    const changes = await prisma.auditEvent.findMany({
      where: { businessId, action: 'calendar.event_changed_externally', at: { gte: new Date(Date.now() - 14 * 86_400_000) } },
      orderBy: { at: 'desc' }, take: 10, select: { at: true, target: true, meta: true },
    });
    const connected = Boolean(conn && conn.status !== 'revoked');
    return ok<GoogleStatus>({
      configured: googleConfigured(), mock: googleMockEnabled(), mock_refused: googleMockRefused(),
      connected, status: conn?.status ?? 'none',
      account_email: connected ? conn!.account_email : null, calendar_id: connected ? conn!.calendar_id : null,
      last_sync_at: conn?.last_sync_at ?? null,
      last_error: conn?.last_error ? conn.last_error.replace(/^\[\d+\]\s*/, '').slice(0, 120) : null,
      push_channel: conn ? hasLiveChannel(conn) : false,
      block_on_busy: await getBlockOnBusy(businessId),
      ignoring_blocks: Boolean(conn && (conn.status === 'needs_reauth' || conn.status === 'revoked')),
      external_changes: changes.map((c) => ({ at: c.at.toISOString(), booking_id: c.target.replace(/^booking:/, ''), change: String((c.meta as { change?: unknown })?.change ?? 'changed') })),
    });
  } catch (err) {
    return fail(err, 500);
  }
}
