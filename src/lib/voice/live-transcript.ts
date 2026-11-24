/**
 * Live call transcript, server side.
 *
 * Source: an interface (`LiveTranscriptSource`) so the transport can change. The implementation shipped is `ElevenLabsPollingSource`: it
 * polls GET /v1/convai/conversations/{id} (documented; whether `transcript` fills while status is 'in-progress' is UNVERIFIED, see
 * voice/conversations.ts). The ElevenLabs conversation MONITORING websocket is not used: its availability depends on the plan and the
 * docs page could not be confirmed, so a source for it can be added behind the same interface without touching callers.
 * A line that pushes its own events (the webhook line) uses POST /api/voice/transcript-event instead and needs no poller.
 *
 * Sharing: demand driven. Every open viewer (SSE stream or polling fallback) asks `requestPoll(callId)` about every 2 s; a database lease
 * with a ~1.8 s TTL (`live-transcript:<callId>`, never released early) lets exactly ONE of them (across processes and instances) hit the
 * provider per window, so N viewers cost one upstream request per ~2 s, and no viewer = no polling (it stops by itself). A call stops being
 * polled when it ends, after LIVE_MAX_POLLS_PER_CALL polls (default 600 = ~20 min), or when consent is not 'disclosed'.
 *
 * Privacy: nothing is stored unless consent_status === 'disclosed'. If a caller turn objects to recording/AI/transcription mid-call
 * (callerDeclinedRecording), the call is marked 'declined' (sticky), the stored events are purged, and the poller stops for good.
 * The post-call transcript is the source of truth: `reconcileFinalTranscript` replaces the interim rows.
 */
import {
  acquireLease, appendTranscriptEvents, deleteTranscriptEvents, getCall, lastTranscriptSeq, prisma, updateCall,
} from '@/lib/db';
import type { TranscriptEventInput } from '@/lib/db/transcript';
import { fetchConversation, type ConversationFetch, type ConversationSnapshot } from '@/lib/voice/conversations';
import { callerDeclinedRecording } from '@/lib/voice/postcall';
import { logger } from '@/lib/log';
import type { Call } from '@/lib/types';

const log = logger('voice/live-transcript');

export const POLL_LEASE_MS = 1_800;
export const DEFAULT_MAX_POLLS = 600;
const maxPolls = (env: Record<string, string | undefined> = process.env): number => {
  const n = Number((env.LIVE_MAX_POLLS_PER_CALL ?? '').trim());
  return Number.isInteger(n) && n >= 1 && n <= 5000 ? n : DEFAULT_MAX_POLLS;
};

/** How a source reports a conversation. `events` are the FULL known transcript (seq = position), the poller keeps only the new ones. */
export interface LiveSnapshot { events: TranscriptEventInput[]; ended: boolean; unavailable?: boolean }
export interface LiveTranscriptSource {
  snapshot(call: Pick<Call, 'id' | 'conversation_id' | 'started_at'>): Promise<LiveSnapshot>;
}

export function snapshotToEvents(snap: ConversationSnapshot, startedAtIso: string): TranscriptEventInput[] {
  const base = snap.startUnixSecs ? snap.startUnixSecs * 1000 : new Date(startedAtIso).getTime();
  return snap.turns.map((t, i) => ({ seq: i, role: t.role === 'agent' ? 'agent' : 'caller', text: t.message, at: new Date(base + t.timeInCallSecs * 1000), is_final: true }));
}

export class ElevenLabsPollingSource implements LiveTranscriptSource {
  constructor(private readonly fetchConv: (id: string) => Promise<ConversationFetch> = (id) => fetchConversation(id)) {}
  async snapshot(call: Pick<Call, 'id' | 'conversation_id' | 'started_at'>): Promise<LiveSnapshot> {
    if (!call.conversation_id) return { events: [], ended: false, unavailable: true };
    const r = await this.fetchConv(call.conversation_id);
    if (!r.ok) return { events: [], ended: false, unavailable: true };
    const s = r.snapshot;
    const ended = s.status === 'done' || s.status === 'failed' || s.status === 'processing';
    const events = snapshotToEvents(s, call.started_at);
    // While the call runs, the LAST turn may still be growing (a caller mid-sentence): store it as interim so a later poll can replace it.
    if (!ended && events.length > 0) events[events.length - 1] = { ...events[events.length - 1], is_final: false };
    return { events, ended };
  }
}

let source: LiveTranscriptSource = new ElevenLabsPollingSource();
export const setLiveTranscriptSource = (s: LiveTranscriptSource): void => { source = s; };
export const getLiveTranscriptSource = (): LiveTranscriptSource => source;

export type PollOutcome = 'polled' | 'shared' | 'ended' | 'declined' | 'not_consented' | 'no_conversation' | 'budget_exhausted' | 'unavailable' | 'not_found';

const pollCounts = new Map<string, number>();

/** Is this call one a viewer may still watch? In progress, not ended. */
export const isLive = (c: Pick<Call, 'status' | 'ended_at'>): boolean => c.status === 'in_progress' && !c.ended_at;

/**
 * One shared upstream poll, at most one per lease window across all processes. Safe to call from every viewer on every tick.
 * Never throws.
 */
export async function requestPoll(callId: string, deps: { source?: LiveTranscriptSource; leaseMs?: number; env?: Record<string, string | undefined> } = {}): Promise<PollOutcome> {
  try {
    const call = await getCall(callId);
    if (!call) return 'not_found';
    if (call.consent_status === 'declined') { await deleteTranscriptEvents(callId); return 'declined'; }
    if (call.consent_status !== 'disclosed') return 'not_consented';
    if (!isLive(call)) return 'ended';
    if (!call.conversation_id) return 'no_conversation';
    const used = pollCounts.get(callId) ?? 0;
    if (used >= maxPolls(deps.env)) return 'budget_exhausted';
    const lease = await acquireLease(`live-transcript:${callId}`, deps.leaseMs ?? POLL_LEASE_MS);
    if (!lease) return 'shared';
    pollCounts.set(callId, used + 1);
    if (pollCounts.size > 5000) pollCounts.clear();

    const snap = await (deps.source ?? source).snapshot(call);
    if (snap.unavailable) return 'unavailable';
    const known = await lastTranscriptSeq(callId);
    // seq >= known: the newest stored row may be an interim one whose text grew; a final row is immutable (the append leaves it alone).
    const fresh = snap.events.filter((e) => e.seq >= known);
    if (fresh.length > 0) {
      // A caller who objects mid-call: sticky decline, purge, stop. Checked BEFORE anything new is stored.
      if (callerDeclinedRecording(fresh.filter((e) => e.role === 'caller').map((e) => ({ role: 'user', message: e.text })))) {
        await updateCall(callId, { consent_status: 'declined' }); // the write layer purges stored events and keeps 'declined' sticky
        await deleteTranscriptEvents(callId);
        log.info('declined_mid_call', { call: callId, business: call.business_id });
        return 'declined';
      }
      const res = await appendTranscriptEvents(callId, fresh.slice(0, 500));
      if (!res.ok && res.reason === 'consent_declined') { await deleteTranscriptEvents(callId); return 'declined'; }
    }
    return snap.ended ? 'ended' : 'polled';
  } catch (err) {
    log.warn('poll_failed', { call: callId, err: (err as Error).name });
    return 'unavailable';
  }
}

/** Forget a call's poll budget and lease row (call ended). */
export async function stopPolling(callId: string): Promise<void> {
  pollCounts.delete(callId);
  try { await prisma.provisionLock.deleteMany({ where: { key: `live-transcript:${callId}` } }); } catch { /* expires on its own */ }
}

/**
 * Post-call is the source of truth: replace whatever interim rows exist with the final transcript (ElevenLabs shape: [{role, message,
 * time_in_call_secs}]). A declined call has no rows and gets none. Never throws.
 */
export async function reconcileFinalTranscript(callId: string, transcript: unknown, startedAtIso: string, startUnixSecs?: number | null): Promise<void> {
  try {
    if (!Array.isArray(transcript)) return;
    const base = startUnixSecs ? startUnixSecs * 1000 : new Date(startedAtIso).getTime();
    const events: TranscriptEventInput[] = [];
    for (const raw of transcript as Record<string, unknown>[]) {
      const role = raw?.role === 'agent' ? 'agent' : raw?.role === 'user' ? 'caller' : null;
      const text = typeof raw?.message === 'string' ? raw.message : typeof raw?.text === 'string' ? raw.text : '';
      if (!role || !text.trim()) continue;
      const secs = Number(raw.time_in_call_secs);
      events.push({ seq: events.length, role, text, at: new Date(base + (Number.isFinite(secs) ? secs : 0) * 1000), is_final: true });
    }
    await deleteTranscriptEvents(callId);
    for (let i = 0; i < events.length; i += 500) await appendTranscriptEvents(callId, events.slice(i, i + 500));
    await stopPolling(callId);
  } catch (err) {
    log.warn('reconcile_failed', { call: callId, err: (err as Error).name });
  }
}

/** Customer calls in progress right now (the "Live now" card). Bounded. */
export async function listLiveCalls(businessId: string, now: Date = new Date()): Promise<{ id: string; caller_phone: string | null; started_at: string }[]> {
  const rows = await prisma.call.findMany({
    where: { businessId, status: 'in_progress', endedAt: null, kind: 'customer', startedAt: { gt: new Date(now.getTime() - 30 * 60_000) }, consentStatus: 'disclosed' },
    orderBy: { startedAt: 'desc' }, take: 5, select: { id: true, callerPhone: true, startedAt: true },
  });
  return rows.map((r) => ({ id: r.id, caller_phone: r.callerPhone, started_at: r.startedAt.toISOString() }));
}
