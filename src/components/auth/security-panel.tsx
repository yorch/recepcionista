'use client';
import { utcStamp } from '@/components/dashboard/dates';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHead } from '@/components/ui/card';
import { go, inputCls, friendly, sendJson } from './auth-ui';
import { PasskeysCard, type PasskeyView } from './passkeys-card';

export interface SessionView {
  id: string; created_at: string; last_used_at: string; expires_at: string; ip: string | null; user_agent: string | null; current: boolean;
}

const when = (iso: string) => utcStamp(iso);

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
  const text = codes.join('\n');
  return (
    <div className="mt-3 rounded-lg border border-[#5a4a1c] bg-[#1d1808] p-4">
      <p className="text-[13px] font-medium text-[#ffd98a]">Save these recovery codes now. They are shown only once.</p>
      <p className="mt-1 text-[12px] text-[#c9b676]">Each code works one time if you lose your authenticator. Keep them somewhere safe, apart from your password.</p>
      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[14px] text-white" aria-label="Recovery codes">
        {codes.map((c) => <li key={c}>{c}</li>)}
      </ul>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={() => void navigator.clipboard?.writeText(text)}>Copy</Button>
        <Button
          type="button" variant="outline"
          onClick={() => {
            const url = URL.createObjectURL(new Blob([text + '\n'], { type: 'text/plain' }));
            const a = document.createElement('a');
            a.href = url; a.download = 'recepcionista-recovery-codes.txt'; a.click();
            URL.revokeObjectURL(url);
          }}
        >Download</Button>
        <Button type="button" onClick={onDone}>I have saved them</Button>
      </div>
    </div>
  );
}

function TwoFactor({ enabled, recoveryLeft, required, canDisable }: { enabled: boolean; recoveryLeft: number; required: boolean; canDisable: boolean }) {
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
    if (!r.ok || !r.data) { setError(friendly(r.error)); return; }
    setQr({ svg: r.data.qr_svg, secret: r.data.secret });
    setPassword(''); setStep('scan');
  }
  async function confirm(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    const r = await sendJson<{ recovery_codes: string[] }>('/api/auth/2fa/confirm', { code });
    setBusy(false);
    if (!r.ok || !r.data) { setError(friendly(r.error === 'invalid code' ? 'That code did not match. Wait for the next one and try again.' : r.error)); return; }
    setCodes(r.data.recovery_codes); setQr(null); setCode(''); setStep('codes');
  }
  async function disable(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    const r = await sendJson('/api/auth/2fa/disable', recovery ? { password, recovery_code: code } : { password, code });
    setBusy(false);
    if (!r.ok) { setError(friendly(r.error === 'invalid code' ? 'That code did not work.' : r.error)); return; }
    window.location.reload();
  }
  async function regen(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    const r = await sendJson<{ recovery_codes: string[] }>('/api/auth/2fa/recovery-codes', { code });
    setBusy(false);
    if (!r.ok || !r.data) { setError(friendly(r.error === 'invalid code' ? 'That code did not work.' : r.error)); return; }
    setCodes(r.data.recovery_codes); setCode(''); setStep('codes');
  }

  return (
    <Card className="mt-6">
      <CardHead
        title="Two-step verification"
        subtitle="Require a code from an authenticator app (or a recovery code) after your password."
        right={<Badge tone={enabled ? 'routine' : required ? 'emergency' : 'neutral'}>{enabled ? 'On' : required ? 'Required' : 'Off'}</Badge>}
      />
      <div className="p-5">
        {required && !enabled ? (
          <p role="alert" className="mb-3 rounded-lg bg-[#3a1512] px-3 py-2 text-[13px] text-[#ff9b86]">Administrators must turn on two-step verification before using the dashboard.</p>
        ) : null}

        {step === 'codes' ? (
          <RecoveryCodes codes={codes} onDone={() => window.location.reload()} />
        ) : step === 'scan' && qr ? (
          <form onSubmit={confirm}>
            <p className="text-[13px] text-[#a8b6c8]">Scan this QR code with an authenticator app (1Password, Authy, Google Authenticator...), then enter the 6-digit code it shows.</p>
            <div className="mt-3 inline-block rounded-lg bg-white p-2 [&_svg]:h-44 [&_svg]:w-44" role="img" aria-label="QR code for your authenticator app" dangerouslySetInnerHTML={{ __html: qr.svg }} />
            <p className="mt-2 text-[12px] text-[#8b98ab]">Cannot scan? Enter this key manually: <code className="break-all font-mono text-white">{qr.secret}</code></p>
            <LabeledInput label="Code from the app" inputMode="numeric" autoComplete="one-time-code" maxLength={8} required value={code} onChange={(e) => setCode(e.target.value)} />
            <Msg error={error} />
            <div className="mt-4 flex gap-2">
              <Button type="submit" disabled={busy || !code}>{busy ? 'Checking...' : 'Turn on'}</Button>
              <Button type="button" variant="ghost" onClick={() => { setStep('idle'); setQr(null); reset(); }}>Cancel</Button>
            </div>
          </form>
        ) : step === 'password' ? (
          <form onSubmit={enroll}>
            <LabeledInput label="Confirm your password" type="password" autoComplete="current-password" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
            <Msg error={error} />
            <div className="mt-4 flex gap-2">
              <Button type="submit" disabled={busy || !password}>{busy ? 'Starting...' : 'Continue'}</Button>
              <Button type="button" variant="ghost" onClick={() => { setStep('idle'); reset(); }}>Cancel</Button>
            </div>
          </form>
        ) : step === 'disable' ? (
          <form onSubmit={disable}>
            <LabeledInput label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            <LabeledInput label={recovery ? 'Recovery code' : 'Code from the app'} autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} />
            <button type="button" className="mt-2 text-[12px] text-[#8b98ab] underline" onClick={() => { setRecovery((v) => !v); setCode(''); }}>
              {recovery ? 'Use the app code' : 'Use a recovery code'}
            </button>
            <Msg error={error} />
            <div className="mt-4 flex gap-2">
              <Button type="submit" variant="danger" disabled={busy || !password || !code}>{busy ? 'Turning off...' : 'Turn off'}</Button>
              <Button type="button" variant="ghost" onClick={() => { setStep('idle'); reset(); }}>Cancel</Button>
            </div>
          </form>
        ) : step === 'regen' ? (
          <form onSubmit={regen}>
            <p className="text-[13px] text-[#a8b6c8]">Your current recovery codes stop working as soon as you generate new ones.</p>
            <LabeledInput label="Code from the app" inputMode="numeric" autoComplete="one-time-code" maxLength={8} required value={code} onChange={(e) => setCode(e.target.value)} />
            <Msg error={error} />
            <div className="mt-4 flex gap-2">
              <Button type="submit" disabled={busy || !code}>{busy ? 'Generating...' : 'Generate new codes'}</Button>
              <Button type="button" variant="ghost" onClick={() => { setStep('idle'); reset(); }}>Cancel</Button>
            </div>
          </form>
        ) : enabled ? (
          <div>
            <p className="text-[13px] text-[#a8b6c8]">{recoveryLeft} unused recovery code{recoveryLeft === 1 ? '' : 's'} left.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => setStep('regen')}>New recovery codes</Button>
              {canDisable ? <Button type="button" variant="danger" onClick={() => setStep('disable')}>Turn off</Button> : null}
            </div>
          </div>
        ) : (
          <Button type="button" onClick={() => setStep('password')}>Set up two-step verification</Button>
        )}
      </div>
    </Card>
  );
}

function EmailStatus({ email, verified }: { email: string; verified: boolean }) {
  const [msg, setMsg] = useState<{ error?: string; notice?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function resend() {
    setBusy(true); setMsg(null);
    const r = await sendJson('/api/auth/resend-verification', {});
    setBusy(false);
    setMsg(r.ok ? { notice: 'A new confirmation link was sent.' } : { error: friendly(r.error) });
  }
  return (
    <Card className="mt-6">
      <CardHead title="Email address" subtitle={email} right={<Badge tone={verified ? 'routine' : 'unsure'}>{verified ? 'Confirmed' : 'Not confirmed'}</Badge>} />
      {!verified ? (
        <div className="p-5">
          <p className="text-[13px] text-[#a8b6c8]">Confirm your address to set up billing and your phone number.</p>
          <Button type="button" className="mt-3" variant="outline" disabled={busy} onClick={resend}>{busy ? 'Sending...' : 'Send the confirmation link again'}</Button>
          <Msg error={msg?.error} notice={msg?.notice} />
        </div>
      ) : null}
    </Card>
  );
}

function Sessions({ initial, canRevoke }: { initial: SessionView[]; canRevoke: boolean }) {
  const [list, setList] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  async function revoke(s: SessionView) {
    setError(null);
    const r = await sendJson(`/api/auth/sessions/${encodeURIComponent(s.id)}`, undefined, 'DELETE');
    if (!r.ok) { setError(friendly(r.error)); return; }
    if (s.current) { go('/login'); return; }
    setList((l) => l.filter((x) => x.id !== s.id));
  }
  async function others() {
    setError(null);
    const r = await sendJson('/api/auth/sessions/revoke-others', {});
    if (!r.ok) { setError(friendly(r.error)); return; }
    setList((l) => l.filter((x) => x.current));
  }
  return (
    <Card className="mt-6">
      <CardHead
        title="Active sessions"
        subtitle="Devices signed in to your account."
        right={canRevoke && list.length > 1 ? <Button type="button" variant="outline" onClick={others}>Sign out other devices</Button> : undefined}
      />
      <ul className="divide-y divide-[#1f2937]">
        {list.length === 0 ? <li className="p-5 text-[13px] text-[#8b98ab]">No sessions.</li> : null}
        {list.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
            <div className="min-w-0 text-[13px]">
              <p className="truncate text-white">{s.user_agent ?? 'Unknown device'} {s.current ? <Badge tone="brand" className="ml-1">This device</Badge> : null}</p>
              <p className="text-[12px] text-[#8b98ab]">Last active {when(s.last_used_at)} · signed in {when(s.created_at)}{s.ip ? ` · ${s.ip}` : ''}</p>
            </div>
            {canRevoke ? <Button type="button" variant="ghost" onClick={() => revoke(s)}>{s.current ? 'Sign out' : 'Revoke'}</Button> : null}
          </li>
        ))}
      </ul>
      {error ? <div className="px-5 pb-4"><Msg error={error} /></div> : null}
    </Card>
  );
}

function AdminSessions({ count }: { count: number }) {
  const [msg, setMsg] = useState<{ error?: string; notice?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function revokeAll() {
    if (!window.confirm('Sign out every break-glass admin session, including this one if it is one?')) return;
    setBusy(true); setMsg(null);
    const r = await sendJson<{ revoked: number }>('/api/auth/revoke-admin-sessions', {});
    setBusy(false);
    if (!r.ok) { setMsg({ error: friendly(r.error) }); return; }
    setMsg({ notice: `${r.data?.revoked ?? 0} admin session(s) revoked.` });
    window.setTimeout(() => window.location.reload(), 800);
  }
  return (
    <Card className="mt-6">
      <CardHead title="Break-glass admin sessions" subtitle={`${count} active (ADMIN_TOKEN logins, 12 hours each). Revoke them all after rotating ADMIN_TOKEN.`} />
      <div className="p-5">
        <Button type="button" variant="danger" disabled={busy} onClick={revokeAll}>{busy ? 'Revoking...' : 'Revoke all admin sessions'}</Button>
        <Msg error={msg?.error} notice={msg?.notice} />
      </div>
    </Card>
  );
}

export function SecurityPanel(props: {
  email: string | null; emailVerified: boolean; totpEnabled: boolean; recoveryLeft: number; sessions: SessionView[];
  isAdmin: boolean; adminSessionCount: number; twoFactorRequired: boolean; passkeys?: PasskeyView[];
}) {
  return (
    <>
      {props.email ? <EmailStatus email={props.email} verified={props.emailVerified} /> : null}
      {props.email ? (
        <TwoFactor enabled={props.totpEnabled} recoveryLeft={props.recoveryLeft} required={props.twoFactorRequired} canDisable={!props.twoFactorRequired} />
      ) : (
        <Card className="mt-6"><div className="p-5 text-[13px] text-[#a8b6c8]">You are signed in with the break-glass admin token. Two-step verification and personal sessions apply to personal accounts.</div></Card>
      )}
      {props.email ? <PasskeysCard initial={props.passkeys ?? []} /> : null}
      {props.email ? <Sessions initial={props.sessions} canRevoke /> : null}
      {props.isAdmin ? <AdminSessions count={props.adminSessionCount} /> : null}
    </>
  );
}
