'use client';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TextField } from '@/components/ui/field';
import { cn } from '@/components/ui/cn';
import {
  draftFromExtraction, draftFromPack, toBusinessPatch, toKnowledgePayload, withPackDefaults, type KnowledgeDraft,
} from '@/components/knowledge/model';
import { VerticalPicker } from '@/components/knowledge/vertical-picker';
import { ApiError, apiRequest } from '@/hooks/use-api';
import { errorText } from '@/lib/i18n/api-errors';
import { useLocale, useT } from '@/lib/i18n/client';
import { normalizeUrl } from '@/lib/extraction/url';
import type { Business, ExtractionResult, Vertical } from '@/lib/types';
import type { OnboardingStatus } from '@/app/api/businesses/[id]/onboarding-status/status';

export interface ExtractionMeta {
  source: ExtractionResult['source'] | 'manual';
  confidence: ExtractionResult['confidence'] | 'manual';
  url: string | null;
}

/** Real stages only: the website is read and understood by ONE request (its duration is not broken down by the server), then the result is saved. */
const PHASES = ['pd.info.stage.read', 'info.phase.3'] as const;

function hostName(url: string, fallback: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return fallback; }
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
  const t = useT();
  const uiLocale = useLocale();
  const [url, setUrl] = useState(status?.url ?? '');
  const [name, setName] = useState(status?.name && status.name !== 'New business' ? status.name : '');
  const [urlError, setUrlError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [phase, setPhase] = useState<number | null>(null);
  const [vertical, setVertical] = useState<Vertical>(status?.vertical ?? 'hvac');
  // New content (services, FAQs, the AI's language) follows the business's default language; the screen follows the viewer's own.
  const lang = status?.locale ?? uiLocale;
  const createdId = useRef<string | null>(businessId); // reuse on retry: never create a second business
  const [busyManual, setBusyManual] = useState(false);
  const reading = phase !== null;

  async function ensureBusiness(label: string, siteUrl: string | null): Promise<string> {
    if (createdId.current) return createdId.current;
    const created = await apiRequest<Business>('/api/businesses', { body: { name: label, url: siteUrl ?? undefined, vertical, locale_default: lang } });
    createdId.current = created.id;
    onBusiness(created.id);
    return created.id;
  }

  async function readWebsite(e?: React.FormEvent) {
    e?.preventDefault();
    setFormError(null);
    setNameError(null);
    if (!url.trim()) { setUrlError(t('info.urlEmpty')); return; }
    const normalized = normalizeUrl(url);
    if (!normalized) { setUrlError(t('info.urlBad')); return; }
    setUrlError(null);
    setPhase(0);
    try {
      const id = await ensureBusiness(name.trim() || hostName(normalized, t('info.newBusiness')), normalized);
      await apiRequest(`/api/businesses/${id}`, { method: 'PATCH', body: { url: normalized, vertical } });
      const ex = await apiRequest<ExtractionResult>('/api/extract', { body: { url: normalized, business_id: id }, timeoutMs: 90_000 });
      setPhase(1);
      const draft = withPackDefaults(draftFromExtraction(ex, status?.owner_name ?? ''), vertical, lang);
      // Save immediately so a refresh (or another device) resumes at review with these values.
      await apiRequest(`/api/businesses/${id}`, { method: 'PATCH', body: toBusinessPatch(draft) });
      await apiRequest(`/api/businesses/${id}/onboarding-status/knowledge`, {
        method: 'PUT', body: { ...toKnowledgePayload(draft), extracted_from: normalized },
      });
      await onReady(draft, { source: ex.source, confidence: ex.confidence, url: normalized }, id);
    } catch (err) {
      const e2 = err as ApiError;
      if (e2.status === 403 && /email/i.test(e2.message)) setFormError(t('info.verifyEmail'));
      else if (e2.status === 403) setFormError(t('info.notEnabled'));
      else if (e2.status === 429) setFormError(t('info.tooMany'));
      else setFormError(t('info.retryOrManual', { message: errorText(t, e2) }));
    } finally {
      setPhase(null);
    }
  }

  async function manual() {
    setFormError(null);
    setUrlError(null);
    if (!name.trim()) { setNameError(t('info.nameRequired')); return; }
    const normalized = url.trim() ? normalizeUrl(url) : null;
    if (url.trim() && !normalized) { setUrlError(t('info.urlBadShort')); return; }
    setNameError(null);
    setBusyManual(true);
    try {
      const id = await ensureBusiness(name.trim(), normalized);
      await apiRequest(`/api/businesses/${id}`, { method: 'PATCH', body: { name: name.trim(), vertical, ...(normalized ? { url: normalized } : {}) } });
      // Pre-filled with this trade's services, FAQs and hours: every line stays editable on the next screen.
      const blank: KnowledgeDraft = draftFromPack(vertical, lang, status?.owner_name ?? '', name.trim());
      await onReady(blank, { source: 'manual', confidence: 'manual', url: normalized }, id);
    } catch (err) {
      setFormError(errorText(t, err));
    } finally {
      setBusyManual(false);
    }
  }

  if (reading) {
    return (
      <section aria-labelledby="info-title">
        <h2 id="info-title" className="text-[28px] font-semibold tracking-[-0.02em] text-white">{t('info.teaching')}</h2>
        <p className="mt-2 break-all text-sm text-mute">{url}</p>
        <Card className="mt-6 divide-y divide-[#1a2330]" aria-busy="true">
          {PHASES.map((labelKey, i) => (
            <div key={labelKey} className="flex items-center gap-3 px-5 py-4">
              <span aria-hidden="true" className={cn('grid h-6 w-6 place-items-center rounded-full text-xs',
                i < (phase ?? 0) ? 'bg-mint text-[#042616]' : i === phase ? 'bg-brand text-on-brand' : 'bg-raised text-dim')}>
                {i < (phase ?? 0) ? '✓' : i + 1}
              </span>
              <span className={cn('text-sm', i <= (phase ?? 0) ? 'text-soft' : 'text-dim')}>{t(labelKey)}</span>
              {i === phase ? <span className="sr-only" role="status">{t('info.inProgress')}</span> : null}
            </div>
          ))}
        </Card>
        <p className="mt-3 text-xs text-dim">{t('info.takesLong')}</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="info-title">
      <h2 id="info-title" className="text-[30px] font-semibold leading-tight tracking-[-0.02em] text-white">{t('info.title')}</h2>
      <p className="mt-2 text-sm text-mute">
        {t('info.lead')}
      </p>

      {isAdmin && !businessId && resumable.length > 0 ? (
        <Card className="mt-5 p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-dim">{t('info.resume')}</p>
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
            label={t('info.website')} value={url} autoFocus inputMode="url" autoComplete="url" placeholder="miamicoolair.com"
            onChange={(e) => { setUrl(e.target.value); setUrlError(null); }} error={urlError}
            hint={t('info.websiteHint')}
          />
          <p className="mt-2 text-xs text-dim">{t('pd.info.needsLlm')}</p>
          {formError ? <p role="alert" className="mt-3 rounded-xl border border-warn-line bg-warn-bg px-3.5 py-3 text-[13px] text-warn">{formError}</p> : null}
          <Button type="submit" className="mt-5 w-full" disabled={busyManual}>{t('info.read')}</Button>
        </form>

        <div className="my-6 flex items-center gap-3 text-xs text-dim" aria-hidden="true">
          <span className="h-px flex-1 bg-line" /> {t('info.or')} <span className="h-px flex-1 bg-line" />
        </div>

        <p className="text-[13px] text-mute">{t('info.noSite')}</p>
        <TextField
          className="mt-3" label={t('kb.form.name')} value={name} autoComplete="organization"
          onChange={(e) => { setName(e.target.value); setNameError(null); }} error={nameError}
        />
        <Button variant="outline" className="mt-4 w-full" onClick={manual} disabled={busyManual}>{busyManual ? t('common.saving') : t('info.manual')}</Button>
      </Card>
    </section>
  );
}
