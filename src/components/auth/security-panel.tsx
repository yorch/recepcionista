'use client';
import { utcStamp } from '@/components/dashboard/dates';
import { useState } from 'react';
import { useLocale, useT } from '@/lib/i18n/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHead } from '@/components/ui/card';
import { go, inputCls, friendly, sendJson } from './auth-ui';
import { PasskeysCard, type PasskeyView } from './passkeys-card';

export interface SessionView {
  id: string; created_at: string; last_used_at: string; expires_at: string; ip: string | null; user_agent: string | null; current: boolean;
}

function LabeledInput({ label, hint, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className="mt-3 block text-[13px] text-[#a8b6c8]">
      {label}
      <input {...props} className={inputCls} />
      {hint ? <span className="mt-1 block text-[12px] text-[#6b7b91]">{hint}</span> : null}
    </label>
  );
}

function Msg({ error, notice }: { error?: string | null; notice?: string | null }) {
  if (error) return <p role="alert" className="mt-3 rounded-lg bg-[#3a1512] px-3 py-2 text-[13px] text-[#ff9b86]">{error}</p>;
  if (notice) return <p role="status" className="mt-3 rounded-lg bg-[#10261c] px-3 py-2 text-[13px] text-[#8fe3b4]">{notice}</p>;
  return null;
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const t = useT();
  const text = codes.join('\n');
  return (
    <div className="mt-3 rounded-lg border border-[#5a4a1c] bg-[#1d1808] p-4">
      <p className="text-[13px] font-medium text-[#ffd98a]">{t('sec.codes.saveNow')}</p>
      <p className="mt-1 text-[12px] text-[#c9b676]">{t('sec.codes.hint')}</p>
      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[14px] text-white" aria-label={t('sec.codes.label')}>
        {codes.map((c) => <li key={c}>{c}</li>)}
      </ul>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={() => void navigator.clipboard?.writeText(text)}>{t('sec.codes.copy')}</Button>
        <Button
          type="button" variant="outline"
          onClick={() => {
            const url = URL.createObjectURL(new Blob([text + '\n'], { type: 'text/plain' }));
            const a = document.createElement('a');
            a.href = url; a.download = 'recepcionista-recovery-codes.txt'; a.click();
            URL.revokeObjectURL(url);
          }}
        >{t('sec.codes.download')}</Button>
        <Button type="button" onClick={onDone}>{t('sec.codes.saved')}</Button>
      </div>
    </div>
  );
}

function TwoFactor({ enabled, recoveryLeft, required, canDisable }: { enabled: boolean; recoveryLeft: number; required: boolean; canDisable: boolean }) {
  const t = useT();
  const [step, setStep] = useState<'idle' | 'password' | 'scan' | 'codes' | 'disable' | 'regen'>('idle');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [qr, setQr] = useState<{ svg: string; secret: string } | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => { setPassword(''); setCode(''); setError(null); setBusy(false); setRecovery(false); };

  async function enroll(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    const r = await sendJson<{ qr_svg: string; secret: string }>('/api/auth/2fa/enroll', { password });
    setBusy(false);
    if (!r.ok || !r.data) { setError(friendly(t, r.error)); return; }
    setQr({ svg: r.data.qr_svg, secret: r.data.secret });
    setPassword(''); setStep('scan');
  }
  async function confirm(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    const r = await sendJson<{ recovery_codes: string[] }>('/api/auth/2fa/confirm', { code });
    setBusy(false);
    if (!r.ok || !r.data) { setError(r.error === 'invalid code' ? t('sec.2fa.codeMismatch') : friendly(t, r.error)); return; }
    setCodes(r.data.recovery_codes); setQr(null); setCode(''); setStep('codes');
  }
  async function disable(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    const r = await sendJson('/api/auth/2fa/disable', recovery ? { password, recovery_code: code } : { password, code });
    setBusy(false);
    if (!r.ok) { setError(r.error === 'invalid code' ? t('sec.2fa.codeFailed') : friendly(t, r.error)); return; }
    window.location.reload();
  }
  async function regen(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    const r = await sendJson<{ recovery_codes: string[] }>('/api/auth/2fa/recovery-codes', { code });
    setBusy(false);
    if (!r.ok || !r.data) { setError(r.error === 'invalid code' ? t('sec.2fa.codeFailed') : friendly(t, r.error)); return; }
    setCodes(r.data.recovery_codes); setCode(''); setStep('codes');
  }

  return (
    <Card className="mt-6">
      <CardHead
        title={t('auth.mfa.title')}
        subtitle={t('sec.2fa.subtitle')}
        right={<Badge tone={enabled ? 'routine' : required ? 'emergency' : 'neutral'}>{enabled ? t('common.on') : required ? t('sec.2fa.required') : t('common.off')}</Badge>}
      />
      <div className="p-5">
        {required && !enabled ? (
          <p role="alert" className="mb-3 rounded-lg bg-[#3a1512] px-3 py-2 text-[13px] text-[#ff9b86]">{t('sec.2fa.adminsMust')}</p>
        ) : null}

        {step === 'codes' ? (
          <RecoveryCodes codes={codes} onDone={() => window.location.reload()} />
        ) : step === 'scan' && qr ? (
          <form onSubmit={confirm}>
            <p className="text-[13px] text-[#a8b6c8]">{t('sec.2fa.scan')}</p>
            <div className="mt-3 inline-block rounded-lg bg-white p-2 [&_svg]:h-44 [&_svg]:w-44" role="img" aria-label={t('sec.2fa.qrLabel')} dangerouslySetInnerHTML={{ __html: qr.svg }} />
            <p className="mt-2 text-[12px] text-[#8b98ab]">{t('sec.2fa.manualKey')} <code className="break-all font-mono text-white">{qr.secret}</code></p>
            <LabeledInput label={t('sec.2fa.codeFromApp')} inputMode="numeric" autoComplete="one-time-code" maxLength={8} required value={code} onChange={(e) => setCode(e.target.value)} />
            <Msg error={error} />
            <div className="mt-4 flex gap-2">
              <Button type="submit" disabled={busy || !code}>{busy ? t('common.checking') : t('sec.2fa.turnOn')}</Button>
              <Button type="button" variant="ghost" onClick={() => { setStep('idle'); setQr(null); reset(); }}>{t('common.cancel')}</Button>
            </div>
          </form>
        ) : step === 'password' ? (
          <form onSubmit={enroll}>
            <LabeledInput label={t('sec.confirmPassword')} type="password" autoComplete="current-password" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
            <Msg error={error} />
            <div className="mt-4 flex gap-2">
              <Button type="submit" disabled={busy || !password}>{busy ? t('sec.starting') : t('common.continue')}</Button>
              <Button type="button" variant="ghost" onClick={() => { setStep('idle'); reset(); }}>{t('common.cancel')}</Button>
            </div>
          </form>
        ) : step === 'disable' ? (
          <form onSubmit={disable}>
            <LabeledInput label={t('auth.login.password')} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            <LabeledInput label={recovery ? t('auth.mfa.labelRecovery') : t('sec.2fa.codeFromApp')} autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} />
            <button type="button" className="mt-2 text-[12px] text-[#8b98ab] underline" onClick={() => { setRecovery((v) => !v); setCode(''); }}>
              {recovery ? t('sec.2fa.useAppCode') : t('auth.mfa.useRecovery')}
            </button>
            <Msg error={error} />
            <div className="mt-4 flex gap-2">
              <Button type="submit" variant="danger" disabled={busy || !password || !code}>{busy ? t('sec.2fa.turningOff') : t('sec.2fa.turnOff')}</Button>
              <Button type="button" variant="ghost" onClick={() => { setStep('idle'); reset(); }}>{t('common.cancel')}</Button>
            </div>
          </form>
        ) : step === 'regen' ? (
          <form onSubmit={regen}>
            <p className="text-[13px] text-[#a8b6c8]">{t('sec.2fa.regenWarning')}</p>
            <LabeledInput label={t('sec.2fa.codeFromApp')} inputMode="numeric" autoComplete="one-time-code" maxLength={8} required value={code} onChange={(e) => setCode(e.target.value)} />
            <Msg error={error} />
            <div className="mt-4 flex gap-2">
              <Button type="submit" disabled={busy || !code}>{busy ? t('sec.2fa.generating') : t('sec.2fa.generate')}</Button>
              <Button type="button" variant="ghost" onClick={() => { setStep('idle'); reset(); }}>{t('common.cancel')}</Button>
            </div>
          </form>
        ) : enabled ? (
          <div>
            <p className="text-[13px] text-[#a8b6c8]">{t('sec.2fa.recoveryLeft', { count: recoveryLeft })}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => setStep('regen')}>{t('sec.2fa.newCodes')}</Button>
              {canDisable ? <Button type="button" variant="danger" onClick={() => setStep('disable')}>{t('sec.2fa.turnOff')}</Button> : null}
            </div>
          </div>
        ) : (
          <Button type="button" onClick={() => setStep('password')}>{t('sec.2fa.setUp')}</Button>
        )}
      </div>
    </Card>
  );
}

function EmailStatus({ email, verified }: { email: string; verified: boolean }) {
  const t = useT();
  const [msg, setMsg] = useState<{ error?: string; notice?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function resend() {
    setBusy(true); setMsg(null);
    const r = await sendJson('/api/auth/resend-verification', {});
    setBusy(false);
    setMsg(r.ok ? { notice: t('sec.email.sent') } : { error: friendly(t, r.error) });
  }
  return (
    <Card className="mt-6">
      <CardHead title={t('sec.email.title')} subtitle={email} right={<Badge tone={verified ? 'routine' : 'unsure'}>{verified ? t('sec.email.confirmed') : t('sec.email.notConfirmed')}</Badge>} />
      {!verified ? (
        <div className="p-5">
          <p className="text-[13px] text-[#a8b6c8]">{t('sec.email.confirmHint')}</p>
          <Button type="button" className="mt-3" variant="outline" disabled={busy} onClick={resend}>{busy ? t('common.sending') : t('sec.email.resend')}</Button>
          <Msg error={msg?.error} notice={msg?.notice} />
        </div>
      ) : null}
    </Card>
  );
}

function Sessions({ initial, canRevoke }: { initial: SessionView[]; canRevoke: boolean }) {
  const t = useT();
  const locale = useLocale();
  const when = (iso: string) => utcStamp(iso, locale);
  const [list, setList] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  async function revoke(s: SessionView) {
    setError(null);
    const r = await sendJson(`/api/auth/sessions/${encodeURIComponent(s.id)}`, undefined, 'DELETE');
    if (!r.ok) { setError(friendly(t, r.error)); return; }
    if (s.current) { go('/login'); return; }
    setList((l) => l.filter((x) => x.id !== s.id));
  }
  async function others() {
    setError(null);
    const r = await sendJson('/api/auth/sessions/revoke-others', {});
    if (!r.ok) { setError(friendly(t, r.error)); return; }
    setList((l) => l.filter((x) => x.current));
  }
  return (
    <Card className="mt-6">
      <CardHead
        title={t('sec.sessions.title')}
        subtitle={t('sec.sessions.subtitle')}
        right={canRevoke && list.length > 1 ? <Button type="button" variant="outline" onClick={others}>{t('sec.sessions.signOutOthers')}</Button> : undefined}
      />
      <ul className="divide-y divide-[#1f2937]">
        {list.length === 0 ? <li className="p-5 text-[13px] text-[#8b98ab]">{t('sec.sessions.none')}</li> : null}
        {list.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
            <div className="min-w-0 text-[13px]">
              <p className="truncate text-white">{s.user_agent ?? t('sec.sessions.unknownDevice')} {s.current ? <Badge tone="brand" className="ml-1">{t('sec.sessions.thisDevice')}</Badge> : null}</p>
              <p className="text-[12px] text-[#8b98ab]">{t('sec.sessions.line', { last: when(s.last_used_at), created: when(s.created_at) })}{s.ip ? ` · ${s.ip}` : ''}</p>
            </div>
            {canRevoke ? <Button type="button" variant="ghost" onClick={() => revoke(s)}>{s.current ? t('sec.sessions.signOut') : t('sec.sessions.revoke')}</Button> : null}
          </li>
        ))}
      </ul>
      {error ? <div className="px-5 pb-4"><Msg error={error} /></div> : null}
    </Card>
  );
}

function AdminSessions({ count }: { count: number }) {
  const t = useT();
  const [msg, setMsg] = useState<{ error?: string; notice?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function revokeAll() {
    if (!window.confirm(t('sec.admin.confirm'))) return;
    setBusy(true); setMsg(null);
    const r = await sendJson<{ revoked: number }>('/api/auth/revoke-admin-sessions', {});
    setBusy(false);
    if (!r.ok) { setMsg({ error: friendly(t, r.error) }); return; }
    setMsg({ notice: t('sec.admin.revoked', { count: r.data?.revoked ?? 0 }) });
    window.setTimeout(() => window.location.reload(), 800);
  }
  return (
    <Card className="mt-6">
      <CardHead title={t('sec.admin.title')} subtitle={t('sec.admin.subtitle', { count })} />
      <div className="p-5">
        <Button type="button" variant="danger" disabled={busy} onClick={revokeAll}>{busy ? t('sec.admin.revoking') : t('sec.admin.revokeAll')}</Button>
        <Msg error={msg?.error} notice={msg?.notice} />
      </div>
    </Card>
  );
}

export function SecurityPanel(props: {
  email: string | null; emailVerified: boolean; totpEnabled: boolean; recoveryLeft: number; sessions: SessionView[];
  isAdmin: boolean; adminSessionCount: number; twoFactorRequired: boolean; passkeys?: PasskeyView[];
}) {
  const t = useT();
  return (
    <>
      {props.email ? <EmailStatus email={props.email} verified={props.emailVerified} /> : null}
      {props.email ? (
        <TwoFactor enabled={props.totpEnabled} recoveryLeft={props.recoveryLeft} required={props.twoFactorRequired} canDisable={!props.twoFactorRequired} />
      ) : (
        <Card className="mt-6"><div className="p-5 text-[13px] text-[#a8b6c8]">{t('sec.breakGlass')}</div></Card>
      )}
      {props.email ? <PasskeysCard initial={props.passkeys ?? []} /> : null}
      {props.email ? <Sessions initial={props.sessions} canRevoke /> : null}
      {props.isAdmin ? <AdminSessions count={props.adminSessionCount} /> : null}
    </>
  );
}
