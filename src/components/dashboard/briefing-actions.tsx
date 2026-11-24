'use client';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { useApi } from '@/hooks/use-api';
import { useT } from '@/lib/i18n/client';
import type { Briefing } from '@/lib/types';

export function BriefingActions({ businessId }: { businessId: string }) {
  const t = useT();
  const router = useRouter();
  const { busy, call } = useApi();

  async function generate() {
    const data = await call<Briefing>(
      '/api/briefings/generate',
      { body: { business_id: businessId } },
      { loading: t('briefings.writing'), success: t('briefings.ready') },
    );
    if (data) router.refresh();
  }

  return (
    <Button onClick={generate} disabled={busy} variant="outline">
      {busy ? t('briefings.recording') : t('briefings.generate')}
    </Button>
  );
}
