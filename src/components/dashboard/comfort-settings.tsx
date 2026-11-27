'use client';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { SelectField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, apiRequest } from '@/hooks/use-api';
import { useJson } from '@/components/admin/use-json';
import { errorText } from '@/lib/i18n/api-errors';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/core';
import { useReauth } from './reauth';

interface Knob {
  key: string; kind: string; bounds: { min: number | null; max: number | null } | null; rule: string | null; platform_value: unknown; override: unknown | null; effective: unknown; locked_by_env: boolean;
}

const LABEL: Record<string, MessageKey> = {
  'messaging.quiet_start_hour': 'at.comfort.quietStart', 'messaging.quiet_end_hour': 'at.comfort.quietEnd', 'jobs.briefing_enabled': 'at.comfort.briefing', 'jobs.briefing_hour': 'at.comfort.briefingHour',
  'jobs.gratitude_enabled': 'at.comfort.thanks', 'forward.ring_seconds': 'at.comfort.ring',
};
const HINT: Record<string, MessageKey> = {
  'messaging.quiet_start_hour': 'at.comfort.quietHint', 'messaging.quiet_end_hour': 'at.comfort.quietHint', 'jobs.briefing_enabled': 'at.comfort.briefingHint', 'jobs.briefing_hour': 'at.comfort.briefingHourHint',
  'jobs.gratitude_enabled': 'at.comfort.thanksHint', 'forward.ring_seconds': 'at.comfort.ringHint',
};
const ORDER = Object.keys(LABEL);

export const hourLabel = (h: number): string => `${String(h).padStart(2, '0')}:00`;

/** The window the effective quiet hours cover, as text. Pure. */
export const quietText = (start: unknown, end: unknown): string => (typeof start === 'number' && typeof end === 'number' ? `${hourLabel(start)} - ${hourLabel(end)}` : '');

function Row({ k, businessId, readOnly, reload, guard }: { k: Knob; businessId: string; readOnly: boolean; reload: () => void; guard: (a: () => Promise<void>) => Promise<void> }) {
  const t = useT();
  const [draft, setDraft] = useState<string>(String(k.effective));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = t(LABEL[k.key]);
  const isBool = k.kind === 'bool';
  const isHour = k.key.endsWith('_hour');
  const dirty = draft !== String(k.effective);
  const bounds = k.bounds;

  async function call(method: 'PUT' | 'DELETE') {
    setBusy(true); setError(null);
    try {
      await guard(async () => {
        const value = isBool ? draft === 'true' : Number(draft);
        await apiRequest(`/api/businesses/${businessId}/settings-overrides`, { method, body: method === 'PUT' ? { key: k.key, value } : { key: k.key } });
      });
      toast.success(t('at.comfort.saved'));
      reload();
    } catch (err) {
      const code = err instanceof ApiError ? (err.payload as { code?: string } | undefined)?.code : undefined;
      setError(code === 'not_stricter' ? t('at.comfort.notStricter') : code === 'out_of_bounds' ? t('at.comfort.outOfBounds', { min: bounds?.min ?? '', max: bounds?.max ?? '' }) : errorText(t, err));
    } finally { setBusy(false); }
  }

  const id = `comfort-${k.key}`;
  return (
    <li className="flex flex-col gap-2 rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-end gap-3">
        {isBool ? (
          <SelectField id={id} label={label} className="w-48" value={draft} onChange={(e) => setDraft(e.target.value)} disabled={readOnly || k.locked_by_env}>
            <option value="true">{t('at.on')}</option>
            <option value="false">{t('at.off')}</option>
          </SelectField>
        ) : isHour ? (
          <SelectField id={id} label={label} className="w-48" value={draft} onChange={(e) => setDraft(e.target.value)} disabled={readOnly || k.locked_by_env}>
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </SelectField>
        ) : (
          <SelectField id={id} label={label} className="w-48" value={draft} onChange={(e) => setDraft(e.target.value)} disabled={readOnly || k.locked_by_env}>
            {Array.from({ length: (bounds?.max ?? 40) - (bounds?.min ?? 10) + 1 }, (_, i) => (bounds?.min ?? 10) + i).map((n) => <option key={n} value={n}>{t('at.comfort.seconds', { n })}</option>)}
          </SelectField>
        )}
        {!readOnly && !k.locked_by_env ? (
          <>
            <Button onClick={() => void call('PUT')} disabled={busy || !dirty}>{busy ? t('common.saving') : t('at.comfort.save')}</Button>
            {k.override !== null && k.override !== undefined ? <Button variant="outline" onClick={() => void call('DELETE')} disabled={busy}>{t('at.comfort.reset')}</Button> : null}
          </>
        ) : null}
      </div>
      <p className="text-xs text-dim">{t(HINT[k.key])} {t('at.comfort.platformValue', { value: typeof k.platform_value === 'boolean' ? t(k.platform_value ? 'at.on' : 'at.off') : isHour && typeof k.platform_value === 'number' ? hourLabel(k.platform_value) : String(k.platform_value) })}</p>
      {k.locked_by_env ? <p className="text-xs text-warn">{t('at.comfort.locked')}</p> : null}
      {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
    </li>
  );
}

/** The owner's comfort knobs: quiet hours (stricter than the platform), briefing on / off and hour, thank-you texts, ring seconds. Everything else is the platform's. */
export function ComfortSettings({ businessId, readOnly = false }: { businessId: string; readOnly?: boolean }) {
  const t = useT();
  const { data, error, loading, reload } = useJson<Knob[]>(`/api/businesses/${businessId}/settings-overrides`);
  const { guard, panel } = useReauth((err) => toast.error(errorText(t, err)));
  if (loading && !data) return <div role="status" aria-live="polite"><span className="sr-only">{t('common.loading')}</span><Skeleton className="h-24 w-full" /></div>;
  if (error && !data) return <p role="alert" className="text-[13px] text-danger">{errorText(t, error)} <button type="button" onClick={reload} className="underline">{t('common.retry')}</button></p>;
  const knobs = (data ?? []).filter((k) => LABEL[k.key]).sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key));
  if (knobs.length === 0) return <p className="text-[13px] text-mute">{t('at.comfort.none')}</p>;
  return (
    <div className="flex flex-col gap-3">
      {readOnly ? <p role="note" className="text-[13px] text-mute">{t('at.comfort.adminNote')}</p> : null}
      <ul className="flex flex-col gap-3">{knobs.map((k) => <Row key={`${k.key}:${String(k.effective)}`} k={k} businessId={businessId} readOnly={readOnly} reload={reload} guard={guard} />)}</ul>
      {panel}
    </div>
  );
}
