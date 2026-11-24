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
import { useUnsavedGuard } from '@/hooks/use-unsaved-guard';
import type { StepProps } from './flow';
import type { ExtractionMeta } from './step-info';

const NONE: DraftErrors = { services: {}, faqs: {}, hours: {} };

export function ReviewStep({
  businessId, go, refresh, draft, ensureDraft, setDraft, meta,
}: StepProps & {
  draft: KnowledgeDraft | null;
  ensureDraft: () => Promise<KnowledgeDraft | null>;
  setDraft: (d: KnowledgeDraft) => void;
  meta: ExtractionMeta | null;
}) {
  const { busy, request } = useApi();
  const [errors, setErrors] = useState<DraftErrors>(NONE);
  const [base, setBase] = useState<string | null>(null);

  useEffect(() => { if (!draft) void ensureDraft(); }, [draft, ensureDraft]);
  if (draft && base === null) setBase(snapshot(draft));

  const dirty = Boolean(draft && base !== null && snapshot(draft) !== base);
  useUnsavedGuard(dirty);

  if (!draft) return <div aria-busy="true"><p className="sr-only" role="status">Loading what she learned</p><div className="skeleton h-72" /></div>;

  const thin = meta && (meta.confidence === 'low' || meta.source === 'template');

  async function saveAndContinue(next: 'verify') {
    if (!draft) return;
    const found = validateDraft(draft);
    setErrors(found);
    if (draft.services.length === 0) {
      setErrors({ ...found, general: 'Add at least one service so she knows what you sell.' });
      return;
    }
    if (hasErrors(found)) {
      toast.error('Fix the highlighted fields first');
      return;
    }
    try {
      await request(`/api/businesses/${businessId}`, { method: 'PATCH', body: toBusinessPatch(draft) });
      await request(`/api/businesses/${businessId}/onboarding-status/knowledge`, { method: 'PUT', body: toKnowledgePayload(draft) });
    } catch (err) {
      toast.error((err as Error).message);
      return;
    }
    setBase(snapshot(draft));
    await refresh();
    go(next);
  }

  return (
    <section aria-labelledby="review-title">
      <h2 id="review-title" className="text-[28px] font-semibold tracking-[-0.02em] text-white">Check what she learned</h2>
      <p className="mt-2 text-sm text-mute">
        Everything here is what she will say to your customers, so fix anything that is wrong. Prices are starting prices in dollars.
      </p>
      {meta?.url ? <p className="mt-1 break-all text-xs text-dim">Read from {meta.url}</p> : null}
      {thin ? (
        <p role="note" className="mt-4 rounded-xl border border-warn-line bg-warn-bg px-4 py-3 text-[13px] text-warn">
          {meta?.source === 'manual'
            ? 'Add the services you sell, with starting prices if you have them.'
            : 'We could not find much on your website, so some of this is a starting template. Please check every price and service.'}
        </p>
      ) : null}

      <ReadinessChecklist readiness={readinessOfDraft(draft)} className="mt-5" />

      <div className="mt-5">
        <KnowledgeForm draft={draft} errors={errors} onChange={(d) => { setDraft(d); if (hasErrors(errors)) setErrors(validateDraft(d)); }} />
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button onClick={() => saveAndContinue('verify')} disabled={busy} className="flex-1 sm:flex-none sm:px-8">
          {busy ? 'Saving…' : 'Looks right, continue →'}
        </Button>
        <Button variant="ghost" onClick={() => go('info')} disabled={busy}>Back</Button>
      </div>
      <p className="mt-3 text-xs text-dim">You can change all of this later on the Brain page.</p>
    </section>
  );
}
