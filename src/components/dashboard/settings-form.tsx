'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { TextAreaField, TextField } from '@/components/ui/field';
import { useApi } from '@/hooks/use-api';
import { useT } from '@/lib/i18n/client';
import { disclosureFor } from '@/lib/kb/disclosure';

export function SettingsForm({
  businessId, timezone, initialRetentionDays, initialDisclosure, defaultDisclosure, maxDisclosureLength,
}: {
  businessId: string;
  timezone: string;
  initialRetentionDays: number;
  initialDisclosure: string;
  defaultDisclosure: string;
  maxDisclosureLength: number;
}) {
  const t = useT();
  const router = useRouter();
  const { busy, call } = useApi();
  const [days, setDays] = useState(String(initialRetentionDays));
  const [disclosure, setDisclosure] = useState(initialDisclosure);

  const n = Number(days);
  const daysOk = Number.isInteger(n) && n >= 1 && n <= 3650;
  const spoken = disclosure.trim() ? disclosureFor({ recording_disclosure_text: disclosure }) : defaultDisclosure;

  async function save() {
    if (!daysOk) return;
    const data = await call(
      `/api/businesses/${businessId}/settings`,
      { method: 'PATCH', body: { retention_days: n, recording_disclosure_text: disclosure.trim() || null } },
      { success: t('sf.saved') },
    );
    if (data !== undefined) router.refresh();
  }

  return (
    <div className="flex flex-col gap-5">
      <TextField
        label={t('sf.days')}
        type="number" min={1} max={3650} inputMode="numeric"
        value={days} onChange={(e) => setDays(e.target.value)}
        className="max-w-[200px]"
        hint={t('sf.daysHint')}
        error={daysOk ? null : t('sf.daysError')}
      />

      <div>
        <TextAreaField
          label={t('sf.disclosure')} optional rows={3} maxLength={maxDisclosureLength} value={disclosure}
          onChange={(e) => setDisclosure(e.target.value)} placeholder={defaultDisclosure}
          hint={t('sf.disclosureHint', { count: disclosure.length, max: maxDisclosureLength })}
        />
        <div className="mt-2 rounded-xl border border-line-2 bg-sunken p-3">
          <p className="text-xs uppercase tracking-wide text-dim">{t('sf.willOpen')}</p>
          <p className="mt-1 text-[13px] leading-relaxed text-soft">{spoken}</p>
        </div>
      </div>

      <div>
        <p className="text-[12px] font-medium text-white">{t('sf.tz')}</p>
        <p className="mt-1 text-[13px] text-soft">{timezone}</p>
        <p className="mt-1 text-xs text-dim">{t('sf.tzNote')}</p>
      </div>

      <div className="flex">
        <Button onClick={save} disabled={busy || !daysOk}>{busy ? t('common.saving') : t('common.save')}</Button>
      </div>
    </div>
  );
}
