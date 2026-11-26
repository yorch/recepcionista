import { fail, ok } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { getBusiness } from '@/lib/db';
import { getMessageLog } from '@/lib/messaging/inbox-view';

export const dynamic = 'force-dynamic';

/** GET ?direction=out|in &cursor= &limit=  The business's text log (outbound: every text we sent or blocked, with its status; inbound: what customers wrote). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    if (!(await getBusiness(id))) return fail('business not found', 404);
    const q = new URL(req.url).searchParams;
    const direction = q.get('direction') === 'in' ? 'in' : 'out';
    return ok(await getMessageLog(id, { direction, cursor: q.get('cursor'), limit: Number(q.get('limit')) || undefined }));
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
