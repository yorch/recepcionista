import { getCall, listTranscriptEventsAfter } from '@/lib/db';
import { authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { isLive, requestPoll } from '@/lib/voice/live-transcript';
import { NextResponse } from 'next/server';
import { fail } from '@/lib/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/calls/:id/transcript?after=<seq>   Staff+, tenant-scoped. Polling fallback of the live stream: the events with seq > after
 * (default all), plus whether the call is still live. It also asks for the shared upstream poll (deduplicated by a lease), so a client that
 * cannot hold an SSE connection costs the provider no more than a viewer that can. A call without recording consent returns no events.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    const call = await getCall(id);
    requireBusinessAccess(auth.principal, call?.business_id);
    if (!call) return fail('call not found', 404);
    const q = new URL(req.url).searchParams;
    const afterRaw = q.get('after') ?? '';
    const after = /^-?\d{1,9}$/.test(afterRaw.trim()) ? Number(afterRaw.trim()) : -1;
    const outcome = await requestPoll(call.id);
    const fresh = (await getCall(call.id)) ?? call;
    const consented = fresh.consent_status === 'disclosed';
    const events = consented ? await listTranscriptEventsAfter(call.id, after, 200, { businessId: call.business_id }) : [];
    return NextResponse.json({ ok: true, data: {
      events,
      next_after: events.length ? events[events.length - 1].seq : after,
      live: isLive(fresh) && outcome !== 'ended' && outcome !== 'declined',
      consent: fresh.consent_status ?? 'unknown',
      status: fresh.status,
    } }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
