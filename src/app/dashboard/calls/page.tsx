import { listBusinesses, listCalls } from '@/lib/db';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { relative, seconds, whenET } from '@/lib/format';

export const dynamic = 'force-dynamic';

const LANG_LABEL: Record<string, string> = { en: 'English', es: 'Español', mixed: 'Spanglish' };
const LANG_TONE: Record<string, string> = { en: 'neutral', es: 'brand', mixed: 'sky' };

export default async function CallsPage() {
  const biz = listBusinesses()[0];
  if (!biz) return null;
  const calls = listCalls(biz.id);

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-8">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-[24px] font-semibold tracking-[-0.02em]">Calls</h1>
          <p className="mt-1 text-[13px] text-[#8b98ab]">Every conversation, transcribed and triaged.</p>
        </div>
        <span className="text-[11px] text-[#6b7b91]">{calls.length} total</span>
      </header>

      <div className="mt-6 flex flex-col gap-3">
        {calls.map((c) => (
          <Card key={c.id} className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#161e29] text-[12px] font-medium text-[#9fb0c5]">
                  {(c.caller_name ?? c.caller_phone ?? '?').slice(0, 2).toUpperCase()}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-[13.5px] font-medium text-white">{c.caller_name ?? 'Unknown caller'}</p>
                    <Badge tone={LANG_TONE[c.language ?? 'en']}>{LANG_LABEL[c.language ?? 'en']}</Badge>
                    {c.urgency !== 'routine' ? <Badge tone={c.urgency}>{c.urgency}</Badge> : null}
                  </div>
                  <p className="mt-0.5 font-mono text-[11px] text-[#5a6b80]">
                    {c.caller_phone} · {relative(c.started_at)} · {seconds(c.duration_sec)}
                  </p>
                </div>
              </div>
              {c.flagged_reason ? (
                <span className="rounded-lg border border-[#473817] bg-[#2e2410] px-2.5 py-1 text-[10.5px] text-[#f2c86b]">
                  needs you
                </span>
              ) : (
                <span className="rounded-lg border border-[#1c4635] bg-[#10291f] px-2.5 py-1 text-[10.5px] text-[#6ee7b0]">
                  handled
                </span>
              )}
            </div>

            {c.summary ? (
              <p className="mt-3 text-[12.5px] leading-relaxed text-[#9fb0c5]">{c.summary}</p>
            ) : null}

            {c.flagged_reason ? (
              <p className="mt-2 rounded-lg bg-[#1a1208] px-3 py-2 text-[11.5px] text-[#f2c86b]">{c.flagged_reason}</p>
            ) : null}

            {c.transcript ? (
              <details className="group mt-3">
                <summary className="cursor-pointer list-none text-[11px] text-[#6b7b91] transition-colors hover:text-[#ff8f5e]">
                  <span className="group-open:hidden">Show transcript ▾</span>
                  <span className="hidden group-open:inline">Hide transcript ▴</span>
                </summary>
                <p className="mt-2 max-h-48 overflow-y-auto rounded-lg bg-[#080b10] p-3.5 text-[12px] leading-relaxed text-[#8b98ab]">
                  {c.transcript}
                </p>
              </details>
            ) : null}
          </Card>
        ))}
        {calls.length === 0 ? (
          <Card className="p-10 text-center text-[13px] text-[#5a6b80]">No calls yet.</Card>
        ) : null}
      </div>
    </main>
  );
}
