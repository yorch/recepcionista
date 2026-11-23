import { listBookings } from '@/lib/db';
import { getDashboardContext } from '@/lib/dashboard-context';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { dayET, money, timeET } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function BookingsPage() {
  const ctx = await getDashboardContext();
  const biz = ctx.business;
  const bookings = await listBookings(biz.id);

  const groups = new Map<string, typeof bookings>();
  for (const b of bookings) {
    const key = b.scheduled_at.slice(0, 10);
    const arr = groups.get(key) ?? [];
    arr.push(b);
    groups.set(key, arr);
  }
  const keys = [...groups.keys()].sort();
  const today = new Date().toISOString().slice(0, 10);

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-8">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-[24px] font-semibold tracking-[-0.02em]">Calendar</h1>
          <p className="mt-1 text-[13px] text-[#8b98ab]">Jobs she booked while you were on a roof.</p>
        </div>
        <span className="text-[11px] text-[#6b7b91]">{bookings.length} jobs</span>
      </header>

      <div className="mt-6 flex flex-col gap-5">
        {keys.map((key) => {
          const dayBookings = groups.get(key)!;
          const isToday = key === today;
          return (
            <section key={key}>
              <div className="mb-2 flex items-center gap-2">
                <h2 className="text-[11px] font-medium uppercase tracking-wider text-[#6b7b91]">
                  {dayET(`${key}T12:00:00`)}
                </h2>
                {isToday ? <Badge tone="routine">today</Badge> : null}
              </div>
              <div className="overflow-hidden rounded-2xl border border-[#1f2937] bg-[#0d1117]/80">
                <ul className="divide-y divide-[#171f2a]">
                  {dayBookings.map((b) => (
                    <li key={b.id} className="flex items-center gap-4 px-5 py-3.5">
                      <div className="w-[70px] shrink-0 font-mono text-[13px] text-white">{timeET(b.scheduled_at)}</div>
                      <div className="w-px self-stretch bg-[#1f2937]" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-[13px] text-white">{b.customer_name}</p>
                          <Badge tone={b.status === 'completed' ? 'routine' : b.status === 'cancelled' ? 'emergency' : 'neutral'}>
                            {b.status}
                          </Badge>
                        </div>
                        <p className="truncate text-[11px] text-[#6b7b91]">{b.service} · {b.address}</p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="tabular-nums text-[13px] text-[#cbd7e6]">{money(b.price_estimate)}</p>
                        {b.deposit_amount ? (
                          <p className={`text-[10.5px] ${b.deposit_paid ? 'text-[#3ddc97]' : 'text-[#f2c86b]'}`}>
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
        {keys.length === 0 ? <Card className="p-10 text-center text-[13px] text-[#5a6b80]">Nothing booked yet.</Card> : null}
      </div>
    </main>
  );
}
