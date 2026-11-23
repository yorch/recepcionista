'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button, buttonClass } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiRequest } from '@/hooks/use-api';
import { useCopy } from '@/hooks/use-copy';
import type { OnboardingStatus } from '@/app/api/businesses/[id]/onboarding-status/status';
import { prettyPhone } from './forwarding';
import type { StepProps } from './flow';

const POLL_MS = 4000;

export function TestStep({ businessId, status: initial, isAdmin, go }: StepProps) {
  const [status, setStatus] = useState<OnboardingStatus>(initial);
  const [pollError, setPollError] = useState(false);
  const [alreadyHeard] = useState(() => Boolean(initial.first_call_at));
  const { copied, copy } = useCopy();
  const heard = Boolean(status.first_call_at);
  const phone = status.phone ?? '';

  // Poll for the first inbound call while the tab is visible and until we hear one.
  useEffect(() => {
    if (heard) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (!alive) return;
      if (document.visibilityState === 'visible') {
        try {
          const s = await apiRequest<OnboardingStatus>(`/api/businesses/${businessId}/onboarding-status`);
          if (!alive) return;
          setStatus(s);
          setPollError(false);
          if (s.first_call_at) return;
        } catch {
          if (alive) setPollError(true);
        }
      }
      timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, POLL_MS);
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [heard, businessId]);

  const call = status.latest_call;

  return (
    <section aria-labelledby="test-title">
      <h2 id="test-title" className="text-[28px] font-semibold tracking-[-0.02em] text-white">Make a test call</h2>
      <p className="mt-2 text-sm text-mute">Hear her for yourself before real customers do.</p>

      <Card className="mt-6 p-5">
        <ol className="space-y-3 text-[13px] leading-relaxed text-soft">
          <li><span className="font-medium text-white">1.</span> From a different phone, call <a href={`tel:${phone}`} className="font-mono text-white underline underline-offset-2">{prettyPhone(phone)}</a>.</li>
          <li><span className="font-medium text-white">2.</span> Say something a customer would, like “Hola, my AC is not cooling.” Switch between English and Spanish to hear her follow you.</li>
          <li><span className="font-medium text-white">3.</span> Forwarding set up? Also call your business line and let it ring. After about 20 seconds she should answer.</li>
        </ol>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button variant="outline" onClick={() => void copy(phone)}>{copied ? 'Copied' : 'Copy her number'}</Button>
          <span role="status" className="sr-only">{copied ? 'Number copied' : ''}</span>
        </div>
        {status.phone_mock ? (
          <p role="note" className="mt-4 rounded-xl border border-warn-line bg-warn-bg px-3.5 py-2.5 text-[13px] text-warn">
            This is a demo number, so a real call will not connect.
            {isAdmin ? <> Use the <Link href="/dashboard/demo" className="font-semibold underline">demo console</Link> to simulate a call.</> : null}
          </p>
        ) : null}
      </Card>

      <div aria-live="polite" className="mt-4">
        {heard ? (
          <Card className="border-mint-line bg-mint-bg p-6 text-center">
            <div aria-hidden="true" className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-mint/15 text-2xl text-mint">✓</div>
            <h3 className="mt-4 text-[22px] font-semibold text-white">{alreadyHeard ? 'She has already taken a call' : 'We heard you!'}</h3>
            <p className="mt-1.5 text-[13px] text-mint-text">
              {call
                ? `She answered a ${call.language === 'es' ? 'Spanish' : call.language === 'mixed' ? 'Spanglish' : 'English'} call${call.duration_sec ? ` (${call.duration_sec}s)` : ''}. It is in your dashboard with a transcript.`
                : 'Your first call is in your dashboard.'}
              {status.first_booking_at ? ' She even booked a job.' : ''}
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-3">
              <Link href="/dashboard" className={buttonClass('primary')}>Open my dashboard →</Link>
              <Link href="/dashboard/calls" className={buttonClass('outline')}>See the call</Link>
            </div>
          </Card>
        ) : (
          <Card className="flex items-center gap-3 p-5" aria-busy="true">
            <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full bg-brand live-dot" />
            <p role="status" className="text-[13px] text-body">
              {pollError ? 'Having trouble checking for your call. Retrying…' : 'Listening for your first call… this page updates by itself.'}
            </p>
          </Card>
        )}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        {!heard ? <Link href="/dashboard" className={buttonClass('outline')}>Skip, take me to the dashboard</Link> : null}
        <Button variant="ghost" onClick={() => go('connect')}>Back to forwarding</Button>
      </div>
    </section>
  );
}
