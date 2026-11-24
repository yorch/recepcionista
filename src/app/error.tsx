'use client';
import { useEffect } from 'react';
import Link from 'next/link';
import { Button, buttonClass } from '@/components/ui/button';
import { Logo } from '@/components/ui/logo';
import { useT } from '@/lib/i18n/client';

export default function RootError({ error, retry }: { error: unknown; retry: () => void }) {
  const t = useT();
  useEffect(() => { console.error(error); }, [error]);
  const digest = error instanceof Error ? (error as Error & { digest?: string }).digest : undefined;
  return (
    <main id="main-content" className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center px-5 py-10 text-center">
      <Logo />
      <h1 className="mt-8 text-[26px] font-semibold tracking-[-0.02em] text-white">{t('common.errorTitle')}</h1>
      <p role="alert" className="mt-2 text-[14px] leading-relaxed text-mute">
        {t('error.root.body')}{digest ? ` (${t('error.reference')} ${digest})` : ''}
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <Button onClick={() => retry()}>{t('common.retry')}</Button>
        <Link href="/" className={buttonClass('outline')}>{t('notFound.home')}</Link>
      </div>
    </main>
  );
}
