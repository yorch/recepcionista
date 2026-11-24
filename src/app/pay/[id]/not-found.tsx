import Link from 'next/link';
import { LogoMark } from '@/components/ui/logo';
import { getT } from '@/lib/i18n/server';

export default async function PayNotFound() {
  const t = await getT();
  return (
    <main id="main-content" className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center px-5 py-10 text-center">
      <LogoMark />
      <h1 className="mt-5 text-[24px] font-semibold tracking-[-0.02em] text-white">{t('pay.notFound.title')}</h1>
      <p className="mt-2 text-[14px] leading-relaxed text-mute">{t('pay.notFound.body')}</p>
      <Link href="/" className="mt-6 inline-flex min-h-11 items-center text-[13px] text-brand-soft hover:underline">{t('pay.notFound.home')}</Link>
    </main>
  );
}
