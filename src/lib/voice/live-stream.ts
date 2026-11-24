/**
 * Server-Sent Events body for GET /api/calls/:id/live (kept out of the route so it can be driven with a fake clock / fake source in tests).
 *
 * Frames: `retry: 3000` once; `event: status` (live / ended / declined) on change; `event: transcript` with `id: <seq>` per utterance (the
 * browser sends the last id back as Last-Event-ID when it reconnects, so a resume never repeats or skips a line); `: hb` comments as a
 * heartbeat; `event: auth` then close when the session is no longer valid (re-checked every `reauthMs`); `event: ended` then close when
 * the call is over and everything was delivered; `event: reconnect` at the maximum lifetime. Backpressure: a tick is skipped while the
 * client has not drained the previous frame; a client stalled for `maxStalledTicks` ticks is dropped. Each tick also asks for the shared
 * upstream poll (voice/live-transcript.ts requestPoll), which is deduplicated across all viewers by a lease.
 */
import type { TranscriptEvent } from '@/lib/types';
import type { PollOutcome } from '@/lib/voice/live-transcript';

export interface LiveStreamDeps {
  poll(callId: string): Promise<PollOutcome>;
  listAfter(callId: string, after: number): Promise<TranscriptEvent[]>;
  callState(callId: string): Promise<{ live: boolean; consent: string } | null>;
  reauth(): Promise<boolean>;
}
export interface LiveStreamOptions {
  callId: string;
  after: number;
  signal?: AbortSignal;
  deps: LiveStreamDeps;
  tickMs?: number;
  heartbeatMs?: number;
  reauthMs?: number;
  maxLifetimeMs?: number;
  maxStalledTicks?: number;
  onClose?: () => void;
}

export const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-store, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
  'x-content-type-options': 'nosniff',
} as const;

const enc = new TextEncoder();
const frame = (event: string | null, data: unknown, id?: number): Uint8Array =>
  enc.encode(`${id !== undefined ? `id: ${id}\n` : ''}${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`);

export function createLiveStream(o: LiveStreamOptions): ReadableStream<Uint8Array> {
  const tick = o.tickMs ?? 2_000;
  const beat = o.heartbeatMs ?? 15_000;
  const reauthEvery = o.reauthMs ?? 60_000;
  const lifetime = o.maxLifetimeMs ?? 25 * 60_000;
  const maxStalled = o.maxStalledTicks ?? 15;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  const finish = () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    try { controllerRef?.close(); } catch { /* already closed */ }
    o.onClose?.();
  };
  o.signal?.addEventListener('abort', finish, { once: true });

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      const startedAt = Date.now();
      let cursor = o.after;
      let lastBeat = Date.now();
      let lastAuth = Date.now();
      let lastStatus = '';
      let stalled = 0;
      let endedDelivered = false;
      controller.enqueue(enc.encode('retry: 3000\n\n'));

      const send = (chunk: Uint8Array): boolean => {
        if (closed) return false;
        if ((controller.desiredSize ?? 1) <= 0) return false; // backpressure: the client has not read the last frame
        controller.enqueue(chunk);
        lastBeat = Date.now();
        return true;
      };

      const run = async () => {
        if (closed) return;
        try {
          if (Date.now() - startedAt >= lifetime) { send(frame('reconnect', { after: cursor })); return finish(); }
          if (Date.now() - lastAuth >= reauthEvery) {
            if (!(await o.deps.reauth())) { send(frame('auth', { error: 'session ended' })); return finish(); }
            lastAuth = Date.now();
          }
          if ((controller.desiredSize ?? 1) <= 0) {
            if (++stalled >= maxStalled) return finish();
          } else {
            stalled = 0;
            const outcome = await o.deps.poll(o.callId);
            const st = await o.deps.callState(o.callId);
            if (!st) { send(frame('ended', { reason: 'gone' })); return finish(); }
            if (outcome === 'declined' || st.consent === 'declined') { send(frame('status', { state: 'declined', live: false })); send(frame('ended', { reason: 'declined' })); return finish(); }
            const events = await o.deps.listAfter(o.callId, cursor);
            for (const e of events) { if (!send(frame('transcript', e, e.seq))) break; cursor = e.seq; }
            const live = st.live && outcome !== 'ended';
            const statusKey = `${live}:${st.consent}`;
            if (statusKey !== lastStatus && send(frame('status', { state: live ? 'live' : 'ended', live, consent: st.consent }))) lastStatus = statusKey;
            if (!live && events.length === 0 && !endedDelivered) { endedDelivered = send(frame('ended', { reason: 'call_ended', last_seq: cursor })); if (endedDelivered) return finish(); }
          }
          if (Date.now() - lastBeat >= beat) send(enc.encode(': hb\n\n'));
        } catch {
          send(enc.encode(': error\n\n'));
        }
        if (!closed) timer = setTimeout(() => { void run(); }, tick);
      };
      void run();
    },
    cancel() { finish(); },
  }, { highWaterMark: 4 });
}

/** Per-process concurrent-connection limits: per user and per business. (Across several instances each keeps its own count.) */
const perUser = new Map<string, number>();
const perBusiness = new Map<string, number>();
export const liveLimits = (env: Record<string, string | undefined> = process.env): { perUser: number; perBusiness: number } => {
  const n = (raw: string | undefined, d: number) => { const v = Number((raw ?? '').trim()); return Number.isInteger(v) && v >= 1 && v <= 1000 ? v : d; };
  return { perUser: n(env.LIVE_MAX_PER_USER, 3), perBusiness: n(env.LIVE_MAX_PER_BUSINESS, 20) };
};

/** Take a connection slot; returns the release function, or null when a limit is reached. Idempotent release. */
export function acquireLiveSlot(userKey: string, businessId: string, env: Record<string, string | undefined> = process.env): (() => void) | null {
  const lim = liveLimits(env);
  if ((perUser.get(userKey) ?? 0) >= lim.perUser || (perBusiness.get(businessId) ?? 0) >= lim.perBusiness) return null;
  perUser.set(userKey, (perUser.get(userKey) ?? 0) + 1);
  perBusiness.set(businessId, (perBusiness.get(businessId) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const [m, k] of [[perUser, userKey], [perBusiness, businessId]] as const) {
      const v = (m.get(k) ?? 1) - 1;
      if (v <= 0) m.delete(k); else m.set(k, v);
    }
  };
}
export const liveConnectionCount = (): { users: number; businesses: number } => ({ users: perUser.size, businesses: perBusiness.size });
