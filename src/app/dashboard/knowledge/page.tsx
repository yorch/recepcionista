import { getKnowledgeBase, listAuditEvents } from '@/lib/db';
import { hasRole } from '@/lib/session';
import { getDashboardContext } from '@/lib/dashboard-context';
import { tzOf } from '@/lib/time';
import { Card, CardHead } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty';
import { PageHeader } from '@/components/ui/page-header';
import { KnowledgeEditor } from '@/components/dashboard/knowledge-editor';
import { money } from '@/lib/format';
import { dollarsToCents } from '@/lib/money';

export const dynamic = 'force-dynamic';

export default async function KnowledgePage() {
  const ctx = await getDashboardContext();
  const biz = ctx.business;
  const isOwner = hasRole(ctx.principal, 'owner');
  const kb = await getKnowledgeBase(biz.id);
  const extracted = isOwner && kb ? (await listAuditEvents({ business_id: biz.id, action: 'knowledge.extracted', limit: 1 }))[0] : undefined;
  const meta = (extracted?.meta ?? {}) as { url?: unknown };

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
      <PageHeader
        title="Her brain"
        subtitle="What she knows. Edit it and she picks it up on the next call."
        right={<Badge tone="brand">{biz.status === 'live' ? 'live' : biz.status}</Badge>}
      />

      {!kb ? (
        <div className="mt-6">
          <EmptyState
            title="She does not know your business yet"
            body="Add your services, prices and hours so she can answer callers correctly. It takes a couple of minutes."
            cta={isOwner ? { href: '/onboarding', label: 'Teach her your business' } : undefined}
          />
        </div>
      ) : isOwner ? (
        <div className="mt-6">
          <KnowledgeEditor
            businessId={biz.id}
            business={{ name: biz.name, owner_name: biz.owner_name ?? null, service_area: biz.service_area, hours: biz.hours, url: biz.url ?? null }}
            kb={{ services: kb.services, faqs: kb.faqs, pricing_notes: kb.pricing_notes, call_script: kb.call_script, system_prompt: kb.system_prompt }}
            lastExtracted={extracted ? { url: typeof meta.url === 'string' ? meta.url : null, at: extracted.at } : null}
            timeZone={tzOf(biz)}
          />
        </div>
      ) : (
        <div className="mt-6 grid gap-4 lg:grid-cols-5">
          <div className="flex flex-col gap-4 lg:col-span-3">
            <Card>
              <CardHead title="Services and pricing" subtitle="She quotes these starting prices, never more" />
              <ul className="divide-y divide-[#171f2a]">
                {kb.services.map((s, i) => (
                  <li key={`${s.name}-${i}`} className="flex items-start justify-between gap-4 px-5 py-3">
                    <div>
                      <p className="text-[13px] text-white">{s.name}</p>
                      {s.description ? <p className="mt-0.5 text-xs leading-relaxed text-dim">{s.description}</p> : null}
                    </div>
                    <span className="shrink-0 tabular-nums text-[13px] text-body">
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
                    <p className="text-[13px] text-soft">{f.question}</p>
                    <p className="mt-1 text-xs leading-relaxed text-body">{f.answer}</p>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
          <Card className="h-fit p-5 lg:col-span-2">
            <h2 className="text-xs font-medium uppercase tracking-wider text-dim">Serving</h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-soft">{biz.service_area.join(' · ') || 'Not set'}</p>
            <h2 className="mt-4 text-xs font-medium uppercase tracking-wider text-dim">Number</h2>
            <p className="mt-1.5 font-mono text-[13px] text-soft">{biz.phone ?? 'not provisioned'}</p>
            <p className="mt-4 text-xs text-dim">Only the account owner can edit what she knows.</p>
          </Card>
        </div>
      )}
    </main>
  );
}
