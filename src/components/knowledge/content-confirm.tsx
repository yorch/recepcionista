'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiRequest } from '@/hooks/use-api';
import { errorText } from '@/lib/i18n/api-errors';
import { useT } from '@/lib/i18n/client';

export type ContentState = 'unconfirmed' | 'confirmed' | 'stale';

/** The "I checked these" checkbox shared by the onboarding review and the dashboard card. Controlled; the parent decides when to POST the confirmation. */
export function ContentCheck({ checked, onChange, state, disabled }: { checked: boolean; onChange: (v: boolean) => void; state: ContentState; disabled?: boolean }) {
  const t = useT();
  return (
    <div className="rounded-xl border border-line bg-panel/70 p-4">
      <h3 className="text-[13px] font-semibold text-white">{t('pd.cc.title')}</h3>
      <p className="mt-1 text-[13px] text-mute">{t('pd.cc.body')}</p>
      {state === 'stale' ? <p role="note" className="mt-2 text-[13px] text-warn">{t('pd.cc.stale')}</p> : null}
      <label className="mt-3 flex min-h-11 cursor-pointer items-start gap-3 text-[14px] text-soft">
        <input
          type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-[var(--brand,#3b82f6)]" checked={checked} disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{t('pd.cc.check')}</span>
      </label>
    </div>
  );
}

/** Dashboard card (Knowledge page): shown while the template content is unconfirmed or stale. Owner only (the route refuses anyone else). */
export function ContentConfirmCard({ businessId, initialState }: { businessId: string; initialState: ContentState }) {
  const t = useT();
  const router = useRouter();
  const [state, setState] = useState<ContentState>(initialState);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  if (state === 'confirmed') return <p role="status" className="mb-6 text-[13px] text-mint-text">{t('pd.cc.confirmed')}</p>;

  async function confirm() {
    if (busy || !checked) return;
    setBusy(true);
    try {
      await apiRequest(`/api/businesses/${businessId}/content-confirmation`, { method: 'POST', body: {} });
      setState('confirmed');
      toast.success(t('pd.cc.saved'));
      router.refresh();
    } catch (err) {
      toast.error(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-6 flex flex-col gap-3">
      <ContentCheck checked={checked} onChange={setChecked} state={state} disabled={busy} />
      <div><Button onClick={confirm} disabled={busy || !checked}>{busy ? t('common.saving') : t('pd.cc.confirm')}</Button></div>
    </div>
  );
}
