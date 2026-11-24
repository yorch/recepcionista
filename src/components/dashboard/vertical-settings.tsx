'use client';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { VerticalPicker } from '@/components/knowledge/vertical-picker';
import { apiRequest } from '@/hooks/use-api';
import { errorText } from '@/lib/i18n/api-errors';
import { useT } from '@/lib/i18n/client';
import { useRouter } from 'next/navigation';
import type { Vertical } from '@/lib/types';
import { useReauth } from './reauth';

/**
 * The trade of the business. Changing it rewrites the emergency rules and wording the receptionist uses; it never touches the services,
 * prices, FAQs or notes the owner entered. Asks for a recent proof of identity (password) because it changes how emergencies are handled.
 */
export function VerticalSettings({ businessId, initial, lang = 'en' }: { businessId: string; initial: Vertical; lang?: 'en' | 'es' }) {
  const t = useT();
  const router = useRouter();
  const [saved, setSaved] = useState<Vertical>(initial);
  const [value, setValue] = useState<Vertical>(initial);
  const [busy, setBusy] = useState(false);
  const { guard, panel } = useReauth((err) => toast.error(errorText(t, err, 'set.type.saveFailed')));

  async function save() {
    setBusy(true);
    try {
      await guard(async () => {
        const r = await apiRequest<{ vertical_sync?: { retry_queued?: boolean } }>(`/api/businesses/${businessId}`, { method: 'PATCH', body: { vertical: value } });
        setSaved(value);
        // The type is saved either way; when the live agent could not be updated right now a retry is queued: say so instead of "saved".
        if (r?.vertical_sync?.retry_queued) toast.warning(t('set.type.syncPending'));
        else toast.success(t('set.type.saved'));
        router.refresh();
      });
    } catch (e) {
      toast.error(errorText(t, e, 'set.type.saveFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <VerticalPicker value={value} onChange={setValue} lang={lang} disabled={busy} label={t('set.type.label')} />
      <p className="text-xs text-dim">
        {t('set.type.note')}
      </p>
      <div className="flex"><Button onClick={save} disabled={busy || value === saved}>{busy ? t('common.saving') : t('set.type.save')}</Button></div>
      {panel}
    </div>
  );
}
