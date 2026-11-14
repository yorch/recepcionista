'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { ApiResult, Briefing } from '@/lib/types';

export function BriefingActions({ businessId }: { businessId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function generate() {
    setBusy(true);
    const t = toast.loading('Writing your evening note…');
    try {
      const res = await fetch('/api/briefings/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ business_id: businessId }),
      });
      const json = (await res.json()) as ApiResult<Briefing>;
      if (!json.ok) throw new Error(json.error);
      toast.success('Briefing ready', { id: t });
      router.refresh();
    } catch (err) {
      toast.error((err as Error).message, { id: t });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button onClick={generate} disabled={busy} variant="outline">
      {busy ? 'Recording…' : 'Generate now'}
    </Button>
  );
}
