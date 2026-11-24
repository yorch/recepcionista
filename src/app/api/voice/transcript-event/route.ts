/**
 * POST /api/voice/transcript-event: a line that PUSHES its own live transcript lines (the webhook line) instead of being polled.
 * Auth: the shared tool secret (x-recepcionista-tool-secret), like the tool webhooks. Body:
 *   { call_id | call_sid | conversation_id, events: [{ seq, role: 'agent'|'caller'|'system', text, at?, is_final? }] }
 * The call is found by its keys and the tenant is that call's business (nothing tenant-related is taken from the body). Idempotent by seq.
 * Nothing is stored unless the call's consent is 'disclosed'; a caller line that objects to recording declines the call and purges it
 * (the same rule as the poller). The post-call transcript replaces these rows later.
 */
import { appendTranscriptEvents, deleteTranscriptEvents, getCall, getCallBySid, getCallByConversationId, updateCall } from '@/lib/db';
import { verifyToolSecret } from '@/lib/voice/elevenlabs';
import { callerDeclinedRecording } from '@/lib/voice/postcall';
import { logger } from '@/lib/log';
import type { TranscriptRole } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const log = logger('voice/transcript-event');
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export async function POST(req: Request): Promise<Response> {
  const auth = verifyToolSecret(req);
  if (!auth.ok) return json({ ok: false, error: 'unauthorized' }, 401);
  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { return json({ ok: false, error: 'invalid JSON body' }, 400); }
  const events = Array.isArray(body.events) ? (body.events as Record<string, unknown>[]) : null;
  if (!events || events.length === 0 || events.length > 200) return json({ ok: false, error: 'events must be 1-200 items' }, 422);

  const id = str(body.call_id); const sid = str(body.call_sid); const conv = str(body.conversation_id);
  const call = (id ? await getCall(id) : null) ?? (sid ? await getCallBySid(sid) : null) ?? (conv ? await getCallByConversationId(conv) ?? await getCallBySid(conv) : null);
  if (!call) return json({ ok: false, error: 'call not found' }, 404);
  if (call.status !== 'in_progress' || call.ended_at) return json({ ok: true, stored: 0, ignored: 'call_not_live' });
  if (call.consent_status !== 'disclosed') return json({ ok: true, stored: 0, ignored: 'consent_not_disclosed' });

  const parsed = events.map((e) => ({
    seq: Number(e?.seq), role: String(e?.role ?? '') as TranscriptRole, text: typeof e?.text === 'string' ? e.text : '',
    at: e?.at ? new Date(String(e.at)) : new Date(), is_final: e?.is_final !== false,
  }));
  if (callerDeclinedRecording(parsed.filter((e) => e.role === 'caller').map((e) => ({ role: 'user', message: e.text })))) {
    await updateCall(call.id, { consent_status: 'declined' });
    await deleteTranscriptEvents(call.id);
    log.info('declined_mid_call', { call: call.id, business: call.business_id });
    return json({ ok: true, stored: 0, declined: true });
  }
  const res = await appendTranscriptEvents(call.id, parsed);
  if (!res.ok) return json({ ok: false, error: res.reason }, res.reason === 'consent_declined' ? 200 : 422);
  return json({ ok: true, stored: res.stored, skipped: res.skipped });
}
