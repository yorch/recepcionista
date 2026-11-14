import { listBriefings, listBusinesses } from '@/lib/db';
import { Card } from '@/components/ui/card';
import { VoicePlayer } from '@/components/ui/audio';
import { BriefingActions } from '@/components/dashboard/briefing-actions';
import { money } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function BriefingsPage() {
  const biz = listBusinesses()[0];
  if (!biz) return null;
  const briefings = listBriefings(biz.id);

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[24px] font-semibold tracking-[-0.02em]">Briefings</h1>
          <p className="mt-1 text-[13px] text-[#8b98ab]">Forty-five seconds. Then you know your day.</p>
        </div>
        <BriefingActions businessId={biz.id} />
      </header>

      <div className="mt-6 flex flex-col gap-4">
        {briefings.map((b) => (
          <Card key={b.id} className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-[12px] font-medium text-[#cbd7e6]">{b.date}</p>
              <div className="flex gap-3 text-[10.5px] text-[#6b7b91]">
                <span>{b.stats.calls} calls</span>
                <span>{b.stats.bookings} booked</span>
                <span>{money(b.stats.revenue)}</span>
                {b.stats.flags ? <span className="text-[#f2c86b]">{b.stats.flags} flagged</span> : null}
              </div>
            </div>
            <VoicePlayer src={b.audio_url} label={`Evening note · ${b.date}`} />
            <p className="mt-3 rounded-xl bg-[#080b10] p-3.5 text-[12.5px] leading-relaxed text-[#9fb0c5]">
              {b.transcript}
            </p>
          </Card>
        ))}
        {briefings.length === 0 ? (
          <Card className="p-10 text-center text-[13px] text-[#5a6b80]">
            No briefings yet. Tap “Generate now”.
          </Card>
        ) : null}
      </div>
    </main>
  );
}
