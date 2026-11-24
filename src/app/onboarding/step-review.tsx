'use client';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { KnowledgeForm } from '@/components/knowledge/knowledge-form';
import { ReadinessChecklist } from '@/components/knowledge/readiness-checklist';
import { readinessOfDraft } from '@/lib/kb/readiness';
import {
  hasErrors, snapshot, toBusinessPatch, toKnowledgePayload, validateDraft, type DraftErrors, type KnowledgeDraft,
} from '@/components/knowledge/model';
import { useApi } from '@/hooks/use-api';
import { errorText } from '@/lib/i18n/api-errors';
import { useLocale, useT } from '@/lib/i18n/client';
import { useUnsavedGuard } from '@/hooks/use-unsaved-guard';
import type { StepProps } from './flow';
import type { ExtractionMeta } from './step-info';

const NONE: DraftErrors = { services: {}, faqs: {}, hours: {} };

export function ReviewStep({
  businessId, status, go, refresh, draft, ensureDraft, setDraft, meta,
}: StepProps & {
  draft: KnowledgeDraft | null;
  ensureDraft: () => Promise<KnowledgeDraft | null>;
  setDraft: (d: KnowledgeDraft) => void;
  meta: ExtractionMeta | null;
}) {
  const t = useT();
  const locale = useLocale();
  const { busy, request } = useApi();
  const [errors, setErrors] = useState<DraftErrors>(NONE);
  const [base, setBase] = useState<string | null>(null);

  useEffect(() => { if (!draft) void ensureDraft(); }, [draft, ensureDraft]);
  if (draft && base === null) setBase(snapshot(draft));

  const dirty = Boolean(draft && base !== null && snapshot(draft) !== base);
  useUnsavedGuard(dirty);

  if (!draft) return <div aria-busy="true"><p className="sr-only" role="status">{t('rv.loading')}</p><div className="skeleton h-72" /></div>;

  const thin = meta && (meta.confidence === 'low' || meta.source === 'template');

  async function saveAndContinue(next: 'verify') {
    if (!draft) return;
    const found = validateDraft(draft, { lang: locale });
    setErrors(found);
    if (draft.services.length === 0) {
      setErrors({ ...found, general: t('rv.addService') });
      return;
    }
    if (hasErrors(found)) {
      toast.error(t('kb.ed.fixFields'));
      return;
    }
    try {
      await request(`/api/businesses/${businessId}`, { method: 'PATCH', body: toBusinessPatch(draft) });
      await request(`/api/businesses/${businessId}/onboarding-status/knowledge`, { method: 'PUT', body: toKnowledgePayload(draft) });
    } catch (err) {
      toast.error(errorText(t, err));
      return;
    }
    setBase(snapshot(draft));
    await refresh();
    go(next);
  }

  return (
    <section aria-labelledby="review-title">
      <h2 id="review-title" className="text-[28px] font-semibold tracking-[-0.02em] text-white">{t('rv.title')}</h2>
      <p className="mt-2 text-sm text-mute">
        {t('rv.lead')}
      </p>
      {meta?.url ? <p className="mt-1 break-all text-xs text-dim">{t('rv.readFrom', { url: meta.url })}</p> : null}
      {thin ? (
        <p role="note" className="mt-4 rounded-xl border border-warn-line bg-warn-bg px-4 py-3 text-[13px] text-warn">
          {meta?.source === 'manual'
            ? t('rv.thinManual')
            : t('rv.thinSite')}
        </p>
      ) : null}

      <ReadinessChecklist readiness={readinessOfDraft(draft, status.vertical, locale)} className="mt-5" />

      <div className="mt-5">
        <KnowledgeForm draft={draft} vertical={status.vertical} errors={errors} onChange={(d) => { setDraft(d); if (hasErrors(errors)) setErrors(validateDraft(d, { lang: locale })); }} />
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button onClick={() => saveAndContinue('verify')} disabled={busy} className="flex-1 sm:flex-none sm:px-8">
          {busy ? t('common.saving') : t('rv.continue')}
        </Button>
        <Button variant="ghost" onClick={() => go('info')} disabled={busy}>{t('common.back')}</Button>
      </div>
      <p className="mt-3 text-xs text-dim">{t('rv.later')}</p>
    </section>
  );
}
