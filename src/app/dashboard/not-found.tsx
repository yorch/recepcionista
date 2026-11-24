import Link from 'next/link';
import { buttonClass } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { getT } from '@/lib/i18n/server';

export default async function DashboardNotFound() {
  const t = await getT();
  return (
    <main className="mx-auto w-full max-w-xl px-4 py-16 sm:px-6">
      <Card className="p-8 text-center">
        <h1 className="text-[20px] font-semibold text-white">{t('auth.meta.notFound')}</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-mute">{t('error.dashboard.notFoundBody')}</p>
        <Link href="/dashboard" className={buttonClass('primary', 'mt-5')}>{t('error.backToToday')}</Link>
      </Card>
    </main>
  );
}
