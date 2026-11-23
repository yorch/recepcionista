import { NextResponse } from 'next/server';
import { authenticate } from '@/lib/session';
import { listAuditEvents } from '@/lib/db';
import { teamError } from '@/lib/team';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Audit trail, newest first, cursor-paginated (`before` = the `next_before` of the previous page, `limit` 1-100).
 * Owners always get their own business (a different `business_id` is a 404). Admins get the named business, or
 * every event with `business_id` omitted. Staff: 403.
 */
export async function GET(req: Request) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  const url = new URL(req.url);
  const requested = url.searchParams.get('business_id');
  const before = url.searchParams.get('before') ?? undefined;
  if (before && Number.isNaN(new Date(before).getTime())) return teamError(422, 'before must be an ISO timestamp');
  const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '50', 10) || 50));
  const { principal } = auth;
  let businessId: string | undefined;
  if (principal.kind === 'user') {
    if (requested && requested !== principal.business_id) return teamError(404, 'business not found');
    businessId = principal.business_id;
  } else {
    businessId = requested || undefined;
  }
  const rows = await listAuditEvents({ business_id: businessId, before, limit: limit + 1 });
  const events = rows.slice(0, limit);
  return NextResponse.json({
    ok: true,
    data: { events, next_before: rows.length > limit ? events[events.length - 1].at : null },
  });
}
