import { getKnowledgeBase, listBusinesses } from '@/lib/db';
import { Card, CardHead } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { KnowledgeEditor } from '@/components/dashboard/knowledge-editor';
import { money } from '@/lib/format';
import { dollarsToCents } from '@/lib/money';

export const dynamic = 'force-dynamic';

export default async function KnowledgePage() {
  const biz = (await listBusinesses())[0];
  if (!biz) return null;
  const kb = await getKnowledgeBase(biz.id);

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[24px] font-semibold tracking-[-0.02em]">Her brain</h1>
          <p className="mt-1 text-[13px] text-[#8b98ab]">What she knows. Edit it and she picks it up on the next call.</p>
        </div>
        <Badge tone="brand">{biz.status === 'live' ? 'live' : biz.status}</Badge>
      </header>

      {!kb ? (
        <Card className="mt-6 p-10 text-center text-[13px] text-[#5a6b80]">
          No knowledge base yet — finish onboarding.
        </Card>
      ) : (
        <div className="mt-6 grid gap-4 lg:grid-cols-5">
          <div className="flex flex-col gap-4 lg:col-span-3">
            <Card>
              <CardHead title="Services & pricing" subtitle="She quotes these starting prices, never more" />
              <ul className="divide-y divide-[#171f2a]">
                {kb.services.map((s, i) => (
                  <li key={`${s.name}-${i}`} className="flex items-start justify-between gap-4 px-5 py-3">
                    <div>
                      <p className="text-[13px] text-white">{s.name}</p>
                      {s.description ? <p className="mt-0.5 text-[11px] leading-relaxed text-[#6b7b91]">{s.description}</p> : null}
                    </div>
                    <span className="shrink-0 tabular-nums text-[13px] text-[#9fb0c5]">
                      {s.base_price ? `from ${money(dollarsToCents(s.base_price))}` : 'quote'}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>

            <Card>
              <CardHead title="Answers she has memorized" />
              <ul className="divide-y divide-[#171f2a]">
                {kb.faqs.map((f, i) => (
                  <li key={i} className="px-5 py-3">
                    <p className="text-[12.5px] text-[#cbd7e6]">{f.question}</p>
                    <p className="mt-1 text-[11.5px] leading-relaxed text-[#7b8b9f]">{f.answer}</p>
                  </li>
                ))}
              </ul>
            </Card>
          </div>

          <div className="flex flex-col gap-4 lg:col-span-2">
            <KnowledgeEditor businessId={biz.id} initialPrompt={kb.system_prompt} initialScript={kb.call_script} />
            <Card className="p-5">
              <p className="text-[11px] uppercase tracking-wider text-[#6b7b91]">Serving</p>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-[#cbd7e6]">{biz.service_area.join(' · ')}</p>
              <p className="mt-4 text-[11px] uppercase tracking-wider text-[#6b7b91]">Number</p>
              <p className="mt-1.5 font-mono text-[12.5px] text-[#cbd7e6]">{biz.phone ?? 'not provisioned'}</p>
            </Card>
          </div>
        </div>
      )}
    </main>
  );
}
