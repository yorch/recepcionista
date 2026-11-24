'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiRequest } from '@/hooks/use-api';
import { errorText } from '@/lib/i18n/api-errors';
import { useLocale, useT } from '@/lib/i18n/client';
import { relative, seconds } from '@/lib/format';
import { RecordingPlayer } from '@/components/dashboard/recording-player';
import { callHasRecording } from '@/lib/voice/recording-audio';
import { formatPhoneDisplay, type TFunction } from '@/lib/i18n/core';
import type { Page } from '@/lib/db/paging';
import type { PublicCall } from '@/lib/voice/voicemail';

const LANG_TONE: Record<string, string> = { en: 'neutral', es: 'brand', mixed: 'sky' };

const TRANSFER_KEYS = ['connected', 'failed', 'no_answer', 'attempting', 'declined'] as const;
function transferLabel(t: TFunction, status: string): string {
  return (TRANSFER_KEYS as readonly string[]).includes(status) ? t(`calls.transfer.${status}` as 'calls.transfer.connected') : status;
}

function CallCard({ c, nowMs, highlight }: { c: PublicCall; nowMs: number; highlight?: boolean }) {
  const t = useT();
  const locale = useLocale();
  const lang = (c.language === 'es' || c.language === 'mixed' ? c.language : 'en') as 'en' | 'es' | 'mixed';
  return (
    <Card className={highlight ? 'p-5 ring-2 ring-brand-soft' : 'p-5'} id={`call-${c.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-raised text-xs font-medium text-body">
            {(c.caller_name ?? c.caller_phone ?? '?').slice(0, 2).toUpperCase()}
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[13.5px] font-medium text-white">{c.caller_name ?? t('calls.unknownCaller')}</h2>
              <Badge tone={LANG_TONE[lang]}>{t(`callLang.${lang}` as const)}</Badge>
              {c.urgency !== 'routine' ? <Badge tone={c.urgency}>{t(`urgency.${c.urgency}` as const)}</Badge> : null}
              {c.caller_verified === true ? <Badge tone="routine">{t('calls.verified')}</Badge> : /failed/i.test(c.stir_status ?? '') ? <Badge tone="emergency">{t('calls.stirFailed')}</Badge> : c.stir_status ? <Badge tone="neutral">{t('calls.stirPartial')}</Badge> : null}
              {c.transfer_status && c.transfer_status !== 'none' ? <Badge tone={c.transfer_status === 'connected' ? 'routine' : 'unsure'}>{t('calls.transfer', { status: transferLabel(t, c.transfer_status) })}</Badge> : null}
              {c.status === 'in_progress' && !c.ended_at && c.consent_status === 'disclosed' ? <Link href={`/dashboard/calls/${c.id}`} className="inline-flex min-h-11 items-center text-xs text-brand-soft hover:underline">{t('calls.watchLive')}</Link> : null}
            </div>
            <p className="mt-0.5 font-mono text-xs text-dim">
              {c.caller_phone ? formatPhoneDisplay(c.caller_phone) : ''} · {relative(c.started_at, nowMs, locale)} · {seconds(c.duration_sec)}
            </p>
          </div>
        </div>
        {c.flagged_reason ? (
          <span className="rounded-lg border border-warn-line bg-warn-bg px-2.5 py-1 text-xs text-warn">{t('calls.needsYou')}</span>
        ) : (
          <span className="rounded-lg border border-mint-line bg-mint-bg px-2.5 py-1 text-xs text-mint-text">{t('calls.handled')}</span>
        )}
      </div>

      {c.summary ? <p className="mt-3 text-[13px] leading-relaxed text-body">{c.summary}</p> : null}

      {c.flagged_reason ? <p className="mt-2 rounded-lg bg-[#1a1208] px-3 py-2 text-xs text-warn">{c.flagged_reason}</p> : null}

      {c.has_voicemail ? (
        <p className="mt-2 text-xs text-dim">
          {t('calls.hasVoicemail')}{' '}
          <Link href="/dashboard/calls?tab=voicemails" className="inline-flex min-h-11 items-center text-brand-soft hover:underline">{t('calls.listenVoicemails')}</Link>
        </p>
      ) : null}

      {callHasRecording(c) ? <RecordingPlayer callId={c.id} label={c.caller_name ?? c.caller_phone ?? t('calls.callerFallback')} /> : null}

      {c.transcript ? (
        <details className="group mt-3">
          <summary className="inline-flex min-h-11 cursor-pointer list-none items-center text-xs text-dim transition-colors hover:text-brand-soft">
            <span className="group-open:hidden">{t('calls.showTranscript')}</span>
            <span className="hidden group-open:inline">{t('calls.hideTranscript')}</span>
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
  const t = useT();
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
      setError(errorText(t, err, 'calls.loadMoreFailed'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {focus ? (
        <div className="mt-6">
          <p className="mb-2 text-xs uppercase tracking-wider text-dim">{t('calls.linkedCall')}</p>
          <CallCard c={focus} nowMs={nowMs} highlight />
        </div>
      ) : null}
      <ul className="mt-6 flex flex-col gap-3">
        {calls.map((c) => <li key={c.id}><CallCard c={c} nowMs={clock} /></li>)}
      </ul>
      {error ? <p role="alert" className="mt-4 text-[13px] text-danger">{error}</p> : null}
      {cursor ? (
        <div className="mt-5 flex justify-center">
          <Button variant="outline" onClick={more} disabled={loading}>{loading ? t('common.loading') : t('calls.loadMore')}</Button>
        </div>
      ) : null}
    </>
  );
}
