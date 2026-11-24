'use client';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { VerticalPicker } from '@/components/knowledge/vertical-picker';
import { ApiError, apiRequest } from '@/hooks/use-api';
import { useRouter } from 'next/navigation';
import type { Vertical } from '@/lib/types';
import { useReauth } from './reauth';

/**
 * The trade of the business. Changing it rewrites the emergency rules and wording the receptionist uses; it never touches the services,
 * prices, FAQs or notes the owner entered. Asks for a recent proof of identity (password) because it changes how emergencies are handled.
 */
export function VerticalSettings({ businessId, initial, lang = 'en' }: { businessId: string; initial: Vertical; lang?: 'en' | 'es' }) {
  const router = useRouter();
  const [saved, setSaved] = useState<Vertical>(initial);
  const [value, setValue] = useState<Vertical>(initial);
  const [busy, setBusy] = useState(false);
  const { guard, panel } = useReauth((err) => toast.error(err instanceof ApiError ? err.message : 'Could not save.'));

  async function save() {
    setBusy(true);
    try {
      await guard(async () => {
        await apiRequest(`/api/businesses/${businessId}`, { method: 'PATCH', body: { vertical: value } });
        setSaved(value);
        toast.success('Business type saved. Your services, prices and answers were not changed.');
        router.refresh();
      });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <VerticalPicker value={value} onChange={setValue} lang={lang} disabled={busy} label="Business type" />
      <p className="text-xs text-dim">
        This sets how she handles emergencies and what she says about your trade. Your services, prices, FAQs and notes stay exactly as you wrote them.
        Check the Brain page afterwards, and the emergency rules she will follow.
      </p>
      <div className="flex"><Button onClick={save} disabled={busy || value === saved}>{busy ? 'Saving…' : 'Save business type'}</Button></div>
      {panel}
    </div>
  );
}
