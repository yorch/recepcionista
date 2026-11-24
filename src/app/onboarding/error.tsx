'use client';
import { useEffect } from 'react';
import Link from 'next/link';
import { Button, buttonClass } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

export default function OnboardingError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <main className="mx-auto w-full max-w-xl px-4 py-16 sm:px-6">
      <Card className="p-8 text-center">
        <h1 className="text-[20px] font-semibold text-white">Setup hit a problem</h1>
        <p role="alert" className="mt-2 text-[13px] leading-relaxed text-mute">
          Your progress is saved. Try again, and you will pick up where you left off.
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-3">
          <Button onClick={() => retry()}>Try again</Button>
          <Link href="/dashboard" className={buttonClass('outline')}>Go to dashboard</Link>
        </div>
      </Card>
    </main>
  );
}
