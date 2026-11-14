import { listBusinesses, getKnowledgeBase, listCalls } from '@/lib/db';
import { Card, CardHead } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DemoTools } from '@/components/dashboard/demo-tools';

export const dynamic = 'force-dynamic';

export default async function DemoPage() {
  const biz = (await listBusinesses())[0];
  if (!biz) return null;
  const kb = await getKnowledgeBase(biz.id);
  const calls = await listCalls(biz.id);

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-8">
      <header>
        <h1 className="text-[24px] font-semibold tracking-[-0.02em]">Demo console</h1>
        <p className="mt-1 text-[13px] text-[#8b98ab]">Replay a call end-to-end without a phone, or reset to clean state before you present.</p>
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
            <p className="text-[11px] uppercase tracking-wider text-[#6b7b91]">Call her now</p>
            <a
              href={`tel:${process.env.ELEVENLABS_PHONE_NUMBER || biz.phone || ''}`}
              className="mt-2 flex items-center gap-2.5 rounded-xl border border-[#1c4635] bg-[#10291f] px-4 py-3 font-mono text-xl font-semibold text-white hover:border-[#3ddc97] hover:bg-[#162e22] transition-colors"
            >
              <span className="h-2 w-2 rounded-full bg-[#3ddc97] animate-pulse" />
              {process.env.ELEVENLABS_PHONE_NUMBER || biz.phone || '—'}
            </a>
            <p className="mt-3 text-[11px] leading-relaxed text-[#6b7b91]">
              Dial from any phone — she answers in English or Spanish. Bookings, deposits, and emergencies all land here within seconds.
            </p>
          </Card>

          <Card className="p-5">
            <p className="text-[11px] uppercase tracking-wider text-[#6b7b91]">Loaded state</p>
            <ul className="mt-2 space-y-1.5 text-[12px] text-[#9fb0c5]">
              <li className="flex justify-between"><span>Calls</span><span className="tabular-nums">{calls.length}</span></li>
              <li className="flex justify-between"><span>Services in brain</span><span className="tabular-nums">{kb?.services.length ?? 0}</span></li>
              <li className="flex justify-between"><span>FAQs</span><span className="tabular-nums">{kb?.faqs.length ?? 0}</span></li>
            </ul>
            {!kb ? <p className="mt-3 text-[11px] text-[#f2c86b]">No knowledge base — run onboarding first.</p> : null}
          </Card>

          <Card className="p-5">
            <p className="text-[11px] uppercase tracking-wider text-[#6b7b91]">Integrations</p>
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
