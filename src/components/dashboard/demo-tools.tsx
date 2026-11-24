'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { useApi } from '@/hooks/use-api';
import type { Booking, Call, PaymentLink, SmsLog } from '@/lib/types';
import { money, whenET } from '@/lib/format';
import { useLocale, useT } from '@/lib/i18n/client';
import { formatPhoneDisplay } from '@/lib/i18n/core';

type Script = 'routine' | 'emergency' | 'spanish';

interface SimResult {
  call: Call;
  booking?: Booking | null;
  payment_link?: (PaymentLink & { mock?: boolean }) | null;
  sms: SmsLog[];
  simulated?: boolean;
}

/** The spoken lines are the demo caller's own words (they stay in the language the caller speaks); only the labels are localized. */
const SCRIPTS: { id: Script; line: string }[] = [
  { id: 'routine', line: '“My AC is blowing warm air, no leak.”' },
  { id: 'emergency', line: '“Water is pouring out of my ceiling.”' },
  { id: 'spanish', line: '“Quiero mantenimiento para el AC.”' },
];

export function DemoTools({ businessId, phone }: { businessId: string; phone?: string | null }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const { busy, call } = useApi();
  const [picked, setPicked] = useState<Script>('spanish');
  const [result, setResult] = useState<SimResult | null>(null);

  async function run() {
    setResult(null);
    const data = await call<SimResult>(
      '/api/demo/simulate-call',
      {
        body: {
          business_id: businessId,
          caller_name: picked === 'spanish' ? 'Rosa Delgado' : 'Marcus Lee',
          caller_phone: '+1305555' + Math.floor(1000 + Math.random() * 8999),
          script: picked,
        },
      },
      { loading: t('demo.answering'), success: (d: SimResult) => (d.simulated ? t('demo.replayed') : t('demo.handled')) },
    );
    if (data) {
      setResult(data);
      router.refresh();
    }
  }

  async function reset() {
    const data = await call('/api/demo/reset', { method: 'POST', body: {} }, { loading: t('demo.resetting'), success: t('demo.resetDone') });
    if (data !== undefined) {
      setResult(null);
      router.refresh();
    }
  }

  return (
    <div className="p-4">
      <div className="space-y-2" role="radiogroup" aria-label={t('demo.scriptLabel')}>
        {SCRIPTS.map((s) => (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={picked === s.id}
            onClick={() => setPicked(s.id)}
            className={cn(
              'flex min-h-11 w-full items-center justify-between gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors',
              picked === s.id
                ? 'border-brand/60 bg-[#1a1208]'
                : 'border-line bg-[#0a0e14] hover:border-line-3',
            )}
          >
            <div>
              <p className="text-[12.5px] text-white">{t(`demo.script.${s.id}` as const)}</p>
              <p className="mt-0.5 text-xs text-dim">{s.line}</p>
            </div>
            <span aria-hidden="true" className={cn('h-3 w-3 shrink-0 rounded-full border', picked === s.id ? 'border-brand bg-brand' : 'border-[#3a4757]')} />
          </button>
        ))}
      </div>

      <div className="mt-4 flex gap-2">
        <Button onClick={run} disabled={busy} className="flex-1">
          {busy ? t('demo.onPhone') : t('demo.callHer')}
        </Button>
        <Button onClick={reset} disabled={busy} variant="outline">{t('demo.reset')}</Button>
      </div>

      {phone ? (
        <p className="mt-3 text-center text-xs text-dim">
          {t('demo.orDial', { phone: formatPhoneDisplay(phone) })}
        </p>
      ) : null}

      {result ? (
        <div className="mt-5 space-y-3 border-t border-line pt-4">
          <div className="rounded-xl bg-sunken p-3.5">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-wider text-dim">{t('demo.whatSaid')}</p>
              <span className="text-xs text-dim">{result.call.duration_sec}s</span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-mute">{result.call.summary}</p>
          </div>

          {result.booking ? (
            <div className="rounded-xl border border-mint-line bg-[#0b1a14] p-3.5">
              <p className="text-xs uppercase tracking-wider text-mint-text">{t('demo.booked')}</p>
              <p className="mt-1.5 text-[12.5px] text-white">
                {result.booking.customer_name} · {result.booking.service}
              </p>
              <p className="text-xs text-dim">
                {whenET(result.booking.scheduled_at, undefined, locale)} · {money(result.booking.price_estimate, locale)}
              </p>
            </div>
          ) : null}

          {result.payment_link ? (
            <div className="rounded-xl border border-warn-line bg-[#1a1208] p-3.5">
              <p className="text-xs uppercase tracking-wider text-warn">{t('demo.depositLink')}</p>
              <a
                href={result.payment_link.url}
                target="_blank"
                rel="noreferrer"
                className="mt-1 block truncate font-mono text-xs text-brand-soft hover:underline"
              >
                {result.payment_link.url}
              </a>
              <p className="mt-1 text-xs text-dim">{money(result.payment_link.amount_cents, locale)}</p>
            </div>
          ) : null}

          {result.sms.length ? (
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-wider text-dim">{t('demo.textsSent')}</p>
              {result.sms.map((s) => (
                <div key={s.id} className="rounded-xl border border-line bg-[#0a0e14] p-3">
                  <div className="flex items-center justify-between">
                    <p className="font-mono text-xs text-dim">{s.to_phone}</p>
                    <span className="text-xs text-mint">{s.status}</span>
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-body">{s.body}</p>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
