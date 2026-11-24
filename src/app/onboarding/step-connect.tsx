'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/components/ui/cn';
import { useCopy } from '@/hooks/use-copy';
import { useT } from '@/lib/i18n/client';
import {
  CARRIERS, carrierName, forwardingGuide, prettyPhone, ringExplanation, type CarrierId,
} from './forwarding';
import type { StepProps } from './flow';

function CopyButton({ text, label }: { text: string; label: string }) {
  const t = useT();
  const { copied, copy } = useCopy();
  return (
    <>
      <Button variant="outline" className="min-h-11 shrink-0 px-3 text-xs" onClick={() => void copy(text)} aria-label={t('cn.copyLabel', { what: label })}>
        {copied ? t('cn.copied') : t('cn.copy')}
      </Button>
      <span role="status" className="sr-only">{copied ? t('cn.whatCopied', { what: label }) : ''}</span>
    </>
  );
}

export function ConnectStep({ status, go }: StepProps) {
  const t = useT();
  const [carrier, setCarrier] = useState<CarrierId>('att');
  const phone = status.phone ?? '';
  const guide = forwardingGuide(carrier, phone, t);

  return (
    <section aria-labelledby="connect-title">
      <h2 id="connect-title" className="text-[28px] font-semibold tracking-[-0.02em] text-white">{t('cn.title')}</h2>
      <p className="mt-2 text-sm text-mute">
        {t('cn.lead')}
      </p>

      <Card className="mt-6 p-5">
        <p className="text-xs uppercase tracking-wider text-dim">{t('cn.herNumber')}</p>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <a href={`tel:${phone}`} className="font-mono text-[26px] tracking-tight text-white hover:text-mint">{prettyPhone(phone)}</a>
          <CopyButton text={phone} label={t('cn.herPhone')} />
        </div>
        {status.phone_mock ? (
          <p role="note" className="mt-3 rounded-xl border border-warn-line bg-warn-bg px-3.5 py-2.5 text-[13px] text-warn">
            {t('cn.mockNote')}
          </p>
        ) : null}
      </Card>

      <Card className="mt-4 p-5">
        <fieldset>
          <legend className="text-[13px] font-medium text-white">{t('cn.whoProvides')}</legend>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {CARRIERS.map((c) => (
              <label key={c.id} className={cn(
                'flex min-h-11 cursor-pointer items-center gap-2.5 rounded-xl border px-3 text-[13px] focus-within:outline-2 focus-within:outline-brand-soft',
                carrier === c.id ? 'border-brand/60 bg-[#1a1208] text-white' : 'border-line-2 bg-sunken text-soft hover:border-line-3',
              )}>
                <input type="radio" name="carrier" value={c.id} checked={carrier === c.id} onChange={() => setCarrier(c.id)} className="h-4 w-4 accent-brand" />
                {carrierName(c.id, t)}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="mt-5" aria-live="polite">
          <h3 className="text-[15px] font-semibold text-white">{guide.name}</h3>
          <p className="mt-1 text-[13px] leading-relaxed text-mute">{guide.intro}</p>
          <ol className="mt-3 space-y-3">
            {guide.setup.map((s) => (
              <li key={s.label} className="rounded-xl bg-sunken p-3.5">
                <p className="text-[13px] text-soft">{s.label}</p>
                {s.dial ? (
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <code className="min-w-0 break-all font-mono text-[15px] text-white">{s.dial}</code>
                    <CopyButton text={s.dial} label={t('cn.dialCode')} />
                  </div>
                ) : null}
                {s.note ? <p className="mt-1.5 text-xs text-dim">{s.note}</p> : null}
              </li>
            ))}
          </ol>

          <h3 className="mt-5 text-[13px] font-medium text-white">{t('cn.turnOffLater')}</h3>
          <ul className="mt-2 space-y-2">
            {guide.cancel.map((s) => (
              <li key={s.label} className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-body">
                <span>{s.label}</span>
                {s.dial ? <code className="font-mono text-white">{s.dial}</code> : null}
              </li>
            ))}
          </ul>
          <ul className="mt-4 list-disc space-y-1.5 pl-5 text-xs leading-relaxed text-dim">
            {guide.notes.map((n) => <li key={n}>{n}</li>)}
          </ul>
        </div>
      </Card>

      <Card className="mt-4 p-5">
        <h3 className="text-[13px] font-medium text-white">{t('cn.callers')}</h3>
        <p className="mt-1.5 text-[13px] leading-relaxed text-body">{ringExplanation(t)}</p>
        <p className="mt-2 text-xs text-dim">{t('cn.carrierNote')}</p>
      </Card>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button onClick={() => go('test')} className="flex-1 sm:flex-none sm:px-8">{t('cn.makeTest')}</Button>
        <Button variant="ghost" onClick={() => go('test')}>{t('cn.later')}</Button>
      </div>
    </section>
  );
}
