'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Logo } from '@/components/ui/logo';
import { cn } from '@/components/ui/cn';
import { draftFromServer, type KnowledgeDraft } from '@/components/knowledge/model';
import { apiRequest } from '@/hooks/use-api';
import type { OnboardingStatus } from '@/app/api/businesses/[id]/onboarding-status/status';
import type { Business, KnowledgeBase } from '@/lib/types';
import { isStepAllowed, resolveStep, STEP_IDS, STEP_LABELS, stepDone, type StepId } from './steps';
import { InfoStep, type ExtractionMeta } from './step-info';
import { ReviewStep } from './step-review';
import { VerifyStep } from './step-verify';
import { PlanStep } from './step-plan';
import { ProvisionStep } from './step-provision';
import { ConnectStep } from './step-connect';
import { TestStep } from './step-test';

export interface FlowProps {
  businessId: string | null;
  isAdmin: boolean;
  priceDisplay: string;
  /** The annual plan can be chosen (STRIPE_PRICE_ID_ANNUAL is configured). */
  annualAvailable?: boolean;
  annualDisplay?: string | null;
  requestedStep: StepId | null;
  checkout: 'success' | 'cancel' | null;
  resumable: { id: string; name: string }[];
}

/** Everything a step needs from the orchestrator. */
export interface StepProps {
  businessId: string;
  status: OnboardingStatus;
  isAdmin: boolean;
  go: (s: StepId) => void;
  refresh: () => Promise<OnboardingStatus | null>;
}

export function OnboardingFlow(props: FlowProps) {
  const { isAdmin, resumable } = props;
  const [businessId, setBusinessId] = useState(props.businessId);
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(props.businessId));
  const [step, setStep] = useState<StepId>(props.requestedStep ?? 'info');
  const [draft, setDraft] = useState<KnowledgeDraft | null>(null);
  const [meta, setMeta] = useState<ExtractionMeta | null>(null);
  const [checkout, setCheckout] = useState(props.checkout);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [resolvedFor, setResolvedFor] = useState<string | null>(null);
  const mounted = useRef(false);

  const refresh = useCallback(async (): Promise<OnboardingStatus | null> => {
    if (!businessId) return null;
    try {
      const s = await apiRequest<OnboardingStatus>(`/api/businesses/${businessId}/onboarding-status`);
      setStatus(s);
      setLoadError(null);
      return s;
    } catch (err) {
      setLoadError((err as Error).message);
      return null;
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  // Resume: derive the step from database facts once the first status arrives.
  useEffect(() => {
    if (!businessId || resolvedFor === businessId) return;
    let alive = true;
    apiRequest<OnboardingStatus>(`/api/businesses/${businessId}/onboarding-status`)
      .then((s) => {
        if (!alive) return;
        setStatus(s);
        setLoadError(null);
        setStep(props.checkout ? 'plan' : resolveStep(props.requestedStep, s));
        setResolvedFor(businessId);
        setLoading(false);
      })
      .catch((err: Error) => {
        if (!alive) return;
        setLoadError(err.message);
        setLoading(false);
      });
    return () => { alive = false; };
  }, [businessId, resolvedFor, props.checkout, props.requestedStep]);

  // Move focus to the step heading when the step changes (not on first paint).
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    headingRef.current?.focus();
  }, [step]);

  const go = useCallback((next: StepId) => {
    setStep(next);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('step', next);
      url.searchParams.delete('checkout');
      window.history.replaceState(null, '', url.toString());
    } catch { /* non-critical */ }
  }, []);

  const adoptBusiness = useCallback((id: string) => {
    setBusinessId(id);
    setResolvedFor(id); // we are driving the steps ourselves
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('b', id);
      window.history.replaceState(null, '', url.toString());
    } catch { /* non-critical */ }
  }, []);

  // The review step needs a draft even after a refresh: rebuild it from what is saved.
  const ensureDraft = useCallback(async (): Promise<KnowledgeDraft | null> => {
    if (draft) return draft;
    if (!businessId) return null;
    try {
      const detail = await apiRequest<{ business: Business; knowledge_base: KnowledgeBase | null }>(`/api/businesses/${businessId}`);
      const d = draftFromServer(detail.business, detail.knowledge_base);
      setDraft(d);
      return d;
    } catch (err) {
      setLoadError((err as Error).message);
      return null;
    }
  }, [draft, businessId]);

  const idx = STEP_IDS.indexOf(step);
  const stepProps: StepProps | null = businessId && status ? { businessId, status, isAdmin, go, refresh } : null;

  return (
    <div className="min-h-screen">
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 pt-6 sm:px-6">
        <Logo />
        <Link href="/dashboard" className="inline-flex min-h-11 items-center text-[13px] text-mute hover:text-white">
          Skip for now
        </Link>
      </header>

      <main className="mx-auto w-full max-w-3xl px-4 pb-16 pt-4 sm:px-6">
        <Stepper step={step} status={status} go={go} />

        <h1 ref={headingRef} tabIndex={-1} className="sr-only">
          Step {idx + 1} of {STEP_IDS.length}: {STEP_LABELS[step]}
        </h1>

        {loadError && !status && businessId ? (
          <Card className="mt-8 p-6">
            <p role="alert" className="text-[13px] text-danger">{loadError}</p>
            <Button className="mt-4" variant="outline" onClick={() => { setLoadError(null); setLoading(true); setResolvedFor(null); }}>Try again</Button>
          </Card>
        ) : loading && businessId ? (
          <div className="mt-8" aria-busy="true"><p className="sr-only" role="status">Loading your setup</p><div className="skeleton h-64" /></div>
        ) : (
          <div className="rise mt-8">
            {step === 'info' ? (
              <InfoStep
                businessId={businessId}
                status={status}
                isAdmin={isAdmin}
                resumable={resumable}
                onBusiness={adoptBusiness}
                onReady={async (d, m, id) => {
                  setDraft(d);
                  setMeta(m);
                  if (id) {
                    const s = await apiRequest<OnboardingStatus>(`/api/businesses/${id}/onboarding-status`).catch(() => null);
                    if (s) setStatus(s);
                  }
                  go('review');
                }}
              />
            ) : null}
            {step === 'review' && stepProps ? (
              <ReviewStep {...stepProps} draft={draft} ensureDraft={ensureDraft} setDraft={setDraft} meta={meta} />
            ) : null}
            {step === 'verify' && stepProps ? <VerifyStep {...stepProps} /> : null}
            {step === 'plan' && stepProps ? <PlanStep {...stepProps} priceDisplay={props.priceDisplay} annualAvailable={props.annualAvailable === true} annualDisplay={props.annualDisplay ?? null} checkout={checkout} clearCheckout={() => setCheckout(null)} /> : null}
            {step === 'provision' && stepProps ? <ProvisionStep {...stepProps} /> : null}
            {step === 'connect' && stepProps ? <ConnectStep {...stepProps} /> : null}
            {step === 'test' && stepProps ? <TestStep {...stepProps} /> : null}
          </div>
        )}
      </main>
    </div>
  );
}

function Stepper({ step, status, go }: { step: StepId; status: OnboardingStatus | null; go: (s: StepId) => void }) {
  const idx = STEP_IDS.indexOf(step);
  return (
    <nav aria-label="Setup progress">
      <p className="text-xs text-dim sm:hidden" aria-hidden="true">
        Step {idx + 1} of {STEP_IDS.length} · {STEP_LABELS[step]}
      </p>
      <ol className="mt-2 flex items-center gap-1.5 sm:mt-0 sm:gap-2">
        {STEP_IDS.map((id, i) => {
          const done = stepDone(id, status) && i < idx;
          const current = id === step;
          const reachable = isStepAllowed(id, status) && !current;
          return (
            <li key={id} className="flex flex-1 items-center sm:flex-none">
              <button
                type="button"
                disabled={!reachable}
                onClick={() => go(id)}
                aria-current={current ? 'step' : undefined}
                aria-label={`${STEP_LABELS[id]}${done ? ', completed' : current ? ', current step' : ''}`}
                className={cn(
                  'flex min-h-11 w-full items-center justify-center gap-2 rounded-full text-xs transition-colors sm:w-auto sm:px-3',
                  current ? 'bg-raised text-white' : done ? 'text-mint-text hover:bg-hover' : 'text-dim',
                  !reachable && !current && 'cursor-default',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-medium',
                    current ? 'bg-brand text-on-brand' : done ? 'bg-mint text-[#042616]' : 'bg-raised text-dim',
                  )}
                >
                  {done ? '✓' : i + 1}
                </span>
                <span className="hidden sm:inline">{STEP_LABELS[id]}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
