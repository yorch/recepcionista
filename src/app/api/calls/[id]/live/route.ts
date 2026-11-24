import { getCall, listTranscriptEventsAfter } from '@/lib/db';
import { authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { acquireLiveSlot, createLiveStream, SSE_HEADERS } from '@/lib/voice/live-stream';
import { isLive, requestPoll } from '@/lib/voice/live-transcript';
import { mayStillViewCall } from '@/lib/voice/live-access';
import { fail } from '@/lib/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/calls/:id/live   Staff+, tenant-scoped (another tenant's call is a 404, exactly like a missing one).
 * Server-Sent Events of the live transcript (frames: see voice/live-stream.ts). Resume with the standard `Last-Event-ID` header (or
 * `?after=<seq>`). CSRF does not apply (GET, read-only). The session is re-validated every minute, so a revoked session or a removed
 * member stops receiving within a minute. Concurrent streams are limited per user (LIVE_MAX_PER_USER, 3) and per business
 * (LIVE_MAX_PER_BUSINESS, 20): a 429 beyond that, and the browser falls back to GET /api/calls/:id/transcript.
 * Nothing is stored or sent for a call whose recording consent is not 'disclosed'.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    const call = await getCall(id);
    requireBusinessAccess(auth.principal, call?.business_id);
    if (!call) return fail('call not found', 404);

    const url = new URL(req.url);
    const raw = req.headers.get('last-event-id') ?? url.searchParams.get('after') ?? '';
    const after = /^-?\d{1,9}$/.test(raw.trim()) ? Number(raw.trim()) : -1;

    const who = auth.principal.kind === 'user' ? `user:${auth.principal.user.id}` : `admin:${auth.sessionId ?? auth.principal.via}`;
    const release = acquireLiveSlot(who, call.business_id);
    if (!release) {
      return Response.json({ ok: false, error: 'too many live views open; close one or use the page without live updates' }, { status: 429, headers: { 'retry-after': '10', 'cache-control': 'no-store' } });
    }
    const stream = createLiveStream({
      callId: call.id, after, signal: req.signal, onClose: release,
      deps: {
        poll: (cid) => requestPoll(cid),
        listAfter: (cid, a) => listTranscriptEventsAfter(cid, a, 100, { businessId: call.business_id }),
        callState: async (cid) => { const c = await getCall(cid); return c ? { live: isLive(c), consent: c.consent_status ?? 'unknown' } : null; },
        // The same checks as the request, re-run against the live headers (see voice/live-access.ts).
        reauth: () => mayStillViewCall(req.headers, call.business_id),
      },
    });
    return new Response(stream, { status: 200, headers: SSE_HEADERS });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
