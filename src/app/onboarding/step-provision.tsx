'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/components/ui/cn';
import { ApiError, useApi } from '@/hooks/use-api';
import { errorText } from '@/lib/i18n/api-errors';
import { useT } from '@/lib/i18n/client';
import { prettyPhone } from './forwarding';
import type { StepProps } from './flow';

const PHASES = ['pv.phase.0', 'pv.phase.1', 'pv.phase.2', 'pv.phase.3'] as const;

interface ProvisionOut { phone: string; mock: boolean }

export function ProvisionStep({ businessId, status, go, refresh }: StepProps) {
  const t = useT();
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
      if (e.status === 402) setError({ text: t('pv.err402'), billing: true });
      else if (e.status === 409) {
        setError({ text: t('pv.err409') });
        void refresh();
      } else if (e.status === 403 && /email/i.test(e.message)) setError({ text: t('pv.err403email') });
      else if (e.status === 403) setError({ text: t('pv.err403') });
      else if (e.status === 429) setError({ text: t('pv.err429') });
      else if (e.status === 422 && (e.payload as { code?: string } | undefined)?.code === 'kb_incomplete') {
        const blockers = ((e.payload as { blockers?: { message: string }[] }).blockers ?? []).map((b) => b.message);
        setError({ text: t('pv.errKb', { blockers: blockers.join(' ') || t('pv.errKbDefault') }) });
      } else if (e.status === 422) setError({ text: t('pv.err422', { message: errorText(t, e) }) });
      else if (e.status === 502 || e.status === 503) {
        setError({ text: t('pv.err5xx', { message: errorText(t, e) }) });
        void refresh();
      } else setError({ text: t('pv.errOther', { message: errorText(t, e) }) });
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
        <h2 id="prov-title" className="text-[28px] font-semibold tracking-[-0.02em] text-white">{t('pv.hasNumber')}</h2>
        <Card className="mt-6 p-6 text-center">
          <p className="text-xs uppercase tracking-wider text-dim">{status.name}</p>
          <p className="mt-2 font-mono text-[28px] tracking-tight text-white">{prettyPhone(phone)}</p>
          <p className="mt-2 flex items-center justify-center gap-2 text-xs text-mint-text">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-mint live-dot" /> {t('pv.ready')}
          </p>
        </Card>
        {mock ? (
          <p role="note" className="mt-4 rounded-xl border border-warn-line bg-warn-bg px-4 py-3 text-[13px] text-warn">
            {t('pv.mockNumber')}
          </p>
        ) : null}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button onClick={() => go('connect')} className="flex-1 sm:flex-none sm:px-8">{t('pv.connectLine')}</Button>
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="prov-title">
      <h2 id="prov-title" className="text-[28px] font-semibold tracking-[-0.02em] text-white">{t('pv.turnOnTitle')}</h2>
      <p className="mt-2 text-sm text-mute">
        {t('pv.turnOnLead', { name: status.name })}
      </p>

      {busy ? (
        <Card className="mt-6 divide-y divide-[#1a2330]" aria-busy="true">
          {PHASES.map((labelKey, i) => (
            <div key={labelKey} className="flex items-center gap-3 px-5 py-4">
              <span aria-hidden="true" className={cn('grid h-6 w-6 place-items-center rounded-full text-xs',
                i < phase ? 'bg-mint text-[#042616]' : i === phase ? 'bg-brand text-on-brand' : 'bg-raised text-dim')}>
                {i < phase ? '✓' : i + 1}
              </span>
              <span className={cn('text-sm', i <= phase ? 'text-soft' : 'text-dim')}>{t(labelKey)}</span>
              {i === phase ? <span className="sr-only" role="status">{t('info.inProgress')}</span> : null}
            </div>
          ))}
        </Card>
      ) : (
        <Card className="mt-6 p-5">
          <ul className="space-y-2 text-[13px] text-soft">
            <li>{t('pv.business')} <span className="text-white">{status.name}</span></li>
            <li>{t('pv.servicesSaved')} <span className="text-white">{status.knowledge?.services ?? 0}</span></li>
            <li>{t('pv.alertsGo')} <span className="font-mono text-white">{status.owner_phone ? prettyPhone(status.owner_phone) : t('pv.notSet')}</span></li>
          </ul>
        </Card>
      )}

      {status.provision_partial && !error ? (
        <p role="note" className="mt-4 rounded-xl border border-warn-line bg-warn-bg px-4 py-3 text-[13px] text-warn">
          {t('pv.partial', { phone: prettyPhone(status.provision_partial.phone), detail: status.provision_partial.error ? ` (${status.provision_partial.error})` : '' })}
        </p>
      ) : null}

      {error ? (
        <div role="alert" className="mt-4 rounded-xl border border-danger-line bg-danger-bg px-4 py-3 text-[13px] text-danger">
          <p>{error.text}</p>
          {error.billing ? <Button variant="outline" className="mt-3" onClick={() => go('plan')}>{t('pv.goToPlan')}</Button> : null}
        </div>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button onClick={run} disabled={busy} className="flex-1 sm:flex-none sm:px-8">
          {busy ? t('pv.turningOn') : error ? t('common.retry') : t('pv.turnOn')}
        </Button>
        <Button variant="ghost" onClick={() => go('plan')} disabled={busy}>{t('common.back')}</Button>
      </div>
    </section>
  );
}
