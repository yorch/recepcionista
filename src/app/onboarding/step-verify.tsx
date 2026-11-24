'use client';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TextField } from '@/components/ui/field';
import { ApiError, useApi } from '@/hooks/use-api';
import { toE164 } from '@/lib/phone';
import { prettyPhone } from './forwarding';
import type { StepProps } from './flow';

const RESEND_SECONDS = 30;

function friendly(err: ApiError, what: 'send' | 'confirm'): string {
  if (err.status === 403 && /email_not_verified/i.test(err.message)) return 'Confirm your email address first (check your inbox for our message), then come back and text yourself a code.';
  if (err.status === 429) return 'Too many attempts. Wait a few minutes, then try again.';
  if (err.status === 404 || err.status === 501) return 'Phone verification is not available yet. Please contact support.';
  if (err.status === 503) return 'We could not send a text right now. Try again in a minute.';
  if (what === 'confirm' && (err.status === 400 || err.status === 401 || err.status === 422)) return err.message || 'That code is not right. Check the text and try again.';
  return err.message;
}

export function VerifyStep({ businessId, status, go, refresh }: StepProps) {
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
    if (!e164) { setPhoneError('Enter a mobile number with area code, like 305 555 0142.'); return; }
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
      toast.success(`Code sent to ${prettyPhone(e164)}`);
    } catch (err) {
      setPhoneError(friendly(err as ApiError, 'send'));
    }
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    setCodeError(null);
    const digits = code.replace(/\D/g, '');
    if (digits.length < 4) { setCodeError('Enter the code from the text message.'); return; }
    if (!challenge || !sentTo) { setCodeError('Request a new code first.'); return; }
    try {
      await request(`/api/businesses/${businessId}/owner-phone/verify/confirm`, { method: 'POST', body: { phone: sentTo, code: digits, challenge } });
      toast.success('Phone verified');
      setChanging(false);
      setSentTo(null);
      setChallenge(null);
      setCode('');
      await refresh();
    } catch (err) {
      setCodeError(friendly(err as ApiError, 'confirm'));
    }
  }

  return (
    <section aria-labelledby="verify-title">
      <h2 id="verify-title" className="text-[28px] font-semibold tracking-[-0.02em] text-white">Where should she reach you?</h2>
      <p className="mt-2 text-sm text-mute">
        She texts this number when there is an emergency or a caller needs you, and sends your evening briefing here. We confirm it is yours with a text code.
      </p>

      <Card className="mt-6 p-5">
        {verifiedSame ? (
          <div role="status" className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[15px] text-white">
              <span aria-hidden="true" className="mr-2 text-mint">✓</span>
              {prettyPhone(e164!)} is verified
            </p>
            <Button variant="outline" onClick={() => { setChanging(true); setSentTo(null); }}>Change number</Button>
          </div>
        ) : (
          <>
            <TextField
              label="Your name" value={name} autoComplete="name" placeholder="Jorge Rivera"
              onChange={(e) => setName(e.target.value)} hint="So she can say who she is handing the call to."
            />
            <TextField
              className="mt-4" label="Your mobile number" type="tel" inputMode="tel" autoComplete="tel" mono
              value={phone} placeholder="305 555 0142" error={phoneError}
              onChange={(e) => { setPhone(e.target.value); setPhoneError(null); if (sentTo && toE164(e.target.value) !== sentTo) setSentTo(null); }}
              hint="Message and data rates may apply. Reply STOP to any text to stop."
            />
            {!sentTo ? (
              <Button className="mt-4 w-full sm:w-auto" onClick={sendCode} disabled={busy}>{busy ? 'Sending…' : 'Text me a code'}</Button>
            ) : (
              <form onSubmit={confirm} className="mt-5 border-t border-line pt-5" noValidate>
                <TextField
                  label={`Code sent to ${prettyPhone(sentTo)}`} value={code} inputMode="numeric" autoComplete="one-time-code"
                  maxLength={10} mono autoFocus placeholder="123456" error={codeError}
                  onChange={(e) => { setCode(e.target.value); setCodeError(null); }}
                />
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <Button type="submit" disabled={busy}>{busy ? 'Checking…' : 'Verify'}</Button>
                  <Button variant="ghost" onClick={sendCode} disabled={busy || cooldown > 0}>
                    {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
                  </Button>
                </div>
              </form>
            )}
          </>
        )}
      </Card>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button onClick={() => go('plan')} disabled={!status.owner_phone_verified || !verifiedSame} className="flex-1 sm:flex-none sm:px-8">Continue →</Button>
        <Button variant="ghost" onClick={() => go('review')}>Back</Button>
      </div>
    </section>
  );
}
