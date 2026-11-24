'use client';
import { Skeleton } from '@/components/ui/skeleton';
import { useT } from '@/lib/i18n/client';

export default function Loading() {
  const t = useT();
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center gap-3 px-5" aria-busy="true" aria-live="polite">
      <span className="sr-only">{t('common.loading')}</span>
      <Skeleton className="h-8 w-8" />
      <Skeleton className="h-4 w-40" />
    </main>
  );
}
