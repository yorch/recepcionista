import type { Metadata } from 'next';
import { getKnowledgeBase, listAuditEvents, listKbChanges, prisma } from '@/lib/db';
import { getLocale, getT } from '@/lib/i18n/server';
import { formatPhoneDisplay } from '@/lib/i18n/core';
import { hasRole } from '@/lib/session';
import { getDashboardContext } from '@/lib/dashboard-context';
import { tzOf } from '@/lib/time';
import { Card, CardHead } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty';
import { PageHeader } from '@/components/ui/page-header';
import { KnowledgeEditor } from '@/components/dashboard/knowledge-editor';
import { KbChanges } from '@/components/dashboard/kb-changes';
import { publicKbChange } from '@/lib/voice/owner/view';
import { OwnerReplies } from '@/components/dashboard/owner-replies';
import { publicOwnerReply } from '@/lib/voice/owner/reply-view';
import { ReadinessChecklist } from '@/components/knowledge/readiness-checklist';
import { readinessOf } from '@/lib/kb/readiness';
import { money } from '@/lib/format';
import { dollarsToCents } from '@/lib/money';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('kb.metaTitle') };
}

export const dynamic = 'force-dynamic';

export default async function KnowledgePage() {
  const t = await getT();
  const locale = await getLocale();
  const ctx = await getDashboardContext();
  const biz = ctx.business;
  const isOwner = hasRole(ctx.principal, 'owner');
  const kb = await getKnowledgeBase(biz.id);
  const extracted = isOwner && kb ? (await listAuditEvents({ business_id: biz.id, action: 'knowledge.extracted', limit: 1 }))[0] : undefined;
  const meta = (extracted?.meta ?? {}) as { url?: unknown };
  const kbChanges = isOwner && kb ? await listKbChanges(biz.id, { limit: 10 }) : null;
  const ownerReplies = isOwner && kb ? (await prisma.ownerReply.findMany({ where: { businessId: biz.id }, orderBy: { createdAt: 'desc' }, take: 10 })).map((r) => publicOwnerReply(r)) : null;

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
      <PageHeader
        title={t('kb.title')}
        subtitle={t('kb.subtitle')}
        right={<Badge tone="brand">{t(`kb.status.${biz.status}` as const)}</Badge>}
      />

      {!kb ? (
        <div className="mt-6">
          <EmptyState
            title={t('kb.empty.title')}
            body={t('kb.empty.body')}
            cta={isOwner ? { href: '/onboarding', label: t('kb.empty.cta') } : undefined}
          />
        </div>
      ) : isOwner ? (
        <div className="mt-6">
          <ReadinessChecklist readiness={readinessOf(kb, biz, locale)} className="mb-6" />
          <KnowledgeEditor
            businessId={biz.id}
            business={{ name: biz.name, owner_name: biz.owner_name ?? null, service_area: biz.service_area, hours: biz.hours, url: biz.url ?? null, vertical: biz.vertical ?? 'hvac' }}
            kb={{ services: kb.services, faqs: kb.faqs, pricing_notes: kb.pricing_notes, call_script: kb.call_script, system_prompt: kb.system_prompt }}
            lastExtracted={extracted ? { url: typeof meta.url === 'string' ? meta.url : null, at: extracted.at } : null}
            timeZone={tzOf(biz)}
          />
          {kbChanges ? (
            <div className="mt-6">
              <KbChanges businessId={biz.id} initial={{ items: kbChanges.items.map(publicKbChange), next_cursor: kbChanges.next_cursor }} nowMs={new Date().getTime()} />
            </div>
          ) : null}
          {ownerReplies ? (
            <div className="mt-6">
              <OwnerReplies items={ownerReplies} nowMs={new Date().getTime()} locale={locale} t={t} />
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mt-6 grid gap-4 lg:grid-cols-5">
          <div className="flex flex-col gap-4 lg:col-span-3">
            <Card>
              <CardHead title={t('kb.ro.services')} subtitle={t('kb.ro.servicesSub')} />
              <ul className="divide-y divide-[#171f2a]">
                {kb.services.map((s, i) => (
                  <li key={`${s.name}-${i}`} className="flex items-start justify-between gap-4 px-5 py-3">
                    <div>
                      <p className="text-[13px] text-white">{s.name}</p>
                      {s.description ? <p className="mt-0.5 text-xs leading-relaxed text-dim">{s.description}</p> : null}
                    </div>
                    <span className="shrink-0 tabular-nums text-[13px] text-body">
                      {s.base_price ? t('kb.ro.from', { price: money(dollarsToCents(s.base_price), locale) }) : t('kb.ro.quote')}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
            <Card>
              <CardHead title={t('kb.ro.faqs')} />
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
            <h2 className="text-xs font-medium uppercase tracking-wider text-dim">{t('kb.ro.serving')}</h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-soft">{biz.service_area.join(' · ') || t('kb.ro.notSet')}</p>
            {(biz.closed_dates ?? []).length > 0 && (
              <>
                <h2 className="mt-4 text-xs font-medium uppercase tracking-wider text-dim">{t('kb.ro.closedOn')}</h2>
                <p className="mt-1.5 text-[13px] leading-relaxed text-soft">{(biz.closed_dates ?? []).slice(0, 12).join(' · ')}{(biz.closed_dates ?? []).length > 12 ? ' …' : ''}</p>
              </>
            )}
            <h2 className="mt-4 text-xs font-medium uppercase tracking-wider text-dim">{t('kb.ro.number')}</h2>
            <p className="mt-1.5 font-mono text-[13px] text-soft">{biz.phone ? formatPhoneDisplay(biz.phone) : t('kb.ro.notProvisioned')}</p>
            <p className="mt-4 text-xs text-dim">{t('kb.ro.ownerOnly')}</p>
          </Card>
        </div>
      )}
    </main>
  );
}
