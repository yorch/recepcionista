'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { countdown, useNow } from '@/components/admin/tenant-support';
import { apiRequest } from '@/hooks/use-api';
import { errorText } from '@/lib/i18n/api-errors';
import { useT } from '@/lib/i18n/client';

/**
 * Shown on the tenant dashboard to a platform admin: this is the SUPPORT view of another business. Read only by default (writes are refused by the server unless
 * support write mode is open); in write mode a countdown and an exit button.
 */
export function SupportBanner({ businessId, businessName, writeUntil }: { businessId: string; businessName: string; writeUntil: string | null }) {
  const t = useT();
  const router = useRouter();
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const left = writeUntil && now ? countdown(writeUntil, now) : null;

  async function exit() {
    setBusy(true);
    try {
      await apiRequest(`/api/admin/tenants/${businessId}/support-mode`, { method: 'DELETE' });
      toast.success(t('at.support.exited'));
      router.refresh();
    } catch (err) { toast.error(errorText(t, err)); } finally { setBusy(false); }
  }

  return (
    <div role="status" className={`flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2.5 text-[13px] sm:px-6 ${left ? 'border-warn-line bg-warn-bg text-warn' : 'border-sky-line bg-sky-bg text-sky-text'}`}>
      <span className="font-medium">{left ? t('at.banner.write', { name: businessName, time: left }) : t('at.banner.read', { name: businessName })}</span>
      {left ? <Button variant="outline" className="min-h-9 py-1" onClick={() => void exit()} disabled={busy}>{t('at.support.exit')}</Button> : null}
      <Link href={`/admin/tenants/${businessId}`} className="ml-auto inline-flex min-h-9 items-center underline underline-offset-2">{left ? t('at.banner.console') : t('at.banner.enterWrite')}</Link>
    </div>
  );
}
