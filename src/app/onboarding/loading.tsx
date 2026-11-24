import { Skeleton } from '@/components/ui/skeleton';
import { getT } from '@/lib/i18n/server';

export default async function OnboardingLoading() {
  const t = await getT();
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">{t('error.onboarding.loading')}</span>
      <Skeleton className="h-8 w-40" />
      <Skeleton className="mt-10 h-10 w-80 max-w-full" />
      <Skeleton className="mt-6 h-64" />
    </main>
  );
}
