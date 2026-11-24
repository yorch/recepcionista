'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { TextField } from '@/components/ui/field';
import { ApiError, apiRequest } from '@/hooks/use-api';
import type { CallModeView } from '@/lib/voice/call-mode';
import type { CallMode } from '@/lib/types';

const TONE: Record<CallModeView['tone'], string> = {
  ok: 'border-mint-line bg-mint-bg text-mint-text',
  warn: 'border-warn-line bg-warn-bg text-warn',
  info: 'border-sky-line bg-sky-bg text-sky-text',
};

const ICON: Record<CallMode, string> = {
  ai: 'M12 3v3m0 12v3M5 12H2m20 0h-3M7 7 5 5m14 14-2-2M7 17l-2 2M19 5l-2 2M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
  paused: 'M8 5v14m8-14v14',
  forward: 'M5 12h12m-4-5 5 5-5 5',
};

const friendly = (err: unknown): string => (err instanceof ApiError ? err.message : 'Something went wrong. Try again.');

/**
 * The call-handling switch: a status pill (always visible, for everyone) and, for the owner, three choices: the AI answers,
 * calls are paused (callers leave a message) or calls forward to a verified number. The pill never claims more than the
 * server resolved (`label` is computed from the same routing function the phone lines use).
 */
export function CallModeSwitch({
  businessId, initial, canManage, compact = false,
}: { businessId: string; initial: CallModeView; canManage: boolean; compact?: boolean }) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState<CallMode | null>(null);
  const [open, setOpen] = useState(false);

  async function choose(mode: CallMode) {
    if (mode === view.call_mode) return;
    setBusy(mode);
    try {
      const next = await apiRequest<CallModeView>(`/api/businesses/${businessId}/call-mode`, { method: 'PATCH', body: { mode } });
      setView(next);
      toast.success(mode === 'ai' ? 'The assistant is answering calls again' : mode === 'paused' ? 'Calls are paused: callers are asked to leave a message' : 'Calls now forward to your number');
      router.refresh();
    } catch (err) {
      toast.error(friendly(err));
    } finally {
      setBusy(null);
    }
  }

  const pill = (
    <p
      role="status"
      aria-live="polite"
      className={cn('inline-flex min-h-11 items-center gap-2 rounded-full border px-4 py-1.5 text-[13px] font-medium', TONE[view.tone])}
    >
      <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={ICON[view.route_now === 'ai' ? 'ai' : view.route_now]} /></svg>
      {view.label}
    </p>
  );

  if (!canManage) return pill;

  return (
    <div className="flex flex-col items-start gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {pill}
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`call-mode-${businessId}`}
          onClick={() => setOpen((o) => !o)}
          className="min-h-11 rounded-xl px-3 text-[13px] font-medium text-brand-soft hover:underline"
        >
          {open ? 'Done' : 'Change'}
        </button>
      </div>
      {open || !compact ? (
        <div id={`call-mode-${businessId}`} className="flex flex-col gap-2">
          <div role="group" aria-label="Call handling" className="inline-flex overflow-hidden rounded-xl border border-line-3">
            {([
              ['ai', 'AI answers'],
              ['paused', 'Pause'],
              ['forward', 'Forward'],
            ] as const).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                aria-pressed={view.call_mode === mode}
                disabled={busy !== null || (mode === 'forward' && !view.forward_verified)}
                onClick={() => choose(mode)}
                className={cn('flex min-h-11 items-center gap-1.5 px-3.5 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50', view.call_mode === mode ? 'bg-raised text-white' : 'text-mute hover:bg-hover hover:text-soft')}
              >
                <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={ICON[mode]} /></svg>
                {busy === mode ? 'Saving…' : label}
              </button>
            ))}
          </div>
          {!view.forward_verified ? (
            <p className="max-w-md text-xs text-dim">To forward calls, add and verify a number in <Link href="/dashboard/settings#call-handling" className="text-brand-soft hover:underline">Settings</Link>.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Settings section: mode, the forwarding number (verified by a text code) and the business-hours schedule. */
export function CallHandlingSettings({
  businessId, initial, ownerPhoneVerified, ownerPhone,
}: { businessId: string; initial: CallModeView; ownerPhoneVerified: boolean; ownerPhone: string | null }) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [phone, setPhone] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async <T,>(key: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(key);
    setError(null);
    try { return await fn(); } catch (err) { setError(friendly(err)); return undefined; } finally { setBusy(null); }
  };

  const sendCode = () => run('send', async () => {
    const r = await apiRequest<{ challenge: string }>(`/api/businesses/${businessId}/forward-number/verify/start`, { method: 'POST', body: { phone } });
    setChallenge(r.challenge);
    setSentTo(phone);
    toast.success('Code sent');
    router.refresh();
  });

  const confirm = (e: React.FormEvent) => {
    e.preventDefault();
    return run('confirm', async () => {
      if (!challenge || !sentTo) throw new ApiError('Request a new code first.', 422);
      const r = await apiRequest<{ state: CallModeView }>(`/api/businesses/${businessId}/forward-number/verify/confirm`, {
        method: 'POST', body: { phone: sentTo, code: code.replace(/\D/g, ''), challenge },
      });
      setView(r.state);
      setChallenge(null); setSentTo(null); setCode(''); setPhone('');
      toast.success('Number verified');
      router.refresh();
    });
  };

  const useOwner = () => run('owner', async () => {
    setView(await apiRequest<CallModeView>(`/api/businesses/${businessId}/forward-number`, { method: 'PUT', body: { use_owner_phone: true } }));
    toast.success('Forwarding number set to your verified phone');
    router.refresh();
  });

  const remove = () => run('remove', async () => {
    setView(await apiRequest<CallModeView>(`/api/businesses/${businessId}/forward-number`, { method: 'DELETE' }));
    router.refresh();
  });

  const setHours = (v: boolean) => run('hours', async () => {
    setView(await apiRequest<CallModeView>(`/api/businesses/${businessId}/call-mode`, { method: 'PATCH', body: { mode: view.call_mode, forward_during_hours: v } }));
    router.refresh();
  });

  return (
    <div id="call-handling" className="flex flex-col gap-5">
      <CallModeSwitch businessId={businessId} initial={view} canManage />

      <div className="rounded-xl border border-line-2 bg-sunken p-4 text-[13px] leading-relaxed text-body">
        <p><strong className="text-soft">AI answers</strong>: the receptionist takes the call (default).</p>
        <p className="mt-1"><strong className="text-soft">Pause</strong>: the receptionist does not answer. On a Twilio line the caller hears a short message and can leave a recorded voicemail (they are told it is recorded). On the native ElevenLabs line the agent says the same and takes a message.</p>
        <p className="mt-1"><strong className="text-soft">Forward</strong>: calls ring your verified number and are not recorded. If nobody answers, the caller can leave a voicemail. On the native ElevenLabs line the platform answers first, so forwarding is not possible there and callers are asked to leave a message instead (see docs/known-limitations.md).</p>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-white">Forwarding number</h3>
        {view.forward_number_masked ? (
          <p className="mt-1.5 text-[13px] text-soft">
            <span className="font-mono">{view.forward_number ?? view.forward_number_masked}</span>{' '}
            {view.forward_verified
              ? <span className="text-mint-text">(verified{view.forward_is_owner_phone ? ': your alert phone' : ''})</span>
              : <span className="text-warn">(not verified: calls are not forwarded to it)</span>}
          </p>
        ) : <p className="mt-1.5 text-[13px] text-dim">No forwarding number yet.</p>}

        <div className="mt-3 flex flex-wrap items-end gap-3">
          <TextField
            label="Number to forward to" className="min-w-[220px] flex-1" type="tel" inputMode="tel" autoComplete="tel"
            value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="305 555 0142"
            hint="We text it a 6-digit code to prove it is a phone you control. Premium-rate, short-code and unsupported-country numbers are refused."
          />
          <Button variant="outline" onClick={sendCode} disabled={busy !== null || !phone.trim()}>{busy === 'send' ? 'Sending…' : 'Text me a code'}</Button>
        </div>

        {challenge ? (
          <form onSubmit={confirm} className="mt-3 flex flex-wrap items-end gap-3">
            <TextField label="6-digit code" className="w-40" inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code} onChange={(e) => setCode(e.target.value)} mono />
            <Button type="submit" disabled={busy !== null || code.replace(/\D/g, '').length < 4}>{busy === 'confirm' ? 'Checking…' : 'Verify number'}</Button>
          </form>
        ) : null}

        <div className="mt-3 flex flex-wrap gap-2">
          {ownerPhoneVerified && ownerPhone ? (
            <Button variant="outline" onClick={useOwner} disabled={busy !== null}>{busy === 'owner' ? 'Saving…' : `Use my verified alert phone (${ownerPhone})`}</Button>
          ) : null}
          {view.forward_number_masked ? <Button variant="ghost" onClick={remove} disabled={busy !== null}>Remove number</Button> : null}
        </div>
        {error ? <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p> : null}
      </div>

      <label className="flex min-h-11 items-start gap-3 text-[13px] text-soft">
        <input
          type="checkbox" className="mt-1 h-4 w-4 accent-[#ff6b35]"
          checked={view.forward_during_hours} disabled={busy !== null}
          onChange={(e) => void setHours(e.target.checked)}
        />
        <span>
          Forward only during business hours
          <span className="block text-xs text-dim">Inside your opening hours calls ring your number; after hours the AI answers. Works with the Forward mode.</span>
        </span>
      </label>
    </div>
  );
}
