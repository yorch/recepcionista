'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { ApiResult, Business, ExtractionResult, KnowledgeBase } from '@/lib/types';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { money } from '@/lib/format';

type Stage = 'input' | 'extracting' | 'review' | 'provisioning' | 'done';

const STEPS = [
  'Reading your website',
  'Pulling services and prices',
  'Learning your hours and area',
  'Writing her call script',
  'Turning on a phone number',
];

/** The shared ElevenLabs voice line — inbound SIP trunk. */
const VOICE_LINE = '+12028972767';

export default function OnboardingPage() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>('input');
  const [url, setUrl] = useState('');
  const [ownerName, setOwnerName] = useState('Jorge');
  const [ownerPhone, setOwnerPhone] = useState('+13055550199');
  const [step, setStep] = useState(0);
  const [business, setBusiness] = useState<Business | null>(null);
  const [extraction, setExtraction] = useState<ExtractionResult | null>(null);
  const [kb, setKb] = useState<KnowledgeBase | null>(null);
  const [phone, setPhone] = useState<string | null>(null);

  async function start() {
    if (!url.trim()) {
      toast.error('Paste your website or Google Business link first');
      return;
    }
    setStage('extracting');
    setStep(0);

    const ticker = setInterval(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), 1100);

    try {
      const created = await post<Business>('/api/businesses', {
        name: 'New business',
        url,
        owner_name: ownerName,
        owner_phone: ownerPhone,
      });
      setBusiness(created);

      const ex = await post<ExtractionResult>('/api/extract', { url });
      setExtraction(ex);

      const patched = await patch<Business>(`/api/businesses/${created.id}`, {
        name: ex.name,
        hours: ex.hours,
        service_area: ex.service_area,
      });
      setBusiness(patched);
      clearInterval(ticker);
      setStep(STEPS.length - 1);
      setStage('review');
      toast.success(`Found ${ex.services.length} services`);
    } catch (err) {
      clearInterval(ticker);
      setStage('input');
      toast.error((err as Error).message);
    }
  }

  async function goLive() {
    if (!business) return;
    setStage('provisioning');
    try {
      const res = await post<{ business: Business; knowledge_base: KnowledgeBase; phone: string; mock: boolean }>(
        `/api/businesses/${business.id}/provision`,
        {},
      );
      setBusiness(res.business);
      setKb(res.knowledge_base);
      setPhone(res.phone);
      setStage('done');
      toast.success('She is live');
    } catch (err) {
      setStage('review');
      toast.error((err as Error).message);
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <div className="flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-[#ff6b35] text-[15px] font-bold text-[#150800]">R</span>
          <span className="text-[15px] font-semibold tracking-tight">Recepcionista</span>
        </Link>
        <span className="text-[11px] text-[#5a6b80]">Step {stage === 'input' ? 1 : stage === 'done' ? 3 : 2} of 3</span>
      </div>

      {stage === 'input' ? (
        <section className="rise mt-14">
          <h1 className="text-[34px] font-semibold leading-tight tracking-[-0.02em]">
            Who are we hiring for?
          </h1>
          <p className="mt-2 text-sm text-[#8b98ab]">
            Paste a website or a Google Business link. That is the whole setup.
          </p>

          <Card className="mt-7 p-5">
            <label className="text-[11px] uppercase tracking-wider text-[#6b7b91]">Business website</label>
            <input
              autoFocus
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && start()}
              placeholder="miamicoolair.com"
              className="mt-2 w-full rounded-xl border border-[#26313f] bg-[#080b10] px-4 py-3 text-[15px] text-white outline-none transition placeholder:text-[#4a5b70] focus:border-[#ff6b35]/60"
            />
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div>
                <label className="text-[11px] uppercase tracking-wider text-[#6b7b91]">Your name</label>
                <input
                  value={ownerName}
                  onChange={(e) => setOwnerName(e.target.value)}
                  className="mt-2 w-full rounded-xl border border-[#26313f] bg-[#080b10] px-4 py-2.5 text-sm text-white outline-none focus:border-[#ff6b35]/60"
                />
              </div>
              <div>
                <label className="text-[11px] uppercase tracking-wider text-[#6b7b91]">Your cell (for briefings)</label>
                <input
                  value={ownerPhone}
                  onChange={(e) => setOwnerPhone(e.target.value)}
                  className="mt-2 w-full rounded-xl border border-[#26313f] bg-[#080b10] px-4 py-2.5 font-mono text-sm text-white outline-none focus:border-[#ff6b35]/60"
                />
              </div>
            </div>
            <Button onClick={start} className="mt-5 w-full py-3">
              Read my website →
            </Button>
          </Card>

          <p className="mt-4 text-center text-[11px] text-[#5a6b80]">
            Or <button onClick={() => router.push('/dashboard')} className="text-[#ff8f5e] underline-offset-2 hover:underline">see a live one</button> first.
          </p>
        </section>
      ) : null}

      {stage === 'extracting' ? (
        <section className="rise mt-14">
          <h1 className="text-[30px] font-semibold tracking-[-0.02em]">Teaching her your business…</h1>
          <p className="mt-2 text-sm text-[#8b98ab]">{url}</p>
          <Card className="mt-7 divide-y divide-[#1a2330]">
            {STEPS.map((label, i) => (
              <div key={label} className="flex items-center gap-3 px-5 py-4">
                <span
                  className={cn(
                    'grid h-6 w-6 place-items-center rounded-full text-[11px]',
                    i < step ? 'bg-[#3ddc97] text-[#042616]'
                      : i === step ? 'bg-[#ff6b35] text-[#150800]'
                      : 'bg-[#161e29] text-[#5a6b80]',
                  )}
                >
                  {i < step ? '✓' : i + 1}
                </span>
                <span className={cn('text-sm', i <= step ? 'text-[#cbd7e6]' : 'text-[#5a6b80]')}>{label}</span>
                {i === step ? (
                  <span className="ml-auto flex h-3 items-end gap-[2px]">
                    {[0, 1, 2].map((b) => (
                      <span key={b} className="bar w-[3px] rounded-full bg-[#ff6b35]" style={{ height: 12, animationDelay: `${b * 140}ms` }} />
                    ))}
                  </span>
                ) : null}
              </div>
            ))}
          </Card>
        </section>
      ) : null}

      {(stage === 'review' || stage === 'provisioning') && business && extraction ? (
        <section className="rise mt-12">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-[28px] font-semibold tracking-[-0.02em]">{business.name}</h1>
              <p className="mt-1 text-sm text-[#8b98ab]">
                {extraction.confidence === 'low' ? 'Thin website — I used a safe template. Fix anything below.' : 'Here is what she learned. Fix anything before she goes live.'}
              </p>
            </div>
            <span className="rounded-full border border-[#2a3546] px-2.5 py-1 text-[11px] text-[#8b98ab]">
              {extraction.source === 'template' ? 'template' : 'from your site'}
            </span>
          </div>

          <Card className="mt-6">
            <div className="border-b border-[#1f2937] px-5 py-3 text-[11px] uppercase tracking-wider text-[#6b7b91]">Services & pricing</div>
            <ul className="divide-y divide-[#171f2a]">
              {extraction.services.slice(0, 7).map((s, i) => (
                <li key={`${s.name}-${i}`} className="flex items-start justify-between gap-4 px-5 py-3">
                  <div>
                    <p className="text-[13px] text-white">{s.name}</p>
                    {s.description ? <p className="mt-0.5 text-[11px] leading-relaxed text-[#6b7b91]">{s.description}</p> : null}
                  </div>
                  <span className="shrink-0 tabular-nums text-[13px] text-[#9fb0c5]">
                    {s.base_price ? `from ${money(s.base_price)}` : 'quote'}
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Card className="p-5">
              <p className="text-[11px] uppercase tracking-wider text-[#6b7b91]">Serving</p>
              <p className="mt-2 text-[13px] leading-relaxed text-[#cbd7e6]">
                {extraction.service_area.join(' · ') || 'Miami-Dade'}
              </p>
            </Card>
            <Card className="p-5">
              <p className="text-[11px] uppercase tracking-wider text-[#6b7b91]">Hours</p>
              <p className="mt-2 text-[13px] leading-relaxed text-[#cbd7e6]">
                Mon–Fri 8–6 · Sat 9–2 · Sun closed
              </p>
            </Card>
          </div>

          <div className="mt-6 flex items-center gap-3">
            <Button onClick={goLive} disabled={stage === 'provisioning'} className="flex-1 py-3">
              {stage === 'provisioning' ? 'Turning on her number…' : 'Go live →'}
            </Button>
            <Button variant="outline" onClick={() => setStage('input')}>Back</Button>
          </div>
          <p className="mt-3 text-center text-[11px] text-[#5a6b80]">
            This provisions a real phone number and publishes her system prompt.
          </p>
        </section>
      ) : null}

      {stage === 'done' && business ? (
        <section className="rise mt-14 text-center">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-[#3ddc97]/15 text-2xl text-[#3ddc97]">✓</div>
          <h1 className="mt-5 text-[30px] font-semibold tracking-[-0.02em]">{firstNameOf(business.name)} is answering.</h1>
          <p className="mt-2 text-sm text-[#8b98ab]">Give this number to a customer. Or call it yourself.</p>

          <div className="mx-auto mt-7 max-w-sm rounded-2xl border border-[#2a3546] bg-[#0b1017] p-6">
            <p className="text-[11px] uppercase tracking-wider text-[#6b7b91]">Your AI front desk</p>
            <a
              href={`tel:${VOICE_LINE || phone || ""}`}
              className="mt-2 block font-mono text-2xl tracking-tight text-white hover:text-[#3ddc97] transition-colors"
            >
              {VOICE_LINE || phone || business.phone}
            </a>
            <div className="mt-3 flex items-center justify-center gap-2 text-[11px] text-[#3ddc97]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#3ddc97] live-dot" /> live now
            </div>
          </div>

          {kb ? (
            <div className="mx-auto mt-6 max-w-lg rounded-2xl border border-[#1f2937] bg-[#0b1017] p-4 text-left">
              <p className="text-[11px] uppercase tracking-wider text-[#6b7b91]">She opens every call with</p>
              <p className="mt-2 text-[13px] leading-relaxed text-[#cbd7e6]">
                “Gracias por llamar a {business.name}, le habla Maria. ¿En qué le puedo ayudar?”
              </p>
            </div>
          ) : null}

          <div className="mt-8 flex justify-center gap-3">
            <Button onClick={() => router.push(`/dashboard`)}>Open the dashboard →</Button>
            <Button variant="outline" onClick={() => router.push('/onboarding')}>Add another</Button>
          </div>
        </section>
      ) : null}
    </main>
  );
}

function firstNameOf(name: string) {
  return name.split(' ')[0] || 'She';
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as ApiResult<T>;
  if (!json.ok) throw new Error(json.error);
  return json.data;
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as ApiResult<T>;
  if (!json.ok) throw new Error(json.error);
  return json.data;
}
