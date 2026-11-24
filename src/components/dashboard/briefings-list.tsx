'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { VoicePlayer } from '@/components/ui/audio';
import { apiRequest } from '@/hooks/use-api';
import { errorText } from '@/lib/i18n/api-errors';
import { useLocale, useT } from '@/lib/i18n/client';
import { money } from '@/lib/format';
import type { Page } from '@/lib/db/paging';
import type { Briefing } from '@/lib/types';

export function BriefingsList({ businessId, initial }: { businessId: string; initial: Page<Briefing> }) {
  const t = useT();
  const locale = useLocale();
  const [items, setItems] = useState(initial.items);
  const [cursor, setCursor] = useState(initial.next_cursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function more() {
    if (!cursor) return;
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams({ business_id: businessId, cursor, limit: '14' });
      const page = await apiRequest<Page<Briefing>>(`/api/briefings?${q}`);
      setItems((cur) => [...cur, ...page.items.filter((b) => !cur.some((c) => c.id === b.id))]);
      setCursor(page.next_cursor);
    } catch (err) {
      setError(errorText(t, err, 'briefings.loadMoreFailed'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <ul className="mt-6 flex flex-col gap-4">
        {items.map((b) => (
          <li key={b.id}>
            <Card className="p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-[13px] font-medium text-soft">{b.date}</h2>
                <div className="flex gap-3 text-xs text-dim">
                  <span>{t('briefings.stats.calls', { count: b.stats.calls })}</span>
                  <span>{t('briefings.stats.booked', { n: b.stats.bookings })}</span>
                  <span>{money(b.stats.revenue, locale)}</span>
                  {b.stats.flags ? <span className="text-warn">{t('briefings.stats.flagged', { n: b.stats.flags })}</span> : null}
                </div>
              </div>
              <VoicePlayer src={b.audio_url} label={t('today.briefing.eveningNote', { date: b.date })} />
              <p className="mt-3 rounded-xl bg-sunken p-3.5 text-[13px] leading-relaxed text-body">{b.transcript}</p>
            </Card>
          </li>
        ))}
      </ul>
      {error ? <p role="alert" className="mt-4 text-[13px] text-danger">{error}</p> : null}
      {cursor ? (
        <div className="mt-5 flex justify-center">
          <Button variant="outline" onClick={more} disabled={loading}>{loading ? t('common.loading') : t('briefings.loadMore')}</Button>
        </div>
      ) : null}
    </>
  );
}
