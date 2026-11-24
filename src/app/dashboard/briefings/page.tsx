import type { Metadata } from 'next';
import { listBriefingsPage } from '@/lib/db';
import { getT } from '@/lib/i18n/server';
import { hasRole } from '@/lib/session';
import { getDashboardContext } from '@/lib/dashboard-context';
import { EmptyState } from '@/components/ui/empty';
import { PageHeader } from '@/components/ui/page-header';
import { BriefingsList } from '@/components/dashboard/briefings-list';
import { BriefingActions } from '@/components/dashboard/briefing-actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('briefings.title') };
}

export const dynamic = 'force-dynamic';

export default async function BriefingsPage() {
  const t = await getT();
  const ctx = await getDashboardContext();
  const biz = ctx.business;
  const page = await listBriefingsPage(biz.id, { limit: 14 });
  const briefings = page.items;
  const isOwner = hasRole(ctx.principal, 'owner');

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
      <PageHeader
        title={t('briefings.title')}
        subtitle={t('briefings.subtitle')}
        right={isOwner ? <BriefingActions businessId={biz.id} /> : null}
      />

      <BriefingsList businessId={biz.id} initial={page} />
      {briefings.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            title={t('briefings.emptyTitle')}
            body={isOwner ? t('briefings.emptyOwner') : t('briefings.emptyStaff')}
            secondary={{ href: '/dashboard/calls', label: t('briefings.seeCalls') }}
          >
            {isOwner ? <BriefingActions businessId={biz.id} /> : null}
          </EmptyState>
        </div>
      ) : null}
    </main>
  );
}
