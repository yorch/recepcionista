'use client';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { VoicePlayer } from '@/components/ui/audio';
import { apiRequest } from '@/hooks/use-api';
import { errorText } from '@/lib/i18n/api-errors';
import { useLocale, useT } from '@/lib/i18n/client';
import { formatPhoneDisplay } from '@/lib/i18n/core';
import { relative, seconds } from '@/lib/format';
import type { Page } from '@/lib/db/paging';
import type { PublicCall } from '@/lib/voice/voicemail';

/** A tel: link only for a plain dialable number (never a raw caller-supplied string into an href). */
const telHref = (n: string | null | undefined): string | null => (n && /^\+?[0-9 ()-]{5,24}$/.test(n) ? `tel:${n.replace(/[^\d+]/g, '')}` : null);

function VoicemailCard({ c, nowMs }: { c: PublicCall; nowMs: number }) {
  const t = useT();
  const locale = useLocale();
  const tel = telHref(c.caller_phone);
  return (
    <Card className="p-5" id={`voicemail-${c.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[13.5px] font-medium text-white">{c.caller_name ?? t('calls.unknownCaller')}</h2>
          <p className="mt-0.5 text-xs text-dim">
            <span className="font-mono">{c.caller_phone ? formatPhoneDisplay(c.caller_phone) : t('vm.numberWithheld')}</span>
            {' · '}
            <time dateTime={c.started_at}>{relative(c.started_at, nowMs, locale)}</time>
            {' · '}{seconds(c.duration_sec)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone="warn">{t('vm.callBackBadge')}</Badge>
          {tel ? (
            <a href={tel} className="inline-flex min-h-11 items-center rounded-xl border border-line-3 px-3.5 text-[13px] font-medium text-soft hover:bg-panel-2 hover:text-white">
              {t('vm.callBack', { phone: formatPhoneDisplay(c.caller_phone) })}
            </a>
          ) : null}
        </div>
      </div>
      <VoicePlayer
        className="mt-3" src={`/api/calls/${encodeURIComponent(c.id)}/voicemail`} preload="none" idleLabel={t('vm.idleLabel')}
        label={t('vm.from', { who: c.caller_name ?? c.caller_phone ?? t('vm.anUnknown') })}
      />
    </Card>
  );
}

/** Voicemails left on the paused / forwarded line, newest first. Audio streams through the authenticated proxy: no provider URL reaches the page. */
export function VoicemailList({ businessId, initial, nowMs, retentionDays }: { businessId: string; initial: Page<PublicCall>; nowMs: number; retentionDays: number }) {
  const t = useT();
  const [items, setItems] = useState(initial.items);
  const [cursor, setCursor] = useState(initial.next_cursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function more() {
    if (!cursor) return;
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams({ business_id: businessId, voicemail: '1', cursor, limit: '25' });
      const page = await apiRequest<Page<PublicCall>>(`/api/calls?${q}`);
      setItems((cur) => {
        const seen = new Set(cur.map((c) => c.id));
        return [...cur, ...page.items.filter((c) => !seen.has(c.id))];
      });
      setCursor(page.next_cursor);
    } catch (err) {
      setError(errorText(t, err, 'vm.loadMoreFailed'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <p className="mt-4 text-xs leading-relaxed text-dim">
        {t('vm.notice', { days: retentionDays })}
      </p>
      <ul className="mt-4 flex flex-col gap-3">
        {items.map((c) => <li key={c.id}><VoicemailCard c={c} nowMs={nowMs} /></li>)}
      </ul>
      {error ? <p role="alert" className="mt-4 text-[13px] text-danger">{error}</p> : null}
      {cursor ? (
        <div className="mt-5 flex justify-center">
          <Button variant="outline" onClick={more} disabled={loading}>{loading ? t('common.loading') : t('vm.loadMore')}</Button>
        </div>
      ) : null}
    </>
  );
}
