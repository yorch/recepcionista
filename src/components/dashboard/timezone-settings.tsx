'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { SelectField } from '@/components/ui/field';
import { apiRequest } from '@/hooks/use-api';
import { errorText } from '@/lib/i18n/api-errors';
import { useLocale, useT } from '@/lib/i18n/client';
import { tzSelectOptions } from '@/lib/tz-options';
import { partsInTz } from '@/lib/time';
import type { TimeZoneView } from '@/app/api/businesses/[id]/timezone/route';

type Saved = TimeZoneView & { changed: boolean; hours_recheck: boolean; agent_sync?: { agent: 'synced' | 'skipped' | 'failed' } };

const clock = (zone: string) => { const p = partsInTz(new Date(), zone); return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`; };

/**
 * Settings > Time zone. The zone is stored as an IANA name (daylight saving is automatic); the list is US and Canada, labelled with the offset in
 * force today. The area-code suggestion is offered, never applied silently. Changing it does not move bookings; hours are wall-clock times in the
 * new zone, so the toast says to re-check them. Keyboard operable, 44px targets, wraps at phone width.
 */
export function TimezoneSettings({ businessId, initial }: { businessId: string; initial: { timezone: string; suggested: string | null } }) {
  const t = useT();
  const lang = useLocale();
  const router = useRouter();
  const [saved, setSaved] = useState(initial.timezone);
  const [zone, setZone] = useState(initial.timezone);
  const [busy, setBusy] = useState(false);
  const options = tzSelectOptions(saved, lang);

  async function save(e?: React.FormEvent) {
    e?.preventDefault();
    if (busy || zone === saved) return;
    setBusy(true);
    try {
      const res = await apiRequest<Saved>(`/api/businesses/${businessId}/timezone`, { method: 'PUT', body: { timezone: zone } });
      setSaved(res.timezone);
      setZone(res.timezone);
      toast[res.agent_sync?.agent === 'failed' ? 'warning' : 'success'](res.agent_sync?.agent === 'failed' ? t('pd.tz.savedPending') : t('pd.tz.saved'));
      router.refresh();
    } catch (err) {
      toast.error(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  const suggestion = initial.suggested && initial.suggested !== saved ? initial.suggested : null;
  return (
    <form onSubmit={save} className="flex flex-col gap-3">
      <SelectField label={t('pd.tz.label')} value={zone} onChange={(e) => setZone(e.target.value)} hint={t('pd.tz.hint')} disabled={busy}>
        {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </SelectField>
      <p className="text-xs text-dim" aria-live="polite">{t('pd.tz.now', { time: clock(zone) })}</p>
      {suggestion ? (
        <p className="text-[13px] text-mute">
          {t('pd.tz.suggested', { zone: suggestion })}{' '}
          <button type="button" className="min-h-11 text-brand underline" onClick={() => setZone(suggestion)}>{t('pd.tz.use')}</button>
        </p>
      ) : null}
      <div><Button type="submit" disabled={busy || zone === saved}>{busy ? t('common.saving') : t('pd.tz.save')}</Button></div>
    </form>
  );
}
