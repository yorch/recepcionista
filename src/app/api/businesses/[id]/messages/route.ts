import { fail, ok } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { getBusiness } from '@/lib/db';
import { getInboxPage } from '@/lib/messaging/inbox-view';
import { INBOUND_STATUSES, type InboundStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** GET ?status=new|handled|ignored (omit = all) &cursor= &limit=  The business's inbox of customer texts. Owner or staff of this business. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    if (!(await getBusiness(id))) return fail('business not found', 404);
    const q = new URL(req.url).searchParams;
    const raw = q.get('status');
    if (raw && raw !== 'all' && !(INBOUND_STATUSES as readonly string[]).includes(raw)) return fail('status must be new, handled, ignored or all', 422);
    const status = raw && raw !== 'all' ? (raw as InboundStatus) : undefined;
    return ok(await getInboxPage(id, { status, cursor: q.get('cursor'), limit: Number(q.get('limit')) || undefined }));
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
