import type { Metadata } from 'next';
import Link from 'next/link';
import { Logo } from '@/components/ui/logo';
import { buttonClass } from '@/components/ui/button';
import { getT } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('auth.meta.notFound'), robots: { index: false } };
}

export default async function NotFound() {
  const t = await getT();
  return (
    <main id="main-content" className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center px-5 py-10 text-center">
      <Logo />
      <p className="mt-8 font-mono text-sm text-dim">404</p>
      <h1 className="mt-2 text-[26px] font-semibold tracking-[-0.02em] text-white">{t('notFound.title')}</h1>
      <p className="mt-2 text-[14px] leading-relaxed text-mute">{t('notFound.body')}</p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <Link href="/" className={buttonClass('primary')}>{t('notFound.home')}</Link>
        <Link href="/dashboard" className={buttonClass('outline')}>{t('notFound.dashboard')}</Link>
      </div>
    </main>
  );
}
