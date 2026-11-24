'use client';
import { useState } from 'react';
import { AuthLink, FormError, FormNotice, SubmitButton, friendly, sendJson } from './auth-ui';

/** Landing form: the emailed link only renders this page; the click below consumes the token (scanners cannot). */
export function VerifyEmailForm({ token }: { token: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [next, setNext] = useState('/onboarding');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState('busy');
    setError(null);
    const r = await sendJson<{ next?: string }>('/api/auth/verify-email', { token });
    if (!r.ok) {
      setState('idle');
      setError(friendly(r.error));
      return;
    }
    setNext(r.data?.next ?? '/onboarding');
    setState('done');
  }

  if (state === 'done') {
    return (
      <div>
        <FormNotice>Your email address is confirmed.</FormNotice>
        <p className="mt-4 text-center text-[14px]"><AuthLink href={next}>Continue</AuthLink></p>
        <p className="mt-2 text-center text-[12px] text-[#6b7b91]">If you are asked to sign in, use the email and password you chose.</p>
      </div>
    );
  }
  return (
    <form onSubmit={submit}>
      <FormError message={error} />
      <SubmitButton busy={state === 'busy'}>{state === 'busy' ? 'Confirming...' : 'Confirm my email'}</SubmitButton>
    </form>
  );
}
