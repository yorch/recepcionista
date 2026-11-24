import type { Metadata } from 'next';
import { listBriefingsPage } from '@/lib/db';
import { hasRole } from '@/lib/session';
import { getDashboardContext } from '@/lib/dashboard-context';
import { EmptyState } from '@/components/ui/empty';
import { PageHeader } from '@/components/ui/page-header';
import { BriefingsList } from '@/components/dashboard/briefings-list';
import { BriefingActions } from '@/components/dashboard/briefing-actions';

export const metadata: Metadata = { title: 'Briefings' };

export const dynamic = 'force-dynamic';

export default async function BriefingsPage() {
  const ctx = await getDashboardContext();
  const biz = ctx.business;
  const page = await listBriefingsPage(biz.id, { limit: 14 });
  const briefings = page.items;
  const isOwner = hasRole(ctx.principal, 'owner');

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
      <PageHeader
        title="Briefings"
        subtitle="Forty-five seconds. Then you know your day."
        right={isOwner ? <BriefingActions businessId={biz.id} /> : null}
      />

      <BriefingsList businessId={biz.id} initial={page} />
      {briefings.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            title="No briefings yet"
            body={isOwner
              ? 'A briefing is a short voice note about your day: calls, bookings, money, and anything that needs you. Generate one now to hear how it sounds.'
              : 'Briefings are short voice notes about the day. The account owner can generate them.'}
            secondary={{ href: '/dashboard/calls', label: 'See calls' }}
          >
            {isOwner ? <BriefingActions businessId={biz.id} /> : null}
          </EmptyState>
        </div>
      ) : null}
    </main>
  );
}
