import type { Metadata } from 'next';
import { countCalls, getCall, listCallsPage } from '@/lib/db';
import { getDashboardContext } from '@/lib/dashboard-context';
import { hasRole } from '@/lib/session';
import { EmptyState } from '@/components/ui/empty';
import { PageHeader } from '@/components/ui/page-header';
import { CallsList } from '@/components/dashboard/calls-list';

export const metadata: Metadata = { title: 'Calls' };

export const dynamic = 'force-dynamic';

export default async function CallsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await getDashboardContext();
  const biz = ctx.business;
  const q = await searchParams;
  const callId = Array.isArray(q.call) ? q.call[0] : q.call;
  const [page, total, linked] = await Promise.all([
    listCallsPage(biz.id, { limit: 25 }),
    countCalls(biz.id),
    // A call opened from a booking: only ever one of THIS business's calls.
    callId ? getCall(callId) : Promise.resolve(null),
  ]);
  const focus = linked && linked.business_id === biz.id ? linked : null;
  const isOwner = hasRole(ctx.principal, 'owner');

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
      <PageHeader title="Calls" subtitle="Every conversation, transcribed and triaged." right={<span className="text-xs text-dim">{total} total</span>} />

      <CallsList businessId={biz.id} initial={page} nowMs={new Date().getTime()} focus={focus} />

      {page.items.length === 0 && !focus ? (
        <div className="mt-6">
          <EmptyState
            title="No calls yet"
            body={biz.phone
              ? `Call ${biz.phone} from another phone to hear her answer. Real calls show up here with a transcript, summary and urgency.`
              : 'Your receptionist needs a phone number before she can take calls.'}
            cta={isOwner ? { href: '/onboarding', label: biz.phone ? 'Test call and call forwarding' : 'Finish setup' } : undefined}
            secondary={{ href: '/dashboard/knowledge', label: 'Review what she knows' }}
          />
        </div>
      ) : null}
    </main>
  );
}
