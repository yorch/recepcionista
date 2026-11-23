'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { TextAreaField, TextField } from '@/components/ui/field';
import { useApi } from '@/hooks/use-api';
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
      { success: 'Saved — the disclosure applies from the next call' },
    );
    if (data !== undefined) router.refresh();
  }

  return (
    <div className="flex flex-col gap-5">
      <TextField
        label="Keep customer data for (days)"
        type="number" min={1} max={3650} inputMode="numeric"
        value={days} onChange={(e) => setDays(e.target.value)}
        className="max-w-[200px]"
        hint="Calls, transcripts and texts older than this are deleted daily; old bookings lose name, phone and address."
        error={daysOk ? null : 'Enter a whole number from 1 to 3650.'}
      />

      <div>
        <TextAreaField
          label="Call disclosure" optional rows={3} maxLength={maxDisclosureLength} value={disclosure}
          onChange={(e) => setDisclosure(e.target.value)} placeholder={defaultDisclosure}
          hint={`${disclosure.length}/${maxDisclosureLength}. Leave empty to use the default. Spoken first on every call; the standard AI and recording notice is always included (added if your text lacks it).`}
        />
        <div className="mt-2 rounded-xl border border-line-2 bg-sunken p-3">
          <p className="text-xs uppercase tracking-wide text-dim">She will open with</p>
          <p className="mt-1 text-[13px] leading-relaxed text-soft">{spoken}</p>
        </div>
      </div>

      <div>
        <p className="text-[12px] font-medium text-white">Time zone</p>
        <p className="mt-1 text-[13px] text-soft">{timezone}</p>
        <p className="mt-1 text-xs text-dim">Texts that are not transactional are held from 9pm to 8am in this zone.</p>
      </div>

      <div className="flex">
        <Button onClick={save} disabled={busy || !daysOk}>{busy ? 'Saving…' : 'Save'}</Button>
      </div>
    </div>
  );
}
