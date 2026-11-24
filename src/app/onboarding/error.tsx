'use client';
import { useEffect } from 'react';
import Link from 'next/link';
import { Button, buttonClass } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useT } from '@/lib/i18n/client';

export default function OnboardingError({ error, retry }: { error: unknown; retry: () => void }) {
  const t = useT();
  useEffect(() => { console.error(error); }, [error]);
  return (
    <main className="mx-auto w-full max-w-xl px-4 py-16 sm:px-6">
      <Card className="p-8 text-center">
        <h1 className="text-[20px] font-semibold text-white">{t('error.onboarding.title')}</h1>
        <p role="alert" className="mt-2 text-[13px] leading-relaxed text-mute">{t('error.onboarding.body')}</p>
        <div className="mt-5 flex flex-wrap justify-center gap-3">
          <Button onClick={() => retry()}>{t('common.retry')}</Button>
          <Link href="/dashboard" className={buttonClass('outline')}>{t('error.onboarding.toDashboard')}</Link>
        </div>
      </Card>
    </main>
  );
}
