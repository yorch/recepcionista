import { fail, ok } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { getBusiness, listKbChanges, type Page } from '@/lib/db';
import { publicKbChange, type PublicKbChange } from '@/lib/voice/owner/view';
import type { OwnerKbStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

const STATUSES: readonly OwnerKbStatus[] = ['proposed', 'applied', 'reverted', 'rejected'];

/**
 * GET /api/businesses/:id/kb-changes?cursor=&limit=&status=   Owner only, own business only, newest first, cursor-paginated.
 * The voice / SMS / dashboard changes to what the assistant knows, with their status. Patches are summarised (`touches`), never dumped.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    if (!(await getBusiness(id))) return fail('business not found', 404);
    const q = new URL(req.url).searchParams;
    const status = q.get('status');
    if (status && !STATUSES.includes(status as OwnerKbStatus)) return fail('invalid status', 422);
    const page = await listKbChanges(id, { cursor: q.get('cursor'), limit: Number(q.get('limit') ?? '') || undefined, status: (status as OwnerKbStatus | null) ?? undefined });
    return ok<Page<PublicKbChange>>({ items: page.items.map(publicKbChange), next_cursor: page.next_cursor });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
