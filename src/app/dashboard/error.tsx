'use client';
import { useEffect } from 'react';
import Link from 'next/link';
import { Button, buttonClass } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

export default function DashboardError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  const digest = error instanceof Error ? (error as Error & { digest?: string }).digest : undefined;
  return (
    <main className="mx-auto w-full max-w-xl px-4 py-16 sm:px-6">
      <Card className="p-8 text-center">
        <h1 className="text-[20px] font-semibold text-white">This page could not load</h1>
        <p role="alert" className="mt-2 text-[13px] leading-relaxed text-mute">
          Something went wrong while loading your data. Nothing was changed. Try again{digest ? ` (reference ${digest})` : ''}.
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-3">
          <Button onClick={() => retry()}>Try again</Button>
          <Link href="/dashboard" className={buttonClass('outline')}>Back to Today</Link>
        </div>
      </Card>
    </main>
  );
}
