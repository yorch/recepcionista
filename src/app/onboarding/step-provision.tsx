'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/components/ui/cn';
import { ApiError, useApi } from '@/hooks/use-api';
import { prettyPhone } from './forwarding';
import type { StepProps } from './flow';

const PHASES = [
  'Saving everything she learned',
  'Choosing a local phone number',
  'Setting up her voice and script',
  'Final checks',
];

interface ProvisionOut { phone: string; mock: boolean }

export function ProvisionStep({ businessId, status, go, refresh }: StepProps) {
  const { busy, request } = useApi();
  const [phase, setPhase] = useState(0);
  const [error, setError] = useState<{ text: string; billing?: boolean } | null>(null);
  const [result, setResult] = useState<ProvisionOut | null>(null);
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { if (ticker.current) clearInterval(ticker.current); }, []);

  async function run() {
    setError(null);
    setPhase(0);
    ticker.current = setInterval(() => setPhase((p) => Math.min(p + 1, PHASES.length - 1)), 3500);
    try {
      const out = await request<ProvisionOut>(`/api/businesses/${businessId}/provision`, { method: 'POST', body: {}, timeoutMs: 120_000 });
      setResult({ phone: out.phone, mock: Boolean(out.mock) });
      await refresh();
    } catch (err) {
      const e = err as ApiError;
      if (e.status === 402) setError({ text: 'Your plan needs to be active before we can turn on a phone number. Start your free trial, then come back.', billing: true });
      else if (e.status === 409) {
        setError({ text: 'Your number is already being set up. Give it a moment, then check again.' });
        void refresh();
      } else if (e.status === 403 && /email/i.test(e.message)) setError({ text: 'Confirm your email address first (check your inbox for our link), then try again. Everything you entered is saved.' });
      else if (e.status === 403) setError({ text: 'This account cannot turn on a number yet. Everything you entered is saved. Please contact support to finish.' });
      else if (e.status === 429) setError({ text: 'Too many tries in a row. Wait a minute and try again.' });
      else if (e.status === 422) setError({ text: `We could not read your website: ${e.message}. Go back and enter your services by hand.` });
      else setError({ text: `${e.message}. Nothing was charged for a failed attempt. Try again.` });
    } finally {
      if (ticker.current) clearInterval(ticker.current);
    }
  }

  const phone = result?.phone ?? status.phone;
  const done = Boolean(result) || status.provisioned;

  if (done && phone) {
    const mock = result ? result.mock : status.phone_mock;
    return (
      <section aria-labelledby="prov-title">
        <h2 id="prov-title" className="text-[28px] font-semibold tracking-[-0.02em] text-white">She has a phone number</h2>
        <Card className="mt-6 p-6 text-center">
          <p className="text-xs uppercase tracking-wider text-dim">{status.name}</p>
          <p className="mt-2 font-mono text-[28px] tracking-tight text-white">{prettyPhone(phone)}</p>
          <p className="mt-2 flex items-center justify-center gap-2 text-xs text-mint-text">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-mint live-dot" /> Ready to answer
          </p>
        </Card>
        {mock ? (
          <p role="note" className="mt-4 rounded-xl border border-warn-line bg-warn-bg px-4 py-3 text-[13px] text-warn">
            This is a demo number (this server is not connected to a phone provider), so it cannot receive real calls yet.
          </p>
        ) : null}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button onClick={() => go('connect')} className="flex-1 sm:flex-none sm:px-8">Connect my business line →</Button>
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="prov-title">
      <h2 id="prov-title" className="text-[28px] font-semibold tracking-[-0.02em] text-white">Turn on her phone number</h2>
      <p className="mt-2 text-sm text-mute">
        We pick a local number for {status.name} and publish what she knows. This takes under a minute.
      </p>

      {busy ? (
        <Card className="mt-6 divide-y divide-[#1a2330]" aria-busy="true">
          {PHASES.map((label, i) => (
            <div key={label} className="flex items-center gap-3 px-5 py-4">
              <span aria-hidden="true" className={cn('grid h-6 w-6 place-items-center rounded-full text-xs',
                i < phase ? 'bg-mint text-[#042616]' : i === phase ? 'bg-brand text-on-brand' : 'bg-raised text-dim')}>
                {i < phase ? '✓' : i + 1}
              </span>
              <span className={cn('text-sm', i <= phase ? 'text-soft' : 'text-dim')}>{label}</span>
              {i === phase ? <span className="sr-only" role="status">In progress</span> : null}
            </div>
          ))}
        </Card>
      ) : (
        <Card className="mt-6 p-5">
          <ul className="space-y-2 text-[13px] text-soft">
            <li>Business: <span className="text-white">{status.name}</span></li>
            <li>Services saved: <span className="text-white">{status.knowledge?.services ?? 0}</span></li>
            <li>Alerts go to: <span className="font-mono text-white">{status.owner_phone ? prettyPhone(status.owner_phone) : 'not set'}</span></li>
          </ul>
        </Card>
      )}

      {error ? (
        <div role="alert" className="mt-4 rounded-xl border border-danger-line bg-danger-bg px-4 py-3 text-[13px] text-danger">
          <p>{error.text}</p>
          {error.billing ? <Button variant="outline" className="mt-3" onClick={() => go('plan')}>Go to plan</Button> : null}
        </div>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button onClick={run} disabled={busy} className="flex-1 sm:flex-none sm:px-8">
          {busy ? 'Turning on her number…' : error ? 'Try again' : 'Turn on her number →'}
        </Button>
        <Button variant="ghost" onClick={() => go('plan')} disabled={busy}>Back</Button>
      </div>
    </section>
  );
}
