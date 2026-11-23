import { listBookings } from '@/lib/db';
import { getDashboardContext } from '@/lib/dashboard-context';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty';
import { PageHeader } from '@/components/ui/page-header';
import { dateKeyLabel } from '@/components/dashboard/dates';
import { money, timeET } from '@/lib/format';
import { localDateKey, tzOf } from '@/lib/time';

export const dynamic = 'force-dynamic';

export default async function BookingsPage() {
  const ctx = await getDashboardContext();
  const biz = ctx.business;
  const tz = tzOf(biz);
  const bookings = await listBookings(biz.id);

  // Group by the BUSINESS's calendar day (a UTC slice puts evening jobs on tomorrow).
  const groups = new Map<string, typeof bookings>();
  for (const b of bookings) {
    const key = localDateKey(b.scheduled_at, tz);
    const arr = groups.get(key) ?? [];
    arr.push(b);
    groups.set(key, arr);
  }
  const keys = [...groups.keys()].sort();
  const today = localDateKey(new Date(), tz);

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
      <PageHeader
        title="Calendar"
        subtitle={`Jobs she booked while you were on a roof. Times shown in ${tz.replace('_', ' ')}.`}
        right={<span className="text-xs text-dim">{bookings.length} jobs</span>}
      />

      <div className="mt-6 flex flex-col gap-5">
        {keys.map((key) => {
          const dayBookings = groups.get(key)!;
          const isToday = key === today;
          return (
            <section key={key} aria-labelledby={`day-${key}`}>
              <div className="mb-2 flex items-center gap-2">
                <h2 id={`day-${key}`} className="text-xs font-medium uppercase tracking-wider text-dim">
                  {dateKeyLabel(key)}
                </h2>
                {isToday ? <Badge tone="routine">today</Badge> : null}
              </div>
              <div className="overflow-hidden rounded-2xl border border-line bg-panel/80">
                <ul className="divide-y divide-[#171f2a]">
                  {dayBookings.map((b) => (
                    <li key={b.id} className="flex items-center gap-3 px-4 py-3.5 sm:gap-4 sm:px-5">
                      <div className="w-[64px] shrink-0 font-mono text-[13px] text-white sm:w-[70px]">{timeET(b.scheduled_at, tz)}</div>
                      <div aria-hidden="true" className="w-px self-stretch bg-line" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate text-[13px] text-white">{b.customer_name}</p>
                          <Badge tone={b.status === 'completed' ? 'routine' : b.status === 'cancelled' ? 'emergency' : 'neutral'}>
                            {b.status}
                          </Badge>
                        </div>
                        <p className="truncate text-xs text-dim">{b.service}{b.address ? ` · ${b.address}` : ''}</p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="tabular-nums text-[13px] text-soft">{money(b.price_estimate)}</p>
                        {b.deposit_amount ? (
                          <p className={`text-xs ${b.deposit_paid ? 'text-mint-text' : 'text-warn'}`}>
                            {b.deposit_paid ? 'deposit paid' : `deposit ${money(b.deposit_amount)}`}
                          </p>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          );
        })}
        {keys.length === 0 ? (
          <EmptyState
            title="Nothing booked yet"
            body="When a caller books a job, it lands here with the time, address, price and deposit status. Her booking hours come from your business hours."
            cta={{ href: '/dashboard/knowledge', label: 'Check your hours and services' }}
            secondary={{ href: '/dashboard/calls', label: 'See calls' }}
          />
        ) : null}
      </div>
    </main>
  );
}
