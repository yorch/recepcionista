'use client';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TextField } from '@/components/ui/field';
import { ApiError, useApi } from '@/hooks/use-api';
import { errorText } from '@/lib/i18n/api-errors';
import { useT } from '@/lib/i18n/client';
import type { TFunction } from '@/lib/i18n/core';
import { toE164 } from '@/lib/phone';
import { prettyPhone } from './forwarding';
import type { StepProps } from './flow';

const RESEND_SECONDS = 30;

function friendly(t: TFunction, err: ApiError, what: 'send' | 'confirm'): string {
  if (err.status === 403 && /email_not_verified/i.test(err.message)) return t('vf.emailFirst');
  if (err.status === 429) return t('vf.tooMany');
  if (err.status === 404 || err.status === 501) return t('vf.unavailable');
  if (err.status === 503 && /sms_provider_not_configured/.test(err.message)) return errorText(t, err);
  if (err.status === 503) return t('vf.cantSend');
  if (what === 'confirm' && (err.status === 400 || err.status === 401 || err.status === 422)) return err.message ? errorText(t, err) : t('vf.badCode');
  return errorText(t, err);
}

export function VerifyStep({ businessId, status, go, refresh }: StepProps) {
  const t = useT();
  const { busy, request } = useApi();
  const initial = status.owner_phone ?? '';
  const [name, setName] = useState(status.owner_name ?? '');
  const [phone, setPhone] = useState(initial);
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  /** Signed challenge from /verify/start: echoed back with the phone and code to /verify/confirm. */
  const [challenge, setChallenge] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);

  const e164 = toE164(phone);
  const verifiedSame = status.owner_phone_verified && e164 !== null && e164 === toE164(status.owner_phone) && !changing;

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function sendCode() {
    setCodeError(null);
    if (!e164) { setPhoneError(t('vf.enterPhone')); return; }
    setPhoneError(null);
    try {
      if (e164 !== toE164(status.owner_phone) || name.trim() !== (status.owner_name ?? '')) {
        await request(`/api/businesses/${businessId}`, {
          method: 'PATCH', body: { owner_phone: e164, ...(name.trim() ? { owner_name: name.trim() } : {}) },
        });
      }
      const started = await request<{ challenge: string }>(`/api/businesses/${businessId}/owner-phone/verify/start`, { method: 'POST', body: { phone: e164 } });
      setChallenge(started.challenge);
      setSentTo(e164);
      setCooldown(RESEND_SECONDS);
      toast.success(t('vf.codeSent', { phone: prettyPhone(e164) }));
    } catch (err) {
      setPhoneError(friendly(t, err as ApiError, 'send'));
    }
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    setCodeError(null);
    const digits = code.replace(/\D/g, '');
    if (digits.length < 4) { setCodeError(t('vf.enterCode')); return; }
    if (!challenge || !sentTo) { setCodeError(t('vf.newCode')); return; }
    try {
      await request(`/api/businesses/${businessId}/owner-phone/verify/confirm`, { method: 'POST', body: { phone: sentTo, code: digits, challenge } });
      toast.success(t('vf.verifiedToast'));
      setChanging(false);
      setSentTo(null);
      setChallenge(null);
      setCode('');
      await refresh();
    } catch (err) {
      setCodeError(friendly(t, err as ApiError, 'confirm'));
    }
  }

  return (
    <section aria-labelledby="verify-title">
      <h2 id="verify-title" className="text-[28px] font-semibold tracking-[-0.02em] text-white">{t('vf.title')}</h2>
      <p className="mt-2 text-sm text-mute">
        {t('vf.lead')}
      </p>

      <Card className="mt-6 p-5">
        {verifiedSame ? (
          <div role="status" className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[15px] text-white">
              <span aria-hidden="true" className="mr-2 text-mint">✓</span>
              {t('vf.isVerified', { phone: prettyPhone(e164!) })}
            </p>
            <Button variant="outline" onClick={() => { setChanging(true); setSentTo(null); }}>{t('vf.change')}</Button>
          </div>
        ) : (
          <>
            <TextField
              label={t('vf.name')} value={name} autoComplete="name" placeholder={t('vf.namePlaceholder')}
              onChange={(e) => setName(e.target.value)} hint={t('vf.nameHint')}
            />
            <TextField
              className="mt-4" label={t('vf.mobile')} type="tel" inputMode="tel" autoComplete="tel" mono
              value={phone} placeholder="305 555 0142" error={phoneError}
              onChange={(e) => { setPhone(e.target.value); setPhoneError(null); if (sentTo && toE164(e.target.value) !== sentTo) setSentTo(null); }}
              hint={t('vf.mobileHint')}
            />
            {!sentTo ? (
              <Button className="mt-4 w-full sm:w-auto" onClick={sendCode} disabled={busy}>{busy ? t('common.sending') : t('vf.sendCode')}</Button>
            ) : (
              <form onSubmit={confirm} className="mt-5 border-t border-line pt-5" noValidate>
                <TextField
                  label={t('vf.codeLabel', { phone: prettyPhone(sentTo) })} value={code} inputMode="numeric" autoComplete="one-time-code"
                  maxLength={10} mono autoFocus placeholder="123456" error={codeError}
                  onChange={(e) => { setCode(e.target.value); setCodeError(null); }}
                />
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <Button type="submit" disabled={busy}>{busy ? t('common.checking') : t('vf.verify')}</Button>
                  <Button variant="ghost" onClick={sendCode} disabled={busy || cooldown > 0}>
                    {cooldown > 0 ? t('vf.resendIn', { n: cooldown }) : t('vf.resend')}
                  </Button>
                </div>
              </form>
            )}
          </>
        )}
      </Card>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button onClick={() => go('plan')} disabled={!status.owner_phone_verified || !verifiedSame} className="flex-1 sm:flex-none sm:px-8">{t('plan.continue')}</Button>
        <Button variant="ghost" onClick={() => go('review')}>{t('common.back')}</Button>
      </div>
    </section>
  );
}
