import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { demoModeEnabled } from '@/lib/auth';
import { hasTwilio } from '@/lib/providers/twilio';
import { hasElevenLabs } from '@/lib/voice/elevenlabs';
import { hasLlm } from '@/lib/providers/llm';
import { countCalls, getKnowledgeBase } from '@/lib/db';
import { getDashboardContext, requireRolePage } from '@/lib/dashboard-context';
import { Card, CardHead } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { getT } from '@/lib/i18n/server';
import { formatPhoneDisplay } from '@/lib/i18n/core';
import { DemoTools } from '@/components/dashboard/demo-tools';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('demo.metaTitle') };
}

export const dynamic = 'force-dynamic';

export default async function DemoPage() {
  // The demo console wipes data, fakes calls and sends demo texts: it does not exist unless demo mode is on (and never in production).
  if (!demoModeEnabled()) notFound();
  const t = await getT();
  const ctx = await getDashboardContext();
  requireRolePage(ctx, 'admin'); // demo console wipes data and sends SMS: admin only
  const biz = ctx.business;
  const kb = await getKnowledgeBase(biz.id);
  const callCount = await countCalls(biz.id);

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-8">
      <header>
        <h1 className="text-[24px] font-semibold tracking-[-0.02em]">{t('demo.title')}</h1>
        <p className="mt-1 text-[13px] text-mute">{t('demo.subtitle')}</p>
      </header>

      <div className="mt-6 grid gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Card>
            <CardHead title={t('demo.run')} subtitle={t('demo.runSub')} />
            <DemoTools businessId={biz.id} phone={biz.phone} />
          </Card>
        </div>

        <div className="flex flex-col gap-4 lg:col-span-2">
          <Card className="p-5">
            <p className="text-xs uppercase tracking-wider text-dim">{t('demo.callNow')}</p>
            <a
              href={biz.phone ? `tel:${biz.phone}` : undefined}
              className="mt-2 flex items-center gap-2.5 rounded-xl border border-mint-line bg-mint-bg px-4 py-3 font-mono text-xl font-semibold text-white hover:border-mint hover:bg-[#162e22] transition-colors"
            >
              <span className="h-2 w-2 rounded-full bg-mint animate-pulse" />
              {biz.phone ? formatPhoneDisplay(biz.phone) : t('demo.noNumber')}
            </a>
            <p className="mt-3 text-xs leading-relaxed text-dim">
              {t('demo.dial')}
            </p>
          </Card>

          <Card className="p-5">
            <p className="text-xs uppercase tracking-wider text-dim">{t('demo.loaded')}</p>
            <ul className="mt-2 space-y-1.5 text-[12px] text-body">
              <li className="flex justify-between"><span>{t('demo.calls')}</span><span className="tabular-nums">{callCount}</span></li>
              <li className="flex justify-between"><span>{t('demo.servicesInBrain')}</span><span className="tabular-nums">{kb?.services.length ?? 0}</span></li>
              <li className="flex justify-between"><span>{t('demo.faqs')}</span><span className="tabular-nums">{kb?.faqs.length ?? 0}</span></li>
            </ul>
            {!kb ? <p className="mt-3 text-xs text-warn">{t('demo.noKb')}</p> : null}
          </Card>

          <Card className="p-5">
            <p className="text-xs uppercase tracking-wider text-dim">{t('demo.integrations')}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge tone={hasElevenLabs() ? 'routine' : 'unsure'}>
                ElevenLabs {hasElevenLabs() ? t('demo.live') : t('demo.mock')}
              </Badge>
              <Badge tone={hasTwilio() ? 'routine' : 'unsure'}>
                Twilio {hasTwilio() ? t('demo.live') : t('demo.mock')}
              </Badge>
              <Badge tone={process.env.STRIPE_SECRET_KEY ? 'routine' : 'unsure'}>
                Stripe {process.env.STRIPE_SECRET_KEY ? t('demo.live') : t('demo.mock')}
              </Badge>
              <Badge tone={hasLlm() ? 'routine' : 'unsure'}>
                LLM {hasLlm() ? t('demo.live') : t('demo.mock')}
              </Badge>
            </div>
          </Card>
        </div>
      </div>
    </main>
  );
}
