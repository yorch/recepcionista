'use client';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { useApi } from '@/hooks/use-api';
import type { Briefing } from '@/lib/types';

export function BriefingActions({ businessId }: { businessId: string }) {
  const router = useRouter();
  const { busy, call } = useApi();

  async function generate() {
    const data = await call<Briefing>(
      '/api/briefings/generate',
      { body: { business_id: businessId } },
      { loading: 'Writing your evening note…', success: 'Briefing ready' },
    );
    if (data) router.refresh();
  }

  return (
    <Button onClick={generate} disabled={busy} variant="outline">
      {busy ? 'Recording…' : 'Generate now'}
    </Button>
  );
}
