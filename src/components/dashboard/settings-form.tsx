'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { ApiResult } from '@/lib/types';

const field =
  'w-full rounded-xl border border-[#26313f] bg-[#080b10] p-3 text-[13px] text-[#cbd7e6] outline-none focus:border-[#ff6b35]/60';

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
  const [days, setDays] = useState(String(initialRetentionDays));
  const [disclosure, setDisclosure] = useState(initialDisclosure);
  const [busy, setBusy] = useState(false);

  const n = Number(days);
  const daysOk = Number.isInteger(n) && n >= 1 && n <= 3650;
  const spoken = disclosure.trim() || defaultDisclosure;

  async function save() {
    if (!daysOk) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/businesses/${businessId}/settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ retention_days: n, recording_disclosure_text: disclosure.trim() || null }),
      });
      const json = (await res.json()) as ApiResult<unknown>;
      if (!json.ok) throw new Error(json.error);
      toast.success('Saved — the disclosure applies from the next call');
      router.refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <label htmlFor="retention" className="text-[12px] font-medium text-white">Keep customer data for (days)</label>
        <input
          id="retention" type="number" min={1} max={3650} inputMode="numeric"
          value={days} onChange={(e) => setDays(e.target.value)}
          aria-invalid={!daysOk} className={`${field} mt-1 max-w-[160px]`}
        />
        <p className={`mt-1 text-[11px] ${daysOk ? 'text-[#6b7b91]' : 'text-[#ff9b86]'}`}>
          {daysOk
            ? 'Calls, transcripts and texts older than this are deleted daily; old bookings lose name, phone and address.'
            : 'Enter a whole number from 1 to 3650.'}
        </p>
      </div>

      <div>
        <label htmlFor="disclosure" className="text-[12px] font-medium text-white">Call disclosure (optional)</label>
        <textarea
          id="disclosure" rows={3} maxLength={maxDisclosureLength} value={disclosure}
          onChange={(e) => setDisclosure(e.target.value)}
          placeholder={defaultDisclosure} className={`${field} mt-1 resize-y`}
        />
        <p className="mt-1 text-[11px] text-[#6b7b91]">
          {disclosure.length}/{maxDisclosureLength}. Leave empty to use the default. Spoken first on every call.
        </p>
        <div className="mt-2 rounded-xl border border-[#26313f] bg-[#0c1118] p-3">
          <p className="text-[10px] uppercase tracking-wide text-[#5a6b80]">She will open with</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-[#cbd7e6]">{spoken}</p>
        </div>
      </div>

      <div>
        <p className="text-[12px] font-medium text-white">Time zone</p>
        <p className="mt-1 text-[13px] text-[#cbd7e6]">{timezone}</p>
        <p className="mt-1 text-[11px] text-[#6b7b91]">Texts that are not transactional are held from 9pm to 8am in this zone.</p>
      </div>

      <div className="flex">
        <Button onClick={save} disabled={busy || !daysOk}>{busy ? 'Saving…' : 'Save'}</Button>
      </div>
    </div>
  );
}
