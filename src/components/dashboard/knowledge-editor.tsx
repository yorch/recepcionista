'use client';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardHead } from '@/components/ui/card';
import { TextAreaField } from '@/components/ui/field';
import { KnowledgeForm } from '@/components/knowledge/knowledge-form';
import {
  describeMerge, draftFromServer, hasErrors, mergeExtraction, snapshot, toBusinessPatch, toKnowledgePayload, validateDraft,
  type DraftErrors,
} from '@/components/knowledge/model';
import { ApiError, useApi } from '@/hooks/use-api';
import { useUnsavedGuard } from '@/hooks/use-unsaved-guard';
import type { Business, ExtractionResult, KnowledgeBase } from '@/lib/types';

type BizFields = Pick<Business, 'name' | 'owner_name' | 'service_area' | 'hours' | 'url'> & Partial<Pick<Business, 'vertical'>>;
type KbFields = Pick<KnowledgeBase, 'services' | 'faqs' | 'pricing_notes' | 'call_script' | 'system_prompt'>;

const NO_ERRORS: DraftErrors = { services: {}, faqs: {}, hours: {} };

export function KnowledgeEditor({
  businessId, business, kb, lastExtracted, timeZone,
}: {
  businessId: string;
  business: BizFields;
  kb: KbFields;
  lastExtracted: { url: string | null; at: string } | null;
  timeZone: string;
}) {
  const router = useRouter();
  const { busy, request } = useApi();
  const initial = useMemo(() => draftFromServer(business, kb), [business, kb]);
  const [draft, setDraft] = useState(initial);
  const [script, setScript] = useState(kb.call_script);
  const [baseline, setBaseline] = useState({ snap: snapshot(initial), script: kb.call_script });
  const [errors, setErrors] = useState<DraftErrors>(NO_ERRORS);
  const [extractedFrom, setExtractedFrom] = useState<string | null>(null);
  const [mergeNote, setMergeNote] = useState<string | null>(null);

  const dirty = snapshot(draft) !== baseline.snap || script !== baseline.script;
  useUnsavedGuard(dirty);

  const when = (iso: string) =>
    new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone }).format(new Date(iso));

  function onChange(next: typeof draft) {
    setDraft(next);
    if (hasErrors(errors)) setErrors(validateDraft(next)); // clear errors as the owner fixes them
  }

  async function save() {
    const found = validateDraft(draft);
    setErrors(found);
    if (hasErrors(found)) {
      toast.error('Fix the highlighted fields first');
      return;
    }
    try {
      await request(`/api/businesses/${businessId}`, { method: 'PATCH', body: toBusinessPatch(draft) });
      await request(`/api/businesses/${businessId}/onboarding-status/knowledge`, {
        method: 'PUT',
        body: { ...toKnowledgePayload(draft), call_script: script, ...(extractedFrom ? { extracted_from: extractedFrom } : {}) },
      });
    } catch (err) {
      toast.error((err as Error).message);
      return;
    }
    setBaseline({ snap: snapshot(draft), script });
    setExtractedFrom(null);
    setMergeNote(null);
    toast.success('Saved. She will use this on the next call');
    router.refresh();
  }

  async function reextract() {
    if (!business.url) return;
    if (dirty && !window.confirm('Your unsaved edits are kept. The website only fills gaps and adds what is missing. Continue?')) return;
    try {
      const ex = await request<ExtractionResult>('/api/extract', { method: 'POST', body: { url: business.url, business_id: businessId }, timeoutMs: 90_000 });
      const { draft: merged, summary } = mergeExtraction(draft, ex);
      setDraft(merged);
      setExtractedFrom(business.url);
      const note = describeMerge(summary);
      setMergeNote(`${note} Review the changes, then save.`);
      toast.success(note);
    } catch (err) {
      const e = err as ApiError;
      toast.error(e.status === 403
        ? 'Re-reading your website is not available on your account. Ask an admin, or edit by hand.'
        : e.message);
    }
  }

  function discard() {
    const fresh = draftFromServer(business, kb);
    setDraft(fresh);
    setScript(kb.call_script);
    setBaseline({ snap: snapshot(fresh), script: kb.call_script });
    setErrors(NO_ERRORS);
    setExtractedFrom(null);
    setMergeNote(null);
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[13px] text-soft">
              {lastExtracted
                ? <>Last read from <span className="break-all font-mono text-xs">{lastExtracted.url ?? 'your website'}</span> on {when(lastExtracted.at)}.</>
                : business.url
                  ? <>Source website: <span className="break-all font-mono text-xs">{business.url}</span>. Not re-read yet.</>
                  : 'No website on file. Everything here was entered by hand.'}
            </p>
            <p className="mt-1 text-xs text-dim">Re-reading adds what is new and fills blanks. It never overwrites what you typed.</p>
          </div>
          {business.url ? (
            <Button variant="outline" onClick={reextract} disabled={busy}>{busy ? 'Reading…' : 'Re-read my website'}</Button>
          ) : null}
        </div>
        {mergeNote ? <p role="status" className="mt-3 rounded-xl bg-sunken px-3.5 py-2.5 text-[13px] text-body">{mergeNote}</p> : null}
      </Card>

      <KnowledgeForm draft={draft} onChange={onChange} errors={errors} vertical={business.vertical} />

      <Card>
        <CardHead title="Her opening script" subtitle="The words she opens with" />
        <div className="p-4">
          <TextAreaField label="Opening script" srOnlyLabel rows={9} value={script} onChange={(e) => setScript(e.target.value)} maxLength={8000} />
          <details className="mt-4">
            <summary className="inline-flex min-h-11 cursor-pointer items-center text-xs text-dim hover:text-mute">Full system prompt (read only)</summary>
            <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-sunken p-3 text-xs leading-relaxed text-dim">{kb.system_prompt}</pre>
          </details>
        </div>
      </Card>

      <div className="sticky bottom-3 z-10 flex flex-wrap items-center gap-3 rounded-2xl border border-line-3 bg-panel/95 p-3 shadow-lg backdrop-blur">
        <p role="status" className="min-w-0 flex-1 text-[13px] text-mute">
          {dirty ? 'You have unsaved changes.' : 'All changes saved.'}
        </p>
        <Button variant="ghost" onClick={discard} disabled={!dirty || busy}>Discard</Button>
        <Button onClick={save} disabled={!dirty || busy}>{busy ? 'Saving…' : 'Save changes'}</Button>
      </div>
    </div>
  );
}
