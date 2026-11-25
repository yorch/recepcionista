'use client';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { SelectField, TextField } from '@/components/ui/field';
import { apiRequest } from '@/hooks/use-api';
import { errorText } from '@/lib/i18n/api-errors';
import { useT } from '@/lib/i18n/client';
import type { SchedulingConfig } from '@/lib/business-config';

const LEAD_CHOICES = [0, 30, 60, 120, 240, 720, 1440, 2880, 4320, 10080];

function leadLabel(minutes: number, t: ReturnType<typeof useT>): string {
  if (minutes === 0) return t('pd.sc.leadNone');
  if (minutes < 60) return t('pd.sc.leadMin', { n: minutes });
  if (minutes < 1440) return t('pd.sc.leadHours', { n: Math.round((minutes / 60) * 10) / 10 });
  return t('pd.sc.leadDays', { n: Math.round((minutes / 1440) * 10) / 10 });
}

/**
 * Settings > Scheduling: slot length, minimum notice, how far ahead customers can book, the buffer between jobs and the number of crews.
 * The numbers are enforced everywhere a time is offered or booked (voice agent, availability, booking validation, the database crew constraint).
 * Native inputs with visible labels and hints, 44px targets, one column at phone width.
 */
export function SchedulingSettings({ businessId, initial }: { businessId: string; initial: SchedulingConfig }) {
  const t = useT();
  const [saved, setSaved] = useState<SchedulingConfig>(initial);
  const [slot, setSlot] = useState(String(initial.slot_minutes));
  const [lead, setLead] = useState(String(initial.min_lead_minutes));
  const [horizon, setHorizon] = useState(String(initial.horizon_days));
  const [buffer, setBuffer] = useState(String(initial.buffer_minutes));
  const [crews, setCrews] = useState(String(initial.crews));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draft: SchedulingConfig = {
    slot_minutes: Number(slot) as SchedulingConfig['slot_minutes'], min_lead_minutes: Number(lead), horizon_days: Number(horizon),
    buffer_minutes: Number(buffer), crews: Number(crews),
  };
  const dirty = (Object.keys(draft) as (keyof SchedulingConfig)[]).some((k) => draft[k] !== saved[k]);
  const leadOptions = [...new Set([...LEAD_CHOICES, saved.min_lead_minutes])].sort((a, b) => a - b);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !dirty) return;
    setError(null);
    for (const [k, lo, hi] of [['horizon', 1, 180], ['buffer', 0, 240], ['crews', 1, 20]] as const) {
      const v = k === 'horizon' ? draft.horizon_days : k === 'buffer' ? draft.buffer_minutes : draft.crews;
      if (!Number.isInteger(v) || v < lo || v > hi) { setError(t('pd.sc.range', { field: t(`pd.sc.${k}` as const), lo, hi })); return; }
    }
    setBusy(true);
    try {
      const res = await apiRequest<SchedulingConfig>(`/api/businesses/${businessId}/scheduling`, { method: 'PUT', body: draft });
      setSaved(res);
      toast.success(t('pd.sc.saved'));
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-4" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label={t('pd.sc.slot')} value={slot} onChange={(e) => setSlot(e.target.value)} hint={t('pd.sc.slotHint')} disabled={busy}>
          {[15, 30, 60].map((m) => <option key={m} value={m}>{t('pd.sc.leadMin', { n: m })}</option>)}
        </SelectField>
        <SelectField label={t('pd.sc.lead')} value={lead} onChange={(e) => setLead(e.target.value)} hint={t('pd.sc.leadHint')} disabled={busy}>
          {leadOptions.map((m) => <option key={m} value={m}>{leadLabel(m, t)}</option>)}
        </SelectField>
        <TextField label={t('pd.sc.horizon')} type="number" inputMode="numeric" min={1} max={180} value={horizon} onChange={(e) => setHorizon(e.target.value)} hint={t('pd.sc.horizonHint')} disabled={busy} />
        <TextField label={t('pd.sc.buffer')} type="number" inputMode="numeric" min={0} max={240} step={5} value={buffer} onChange={(e) => setBuffer(e.target.value)} hint={t('pd.sc.bufferHint')} disabled={busy} />
        <TextField label={t('pd.sc.crews')} type="number" inputMode="numeric" min={1} max={20} value={crews} onChange={(e) => setCrews(e.target.value)} hint={t('pd.sc.crewsHint')} disabled={busy} className="sm:col-span-2" />
      </div>
      <p className="text-xs text-dim">{t('pd.sc.ownerNote')}</p>
      {error ? <p role="alert" className="text-[13px] text-danger">{error}</p> : null}
      <div><Button type="submit" disabled={busy || !dirty}>{busy ? t('common.saving') : t('pd.sc.save')}</Button></div>
    </form>
  );
}
