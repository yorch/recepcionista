'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import type { ApiResult, Booking, Call, PaymentLink, SmsLog } from '@/lib/types';
import { money, whenET } from '@/lib/format';

type Script = 'routine' | 'emergency' | 'spanish';

interface SimResult {
  call: Call;
  booking?: Booking | null;
  payment_link?: (PaymentLink & { mock?: boolean }) | null;
  sms: SmsLog[];
  simulated?: boolean;
}

const SCRIPTS: { id: Script; label: string; line: string; tone: string }[] = [
  { id: 'routine', label: 'Routine · English', line: '“My AC is blowing warm air, no leak.”', tone: 'neutral' },
  { id: 'emergency', label: 'Emergency · English', line: '“Water is pouring out of my ceiling.”', tone: 'emergency' },
  { id: 'spanish', label: 'Español · Rutina', line: '“Quiero mantenimiento para el AC.”', tone: 'brand' },
];

export function DemoTools({ businessId, phone }: { businessId: string; phone?: string | null }) {
  const router = useRouter();
  const [picked, setPicked] = useState<Script>('spanish');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SimResult | null>(null);

  async function run() {
    setBusy(true);
    setResult(null);
    const t = toast.loading('Answering the phone…');
    try {
      const res = await fetch('/api/demo/simulate-call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          business_id: businessId,
          caller_name: picked === 'spanish' ? 'Rosa Delgado' : 'Marcus Lee',
          caller_phone: '+1305555' + Math.floor(1000 + Math.random() * 8999),
          script: picked,
        }),
      });
      const json = (await res.json()) as ApiResult<SimResult>;
      if (!json.ok) throw new Error(json.error);
      setResult(json.data);
      toast.success(json.data.simulated ? 'Replayed (demo mode)' : 'Call handled', { id: t });
      router.refresh();
    } catch (err) {
      toast.error((err as Error).message, { id: t });
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    const t = toast.loading('Resetting…');
    try {
      const res = await fetch('/api/demo/reset', { method: 'POST' });
      const json = (await res.json()) as ApiResult<unknown>;
      if (!json.ok) throw new Error(json.error);
      setResult(null);
      toast.success('Back to clean demo state', { id: t });
      router.refresh();
    } catch (err) {
      toast.error((err as Error).message, { id: t });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-4">
      <div className="space-y-2">
        {SCRIPTS.map((s) => (
          <button
            key={s.id}
            onClick={() => setPicked(s.id)}
            className={cn(
              'flex w-full items-center justify-between gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors',
              picked === s.id
                ? 'border-[#ff6b35]/60 bg-[#1a1208]'
                : 'border-[#1f2937] bg-[#0a0e14] hover:border-[#2a3546]',
            )}
          >
            <div>
              <p className="text-[12.5px] text-white">{s.label}</p>
              <p className="mt-0.5 text-[11px] text-[#6b7b91]">{s.line}</p>
            </div>
            <span className={cn('h-3 w-3 shrink-0 rounded-full border', picked === s.id ? 'border-[#ff6b35] bg-[#ff6b35]' : 'border-[#3a4757]')} />
          </button>
        ))}
      </div>

      <div className="mt-4 flex gap-2">
        <Button onClick={run} disabled={busy} className="flex-1">
          {busy ? 'On the phone…' : 'Call her →'}
        </Button>
        <Button onClick={reset} disabled={busy} variant="outline">Reset</Button>
      </div>

      {phone ? (
        <p className="mt-3 text-center text-[11px] text-[#5a6b80]">
          Or dial <span className="font-mono text-[#9fb0c5]">{phone}</span> for real
        </p>
      ) : null}

      {result ? (
        <div className="mt-5 space-y-3 border-t border-[#1f2937] pt-4">
          <div className="rounded-xl bg-[#080b10] p-3.5">
            <div className="flex items-center justify-between">
              <p className="text-[11px] uppercase tracking-wider text-[#6b7b91]">What she said</p>
              <span className="text-[10.5px] text-[#5a6b80]">{result.call.duration_sec}s</span>
            </div>
            <p className="mt-2 text-[11.5px] leading-relaxed text-[#8b98ab]">{result.call.summary}</p>
          </div>

          {result.booking ? (
            <div className="rounded-xl border border-[#1c4635] bg-[#0b1a14] p-3.5">
              <p className="text-[11px] uppercase tracking-wider text-[#6ee7b0]">Booked</p>
              <p className="mt-1.5 text-[12.5px] text-white">
                {result.booking.customer_name} · {result.booking.service}
              </p>
              <p className="text-[11.5px] text-[#7b8b9f]">
                {whenET(result.booking.scheduled_at)} · {money(result.booking.price_estimate)}
              </p>
            </div>
          ) : null}

          {result.payment_link ? (
            <div className="rounded-xl border border-[#473817] bg-[#1a1208] p-3.5">
              <p className="text-[11px] uppercase tracking-wider text-[#f2c86b]">Deposit link</p>
              <a
                href={result.payment_link.url}
                target="_blank"
                rel="noreferrer"
                className="mt-1 block truncate font-mono text-[11px] text-[#ff8f5e] hover:underline"
              >
                {result.payment_link.url}
              </a>
              <p className="mt-1 text-[11px] text-[#7b8b9f]">{money(result.payment_link.amount_cents)}</p>
            </div>
          ) : null}

          {result.sms.length ? (
            <div className="space-y-2">
              <p className="text-[11px] uppercase tracking-wider text-[#6b7b91]">Texts sent</p>
              {result.sms.map((s) => (
                <div key={s.id} className="rounded-xl border border-[#1f2937] bg-[#0a0e14] p-3">
                  <div className="flex items-center justify-between">
                    <p className="font-mono text-[10px] text-[#5a6b80]">{s.to_phone}</p>
                    <span className="text-[10px] text-[#3ddc97]">{s.status}</span>
                  </div>
                  <p className="mt-1.5 text-[11.5px] leading-relaxed text-[#9fb0c5]">{s.body}</p>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
