'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TextField } from '@/components/ui/field';
import { cn } from '@/components/ui/cn';
import {
  draftFromExtraction, draftFromPack, toBusinessPatch, toKnowledgePayload, withPackDefaults, type KnowledgeDraft,
} from '@/components/knowledge/model';
import { VerticalPicker } from '@/components/knowledge/vertical-picker';
import { ApiError, apiRequest } from '@/hooks/use-api';
import { normalizeUrl } from '@/lib/extraction/url';
import type { Business, ExtractionResult, Vertical } from '@/lib/types';
import type { OnboardingStatus } from '@/app/api/businesses/[id]/onboarding-status/status';

export interface ExtractionMeta {
  source: ExtractionResult['source'] | 'manual';
  confidence: ExtractionResult['confidence'] | 'manual';
  url: string | null;
}

const PHASES = [
  'Reading your website',
  'Finding your services and prices',
  'Learning your hours and service area',
  'Saving what she learned',
];

function hostName(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'New business'; }
}

export function InfoStep({
  businessId, status, isAdmin, resumable, onBusiness, onReady,
}: {
  businessId: string | null;
  status: OnboardingStatus | null;
  isAdmin: boolean;
  resumable: { id: string; name: string }[];
  onBusiness: (id: string) => void;
  onReady: (draft: KnowledgeDraft, meta: ExtractionMeta, businessId: string | null) => void | Promise<void>;
}) {
  const [url, setUrl] = useState(status?.url ?? '');
  const [name, setName] = useState(status?.name && status.name !== 'New business' ? status.name : '');
  const [urlError, setUrlError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [phase, setPhase] = useState<number | null>(null);
  const [vertical, setVertical] = useState<Vertical>(status?.vertical ?? 'hvac');
  const lang = status?.locale ?? 'en';
  const createdId = useRef<string | null>(businessId); // reuse on retry: never create a second business
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);
  const [busyManual, setBusyManual] = useState(false);
  const reading = phase !== null;

  useEffect(() => () => { if (ticker.current) clearInterval(ticker.current); }, []);

  async function ensureBusiness(label: string, siteUrl: string | null): Promise<string> {
    if (createdId.current) return createdId.current;
    const created = await apiRequest<Business>('/api/businesses', { body: { name: label, url: siteUrl ?? undefined, vertical } });
    createdId.current = created.id;
    onBusiness(created.id);
    return created.id;
  }

  async function readWebsite(e?: React.FormEvent) {
    e?.preventDefault();
    setFormError(null);
    setNameError(null);
    if (!url.trim()) { setUrlError('Paste your website address, or enter your details by hand below.'); return; }
    const normalized = normalizeUrl(url);
    if (!normalized) { setUrlError('That does not look like a website address. Try something like miamicoolair.com'); return; }
    setUrlError(null);
    setPhase(0);
    ticker.current = setInterval(() => setPhase((p) => (p === null ? p : Math.min(p + 1, PHASES.length - 2))), 2500);
    try {
      const id = await ensureBusiness(name.trim() || hostName(normalized), normalized);
      await apiRequest(`/api/businesses/${id}`, { method: 'PATCH', body: { url: normalized, vertical } });
      const ex = await apiRequest<ExtractionResult>('/api/extract', { body: { url: normalized, business_id: id }, timeoutMs: 90_000 });
      setPhase(PHASES.length - 1);
      const draft = withPackDefaults(draftFromExtraction(ex, status?.owner_name ?? ''), vertical, lang);
      // Save immediately so a refresh (or another device) resumes at review with these values.
      await apiRequest(`/api/businesses/${id}`, { method: 'PATCH', body: toBusinessPatch(draft) });
      await apiRequest(`/api/businesses/${id}/onboarding-status/knowledge`, {
        method: 'PUT', body: { ...toKnowledgePayload(draft), extracted_from: normalized },
      });
      await onReady(draft, { source: ex.source, confidence: ex.confidence, url: normalized }, id);
    } catch (err) {
      const e2 = err as ApiError;
      if (e2.status === 403 && /email/i.test(e2.message)) setFormError('Confirm your email address first (we sent you a link), then read your website. Or enter your details by hand below.');
      else if (e2.status === 403) setFormError('Reading websites is not turned on for your account yet. Enter your details by hand below. It takes about two minutes.');
      else if (e2.status === 429) setFormError('Too many tries in a row. Wait a minute and try again, or enter your details by hand.');
      else setFormError(`${e2.message}. You can try again or enter your details by hand.`);
    } finally {
      if (ticker.current) clearInterval(ticker.current);
      setPhase(null);
    }
  }

  async function manual() {
    setFormError(null);
    setUrlError(null);
    if (!name.trim()) { setNameError('Enter your business name.'); return; }
    const normalized = url.trim() ? normalizeUrl(url) : null;
    if (url.trim() && !normalized) { setUrlError('That does not look like a website address.'); return; }
    setNameError(null);
    setBusyManual(true);
    try {
      const id = await ensureBusiness(name.trim(), normalized);
      await apiRequest(`/api/businesses/${id}`, { method: 'PATCH', body: { name: name.trim(), vertical, ...(normalized ? { url: normalized } : {}) } });
      // Pre-filled with this trade's services, FAQs and hours: every line stays editable on the next screen.
      const blank: KnowledgeDraft = draftFromPack(vertical, lang, status?.owner_name ?? '', name.trim());
      await onReady(blank, { source: 'manual', confidence: 'manual', url: normalized }, id);
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusyManual(false);
    }
  }

  if (reading) {
    return (
      <section aria-labelledby="info-title">
        <h2 id="info-title" className="text-[28px] font-semibold tracking-[-0.02em] text-white">Teaching her your business…</h2>
        <p className="mt-2 break-all text-sm text-mute">{url}</p>
        <Card className="mt-6 divide-y divide-[#1a2330]" aria-busy="true">
          {PHASES.map((label, i) => (
            <div key={label} className="flex items-center gap-3 px-5 py-4">
              <span aria-hidden="true" className={cn('grid h-6 w-6 place-items-center rounded-full text-xs',
                i < (phase ?? 0) ? 'bg-mint text-[#042616]' : i === phase ? 'bg-brand text-on-brand' : 'bg-raised text-dim')}>
                {i < (phase ?? 0) ? '✓' : i + 1}
              </span>
              <span className={cn('text-sm', i <= (phase ?? 0) ? 'text-soft' : 'text-dim')}>{label}</span>
              {i === phase ? <span className="sr-only" role="status">In progress</span> : null}
            </div>
          ))}
        </Card>
        <p className="mt-3 text-xs text-dim">This can take up to a minute for large sites.</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="info-title">
      <h2 id="info-title" className="text-[30px] font-semibold leading-tight tracking-[-0.02em] text-white">Who are we hiring for?</h2>
      <p className="mt-2 text-sm text-mute">
        Paste your website and she learns your services, prices and hours. You can fix anything on the next screen.
      </p>

      {isAdmin && !businessId && resumable.length > 0 ? (
        <Card className="mt-5 p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-dim">Pick up where you left off</p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {resumable.map((b) => (
              <li key={b.id}><a href={`/onboarding?b=${encodeURIComponent(b.id)}`} className="inline-flex min-h-11 items-center rounded-xl border border-line-3 px-3.5 text-[13px] text-soft hover:bg-panel-2">{b.name}</a></li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card className="mt-6 p-5">
        <VerticalPicker value={vertical} onChange={setVertical} lang={lang} disabled={busyManual} />
        <div className="my-5 h-px bg-line" aria-hidden="true" />
        <form onSubmit={readWebsite} noValidate>
          <TextField
            label="Business website" value={url} autoFocus inputMode="url" autoComplete="url" placeholder="miamicoolair.com"
            onChange={(e) => { setUrl(e.target.value); setUrlError(null); }} error={urlError}
            hint="A Google Business link works too."
          />
          {formError ? <p role="alert" className="mt-3 rounded-xl border border-warn-line bg-warn-bg px-3.5 py-3 text-[13px] text-warn">{formError}</p> : null}
          <Button type="submit" className="mt-5 w-full" disabled={busyManual}>Read my website →</Button>
        </form>

        <div className="my-6 flex items-center gap-3 text-xs text-dim" aria-hidden="true">
          <span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" />
        </div>

        <p className="text-[13px] text-mute">No website, or it is thin? Type your details in yourself.</p>
        <TextField
          className="mt-3" label="Business name" value={name} autoComplete="organization"
          onChange={(e) => { setName(e.target.value); setNameError(null); }} error={nameError}
        />
        <Button variant="outline" className="mt-4 w-full" onClick={manual} disabled={busyManual}>{busyManual ? 'Saving…' : 'Enter my details by hand'}</Button>
      </Card>
    </section>
  );
}
