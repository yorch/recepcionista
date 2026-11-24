import { fail, ok } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess, scopeBusinessId } from '@/lib/session';
import { getBusiness, listCallsPage } from '@/lib/db';
import type { Page } from '@/lib/db/paging';
import { publicCall, type PublicCall } from '@/lib/voice/voicemail';

export const dynamic = 'force-dynamic';

/**
 * GET /api/calls?cursor=&limit=[&voicemail=1]  Staff+, newest first, cursor-paginated and scoped to the caller's business.
 * `voicemail=1` lists only calls that left a voicemail. Calls are returned WITHOUT `recording_url` (a credentialed provider URL is
 * never sent to a browser); `has_voicemail` says there is something to play at GET /api/calls/:id/voicemail.
 */
export async function GET(req: Request) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  try {
    const q = new URL(req.url).searchParams;
    const businessId = scopeBusinessId(auth.principal, q.get('business_id'));
    if (!businessId) return fail('business_id is required', 422);
    requireBusinessAccess(auth.principal, businessId);
    if (!(await getBusiness(businessId))) return fail('business not found', 404);
    const page = await listCallsPage(businessId, {
      cursor: q.get('cursor'), limit: Number(q.get('limit') ?? '') || undefined, voicemailOnly: q.get('voicemail') === '1',
    });
    return ok<Page<PublicCall>>({ items: page.items.map(publicCall), next_cursor: page.next_cursor });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
