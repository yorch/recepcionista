import { listBriefings } from '@/lib/db';
import { hasRole } from '@/lib/session';
import { getDashboardContext } from '@/lib/dashboard-context';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty';
import { PageHeader } from '@/components/ui/page-header';
import { VoicePlayer } from '@/components/ui/audio';
import { BriefingActions } from '@/components/dashboard/briefing-actions';
import { money } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function BriefingsPage() {
  const ctx = await getDashboardContext();
  const biz = ctx.business;
  const briefings = await listBriefings(biz.id);
  const isOwner = hasRole(ctx.principal, 'owner');

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
      <PageHeader
        title="Briefings"
        subtitle="Forty-five seconds. Then you know your day."
        right={isOwner ? <BriefingActions businessId={biz.id} /> : null}
      />

      <ul className="mt-6 flex flex-col gap-4">
        {briefings.map((b) => (
          <li key={b.id}>
            <Card className="p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-[13px] font-medium text-soft">{b.date}</h2>
                <div className="flex gap-3 text-xs text-dim">
                  <span>{b.stats.calls} calls</span>
                  <span>{b.stats.bookings} booked</span>
                  <span>{money(b.stats.revenue)}</span>
                  {b.stats.flags ? <span className="text-warn">{b.stats.flags} flagged</span> : null}
                </div>
              </div>
              <VoicePlayer src={b.audio_url} label={`Evening note · ${b.date}`} />
              <p className="mt-3 rounded-xl bg-sunken p-3.5 text-[13px] leading-relaxed text-body">{b.transcript}</p>
            </Card>
          </li>
        ))}
      </ul>
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
