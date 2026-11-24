'use client';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { LogoMark } from '@/components/ui/logo';
import { useT } from '@/lib/i18n/client';

export default function PayError({ error, retry }: { error: unknown; retry: () => void }) {
  const t = useT();
  useEffect(() => { console.error(error); }, [error]);
  return (
    <main id="main-content" className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center px-5 py-10 text-center">
      <LogoMark />
      <h1 className="mt-5 text-[24px] font-semibold tracking-[-0.02em] text-white">{t('pay.error.title')}</h1>
      <p role="alert" className="mt-2 text-[14px] leading-relaxed text-mute">{t('pay.error.body')}</p>
      <Button className="mt-6" onClick={() => retry()}>{t('common.retry')}</Button>
    </main>
  );
}
