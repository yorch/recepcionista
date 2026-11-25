'use client';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/field';
import { apiRequest } from '@/hooks/use-api';
import { errorText } from '@/lib/i18n/api-errors';
import { useT } from '@/lib/i18n/client';

/** The business's own Google review link. Empty = review requests are thank-yous without a link (never a placeholder). */
export function ReviewUrlSettings({ businessId, initial }: { businessId: string; initial: string }) {
  const t = useT();
  const [url, setUrl] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiRequest<{ review_url: string | null }>(`/api/businesses/${businessId}/review-url`, { method: 'PUT', body: { review_url: url.trim() || null } });
      setSaved(res.review_url ?? '');
      setUrl(res.review_url ?? '');
      toast.success(res.review_url ? t('rv.saved') : t('rv.cleared'));
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-3">
      <TextField label={t('rv.label')} hint={saved ? t('rv.hint') : `${t('rv.unset')} ${t('rv.hint')}`} error={error} type="url" inputMode="url" autoComplete="off" maxLength={300} value={url} onChange={(e) => setUrl(e.target.value)} />
      <div><Button type="submit" disabled={busy || url.trim() === saved}>{busy ? t('common.saving') : t('rv.save')}</Button></div>
    </form>
  );
}
