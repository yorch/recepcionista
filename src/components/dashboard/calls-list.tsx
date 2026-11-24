'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ApiError, apiRequest } from '@/hooks/use-api';
import { relative, seconds } from '@/lib/format';
import type { Page } from '@/lib/db/paging';
import type { PublicCall } from '@/lib/voice/voicemail';

const LANG_LABEL: Record<string, string> = { en: 'English', es: 'Español', mixed: 'Spanglish' };
const LANG_TONE: Record<string, string> = { en: 'neutral', es: 'brand', mixed: 'sky' };

function CallCard({ c, nowMs, highlight }: { c: PublicCall; nowMs: number; highlight?: boolean }) {
  return (
    <Card className={highlight ? 'p-5 ring-2 ring-brand-soft' : 'p-5'} id={`call-${c.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-raised text-xs font-medium text-body">
            {(c.caller_name ?? c.caller_phone ?? '?').slice(0, 2).toUpperCase()}
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[13.5px] font-medium text-white">{c.caller_name ?? 'Unknown caller'}</h2>
              <Badge tone={LANG_TONE[c.language ?? 'en']}>{LANG_LABEL[c.language ?? 'en']}</Badge>
              {c.urgency !== 'routine' ? <Badge tone={c.urgency}>{c.urgency}</Badge> : null}
            </div>
            <p className="mt-0.5 font-mono text-xs text-dim">
              {c.caller_phone} · {relative(c.started_at, nowMs)} · {seconds(c.duration_sec)}
            </p>
          </div>
        </div>
        {c.flagged_reason ? (
          <span className="rounded-lg border border-warn-line bg-warn-bg px-2.5 py-1 text-xs text-warn">needs you</span>
        ) : (
          <span className="rounded-lg border border-mint-line bg-mint-bg px-2.5 py-1 text-xs text-mint-text">handled</span>
        )}
      </div>

      {c.summary ? <p className="mt-3 text-[13px] leading-relaxed text-body">{c.summary}</p> : null}

      {c.flagged_reason ? <p className="mt-2 rounded-lg bg-[#1a1208] px-3 py-2 text-xs text-warn">{c.flagged_reason}</p> : null}

      {c.has_voicemail ? (
        <p className="mt-2 text-xs text-dim">
          This caller left a voicemail.{' '}
          <Link href="/dashboard/calls?tab=voicemails" className="inline-flex min-h-11 items-center text-brand-soft hover:underline">Listen in Voicemails</Link>
        </p>
      ) : null}

      {c.transcript ? (
        <details className="group mt-3">
          <summary className="inline-flex min-h-11 cursor-pointer list-none items-center text-xs text-dim transition-colors hover:text-brand-soft">
            <span className="group-open:hidden">Show transcript ▾</span>
            <span className="hidden group-open:inline">Hide transcript ▴</span>
          </summary>
          <p className="mt-2 max-h-48 overflow-y-auto rounded-lg bg-sunken p-3.5 text-xs leading-relaxed text-mute">{c.transcript}</p>
        </details>
      ) : null}
    </Card>
  );
}

/** The calls list: the first page comes from the server, "Load more" follows the cursor. */
export function CallsList({
  businessId, initial, nowMs, focus,
}: { businessId: string; initial: Page<PublicCall>; nowMs: number; focus?: PublicCall | null }) {
  const [calls, setCalls] = useState(initial.items);
  const [cursor, setCursor] = useState(initial.next_cursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clock, setClock] = useState(nowMs);

  async function more() {
    if (!cursor) return;
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams({ business_id: businessId, cursor, limit: '25' });
      const page = await apiRequest<Page<PublicCall>>(`/api/calls?${q}`);
      setCalls((cur) => {
        const seen = new Set(cur.map((c) => c.id));
        return [...cur, ...page.items.filter((c) => !seen.has(c.id))];
      });
      setCursor(page.next_cursor);
      setClock(Date.now());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load more calls.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {focus ? (
        <div className="mt-6">
          <p className="mb-2 text-xs uppercase tracking-wider text-dim">Linked call</p>
          <CallCard c={focus} nowMs={nowMs} highlight />
        </div>
      ) : null}
      <ul className="mt-6 flex flex-col gap-3">
        {calls.map((c) => <li key={c.id}><CallCard c={c} nowMs={clock} /></li>)}
      </ul>
      {error ? <p role="alert" className="mt-4 text-[13px] text-danger">{error}</p> : null}
      {cursor ? (
        <div className="mt-5 flex justify-center">
          <Button variant="outline" onClick={more} disabled={loading}>{loading ? 'Loading…' : 'Load more calls'}</Button>
        </div>
      ) : null}
    </>
  );
}
