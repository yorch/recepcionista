import type { Metadata } from 'next';
import { countCalls, getKnowledgeBase } from '@/lib/db';
import { getDashboardContext, requireRolePage } from '@/lib/dashboard-context';
import { Card, CardHead } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DemoTools } from '@/components/dashboard/demo-tools';

export const metadata: Metadata = { title: 'Demo console' };

export const dynamic = 'force-dynamic';

export default async function DemoPage() {
  const ctx = await getDashboardContext();
  requireRolePage(ctx, 'admin'); // demo console wipes data and sends SMS: admin only
  const biz = ctx.business;
  const kb = await getKnowledgeBase(biz.id);
  const callCount = await countCalls(biz.id);

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-8">
      <header>
        <h1 className="text-[24px] font-semibold tracking-[-0.02em]">Demo console</h1>
        <p className="mt-1 text-[13px] text-mute">Replay a call end-to-end without a phone, or reset to clean state before you present.</p>
      </header>

      <div className="mt-6 grid gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Card>
            <CardHead title="Run a call" subtitle="Hits the same tools the voice agent uses" />
            <DemoTools businessId={biz.id} phone={biz.phone} />
          </Card>
        </div>

        <div className="flex flex-col gap-4 lg:col-span-2">
          <Card className="p-5">
            <p className="text-xs uppercase tracking-wider text-dim">Call her now</p>
            <a
              href={biz.phone ? `tel:${biz.phone}` : undefined}
              className="mt-2 flex items-center gap-2.5 rounded-xl border border-mint-line bg-mint-bg px-4 py-3 font-mono text-xl font-semibold text-white hover:border-mint hover:bg-[#162e22] transition-colors"
            >
              <span className="h-2 w-2 rounded-full bg-mint animate-pulse" />
              {biz.phone || 'No number yet'}
            </a>
            <p className="mt-3 text-xs leading-relaxed text-dim">
              Dial from any phone — she answers in English or Spanish. Bookings, deposits, and emergencies all land here within seconds.
            </p>
          </Card>

          <Card className="p-5">
            <p className="text-xs uppercase tracking-wider text-dim">Loaded state</p>
            <ul className="mt-2 space-y-1.5 text-[12px] text-body">
              <li className="flex justify-between"><span>Calls</span><span className="tabular-nums">{callCount}</span></li>
              <li className="flex justify-between"><span>Services in brain</span><span className="tabular-nums">{kb?.services.length ?? 0}</span></li>
              <li className="flex justify-between"><span>FAQs</span><span className="tabular-nums">{kb?.faqs.length ?? 0}</span></li>
            </ul>
            {!kb ? <p className="mt-3 text-xs text-warn">No knowledge base — run onboarding first.</p> : null}
          </Card>

          <Card className="p-5">
            <p className="text-xs uppercase tracking-wider text-dim">Integrations</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge tone={process.env.ELEVENLABS_API_KEY ? 'routine' : 'unsure'}>
                ElevenLabs {process.env.ELEVENLABS_API_KEY ? 'live' : 'mock'}
              </Badge>
              <Badge tone={process.env.TWILIO_AUTH_TOKEN ? 'routine' : 'unsure'}>
                Twilio {process.env.TWILIO_AUTH_TOKEN ? 'live' : 'mock'}
              </Badge>
              <Badge tone={process.env.STRIPE_SECRET_KEY ? 'routine' : 'unsure'}>
                Stripe {process.env.STRIPE_SECRET_KEY ? 'live' : 'mock'}
              </Badge>
              <Badge tone={process.env.OPENAI_API_KEY ? 'routine' : 'unsure'}>
                LLM {process.env.OPENAI_API_KEY ? 'live' : 'mock'}
              </Badge>
            </div>
          </Card>
        </div>
      </div>
    </main>
  );
}
