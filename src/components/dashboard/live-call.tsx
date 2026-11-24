'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type { TranscriptEvent } from '@/lib/types';

type Phase = 'connecting' | 'live' | 'polling' | 'ended' | 'declined' | 'signed_out';

const ROLE_LABEL: Record<string, string> = { caller: 'Caller', agent: 'Assistant', system: 'System' };
const POLL_MS = 3000;

/**
 * Live transcript of one call. Primary transport: Server-Sent Events (GET /api/calls/:id/live; the browser resumes with Last-Event-ID on
 * its own). If the stream cannot be held (limit, proxy, repeated errors) it falls back to polling GET /api/calls/:id/transcript?after=.
 * The log is an aria-live "polite" region; auto-scroll follows the newest line until the reader scrolls up (then it pauses, with a button).
 */
export function LiveCall({ callId, callerLabel, initialEvents, initiallyLive }: {
  callId: string; callerLabel: string; initialEvents: TranscriptEvent[]; initiallyLive: boolean;
}) {
  const [events, setEvents] = useState<TranscriptEvent[]>(initialEvents);
  const [phase, setPhase] = useState<Phase>(initiallyLive ? 'connecting' : 'ended');
  const [paused, setPaused] = useState(false);
  const lastSeq = useRef<number>(initialEvents.length ? initialEvents[initialEvents.length - 1].seq : -1);
  const logRef = useRef<HTMLDivElement | null>(null);
  const pausedRef = useRef(false);
  useEffect(() => { pausedRef.current = paused; }, [paused]);

  const add = useCallback((list: TranscriptEvent[]) => {
    if (list.length === 0) return;
    setEvents((prev) => {
      const bySeq = new Map(prev.map((e) => [e.seq, e]));
      for (const e of list) bySeq.set(e.seq, e);
      const next = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
      lastSeq.current = next[next.length - 1].seq;
      return next;
    });
  }, []);

  useEffect(() => {
    if (!initiallyLive) return;
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let errors = 0;

    const poll = async () => {
      if (stopped) return;
      try {
        const res = await fetch(`/api/calls/${encodeURIComponent(callId)}/transcript?after=${lastSeq.current}`, { cache: 'no-store', credentials: 'same-origin' });
        if (res.status === 401 || res.status === 403) { setPhase('signed_out'); return; }
        if (res.ok) {
          const j = (await res.json()) as { data?: { events: TranscriptEvent[]; live: boolean; consent: string } };
          add(j.data?.events ?? []);
          if (j.data?.consent === 'declined') { setEvents([]); setPhase('declined'); return; }
          if (j.data && !j.data.live) { setPhase('ended'); return; }
        }
      } catch { /* try again */ }
      timer = setTimeout(poll, POLL_MS);
    };
    const startPolling = () => { es?.close(); es = null; setPhase('polling'); void poll(); };

    if (typeof EventSource === 'undefined') { startPolling(); } else {
      es = new EventSource(`/api/calls/${encodeURIComponent(callId)}/live${lastSeq.current >= 0 ? `?after=${lastSeq.current}` : ''}`);
      es.onopen = () => { errors = 0; setPhase((p) => (p === 'connecting' || p === 'polling' ? 'live' : p)); };
      es.addEventListener('transcript', (m) => { errors = 0; try { add([JSON.parse((m as MessageEvent).data) as TranscriptEvent]); } catch { /* ignore a bad frame */ } });
      es.addEventListener('status', (m) => {
        try {
          const s = JSON.parse((m as MessageEvent).data) as { state: string };
          if (s.state === 'declined') { setEvents([]); setPhase('declined'); es?.close(); }
          else if (s.state === 'live') setPhase('live');
        } catch { /* ignore */ }
      });
      es.addEventListener('ended', () => { setPhase((p) => (p === 'declined' ? p : 'ended')); es?.close(); });
      es.addEventListener('auth', () => { setPhase('signed_out'); es?.close(); });
      es.addEventListener('reconnect', () => { /* the browser reconnects with Last-Event-ID */ });
      es.onerror = () => {
        errors++;
        // CLOSED = the browser gave up (429 limit, 4xx, proxy): poll instead. Otherwise it is retrying by itself; after 4 misses switch too.
        if (es && (es.readyState === EventSource.CLOSED || errors >= 4)) startPolling();
      };
    }
    return () => { stopped = true; es?.close(); if (timer) clearTimeout(timer); };
  }, [add, callId, initiallyLive]);

  useEffect(() => {
    const el = logRef.current;
    if (el && !pausedRef.current) el.scrollTop = el.scrollHeight;
  }, [events]);

  const onScroll = () => {
    const el = logRef.current;
    if (!el) return;
    const away = el.scrollHeight - el.scrollTop - el.clientHeight > 48;
    if (away !== pausedRef.current) setPaused(away);
  };

  const chip = phase === 'live' ? { text: 'Live', tone: 'routine' } : phase === 'polling' ? { text: 'Live (refreshing)', tone: 'sky' }
    : phase === 'connecting' ? { text: 'Connecting', tone: 'unsure' } : phase === 'ended' ? { text: 'Call ended', tone: 'neutral' }
      : phase === 'declined' ? { text: 'Not transcribed', tone: 'unsure' } : { text: 'Signed out', tone: 'emergency' };

  return (
    <Card className="p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-[14px] font-medium text-white">{callerLabel}</h2>
          <span role="status" data-testid="live-status"><Badge tone={chip.tone}>{phase === 'live' ? <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-mint live-dot" /> : null}{chip.text}</Badge></span>
        </div>
        {(phase === 'live' || phase === 'polling') ? (
          <Button variant="outline" className="min-h-11" onClick={() => { setPaused((p) => { const n = !p; if (!n && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; return n; }); }} aria-pressed={paused}>
            {paused ? 'Resume scrolling' : 'Pause scrolling'}
          </Button>
        ) : null}
      </div>

      {phase === 'declined' ? (
        <p className="mt-4 rounded-lg bg-warn-bg px-3 py-2 text-[13px] text-warn">The caller asked not to be recorded or transcribed. Nothing from this call is shown or kept.</p>
      ) : (
        <div
          ref={logRef} onScroll={onScroll} role="log" aria-live="polite" aria-relevant="additions" aria-label="Live call transcript" tabIndex={0}
          className="mt-4 max-h-[60vh] min-h-48 overflow-y-auto rounded-lg bg-sunken p-3 text-[13px] leading-relaxed"
        >
          {events.length === 0 ? <p className="text-dim">{phase === 'ended' ? 'No transcript was captured live for this call.' : 'Waiting for the first words…'}</p> : (
            <ol className="space-y-2">
              {events.map((e) => (
                <li key={e.seq} className="flex gap-2">
                  <span className="w-[4.5rem] shrink-0 text-xs font-medium uppercase tracking-wide text-dim">{ROLE_LABEL[e.role] ?? e.role}</span>
                  <span className={e.role === 'agent' ? 'text-soft' : 'text-white'}>{e.text}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {phase === 'ended' ? (
        <p className="mt-3 text-[13px] text-mute">
          This call has ended. The saved transcript and summary replace the live lines once they are processed.{' '}
          <Link href={`/dashboard/calls?call=${encodeURIComponent(callId)}`} className="inline-flex min-h-11 items-center text-brand-soft hover:underline">Open the saved call</Link>
        </p>
      ) : null}
      {phase === 'signed_out' ? <p className="mt-3 text-[13px] text-warn">Your session ended. <Link href="/login" className="text-brand-soft hover:underline">Sign in again</Link></p> : null}
    </Card>
  );
}
