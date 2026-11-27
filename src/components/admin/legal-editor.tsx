'use client';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHead } from '@/components/ui/card';
import { cn } from '@/components/ui/cn';
import { inputClass, SelectField, TextField } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/page-header';
import { MarkdownView } from '@/components/legal/markdown-view';
import { apiRequest } from '@/hooks/use-api';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/core';
import { diffLines, diffStats, type DiffOp } from '@/lib/text-diff';
import { publishPhrase } from '@/lib/admin-ui/model';
import type { LegalLocale, LegalPageView, LegalSlug, LegalVersionView } from '@/lib/admin/legal';
import { useAdmin } from './provider';
import { useJson } from './use-json';
import { confirmReady, ConfirmFields, ErrorPanel, formatWhen, LoadingBlock, Problems } from './ui';

interface Listing { pages: LegalPageView[]; slugs: LegalSlug[]; locales: LegalLocale[]; max_body_chars: number }
interface Detail { page: LegalPageView; version: LegalVersionView | null }

/**
 * The legal page editor (D14): Terms, Privacy and SMS terms per language, written as markdown with a live preview rendered by the SAME safe renderer the public
 * pages use (no raw HTML, no javascript: links). One draft per page; publishing freezes it as the next numbered version (owner only, reason + typed phrase);
 * versions are immutable and can be compared line by line.
 */
export function LegalEditorPage() {
  const t = useT();
  const listing = useJson<Listing>('/api/admin/legal');
  const [sel, setSel] = useState<{ slug: LegalSlug; locale: LegalLocale }>({ slug: 'terms', locale: 'en' });

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t('ac.page.legal.title')} subtitle={t('ac.page.legal.sub')} />
      {listing.loading && !listing.data ? <LoadingBlock rows={3} /> : listing.error && !listing.data ? <ErrorPanel error={listing.error} onRetry={listing.reload} /> : listing.data ? (
        <>
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            <Toggle label={t('ac.legal.page')} options={listing.data.slugs.map((s) => ({ value: s, label: t(`ac.legal.slug.${s}` as MessageKey) }))} value={sel.slug} onChange={(slug) => setSel((s) => ({ ...s, slug }))} />
            <Toggle label={t('ac.legal.language')} options={listing.data.locales.map((l) => ({ value: l, label: l === 'en' ? 'English' : 'Español' }))} value={sel.locale} onChange={(locale) => setSel((s) => ({ ...s, locale }))} />
          </div>
          <PageEditor key={`${sel.slug}/${sel.locale}`} slug={sel.slug} locale={sel.locale} summary={listing.data.pages.find((p) => p.slug === sel.slug && p.locale === sel.locale)} max={listing.data.max_body_chars} onChanged={listing.reload} />
        </>
      ) : null}
    </div>
  );
}

function Toggle<V extends string>({ label, options, value, onChange }: { label: string; options: { value: V; label: string }[]; value: V; onChange: (v: V) => void }) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-2">
      <span className="text-xs uppercase tracking-wider text-dim">{label}</span>
      <div className="inline-flex rounded-xl border border-line-3 p-0.5">
        {options.map((o) => (
          <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)} className={cn('min-h-10 rounded-[10px] px-3 text-[13px] font-medium transition-colors', o.value === value ? 'bg-raised text-white' : 'text-mute hover:text-soft')}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function PageEditor({ slug, locale, summary, max, onChanged }: { slug: LegalSlug; locale: LegalLocale; summary: LegalPageView | undefined; max: number; onChanged: () => void }) {
  const t = useT();
  const detail = useJson<Detail>(`/api/admin/legal/${slug}/${locale}`);
  const { can } = useAdmin();
  // "Load into editor" hands a version's text to the draft editor; the editor remounts (key) with it as its starting text
  const [injected, setInjected] = useState<{ n: number; body: string } | null>(null);
  const page = detail.data?.page ?? summary;
  const loaded = detail.data?.version ?? null;
  const loadedKey = detail.data ? `${detail.data.page.published_version}/${detail.data.page.draft_version}/${loaded?.version ?? 0}/${injected?.n ?? 0}` : null;
  const refresh = () => { detail.reload(); onChanged(); };

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHead
          title={t(`ac.legal.slug.${slug}` as MessageKey)}
          subtitle={`${locale === 'en' ? 'English' : 'Español'} · ${page?.published_version ? t('ac.legal.publishedV', { n: page.published_version }) : t('ac.legal.notPublished')}${page?.draft_version ? ` · ${t('ac.legal.draftV', { n: page.draft_version })}` : ''}`}
          right={<a href={`/${slug === 'sms_terms' ? 'sms-terms' : slug}`} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-[13px] text-brand-soft hover:underline">{t('ac.legal.openPublic')}<span className="sr-only"> ({t('ac.legal.newTab')})</span></a>}
        />
        <div className="flex flex-col gap-4 p-5">
          {detail.loading && !detail.data ? <LoadingBlock rows={2} /> : detail.error && !detail.data ? <ErrorPanel error={detail.error} onRetry={detail.reload} /> : loadedKey !== null ? (
            <DraftEditor key={loadedKey} slug={slug} locale={locale} page={page} loaded={loaded} startText={injected?.body} max={max} onSaved={refresh} />
          ) : null}
        </div>
      </Card>

      <Versions slug={slug} locale={locale} page={page} canEdit={can('legal.write')} onLoadIntoEditor={(n, body) => { setInjected({ n: (injected?.n ?? 0) + 1, body }); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />
    </div>
  );
}

function DraftEditor({ slug, locale, page, loaded, startText, max, onSaved }: {
  slug: LegalSlug; locale: LegalLocale; page: LegalPageView | undefined; loaded: LegalVersionView | null; startText: string | undefined; max: number; onSaved: () => void;
}) {
  const t = useT();
  const lang = useLocale();
  const { can, guard } = useAdmin();
  const base = loaded?.body ?? '';
  const [text, setText] = useState(startText ?? base);
  const [note, setNote] = useState(loaded?.draft ? loaded.note ?? '' : '');
  const [view, setView] = useState<'edit' | 'preview'>('edit');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [publishing, setPublishing] = useState(false);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');

  const draftId = page?.draft_version ?? null;
  const dirty = text !== base;
  const writer = can('legal.write');
  const publisher = can('legal.publish');
  const phrase = publishPhrase(slug, locale);
  const num = (n: number) => n.toLocaleString(lang === 'es' ? 'es-US' : 'en-US');

  async function run(action: () => Promise<void>, done?: string) {
    setBusy(true); setError(null);
    try { await guard(action); if (done) toast.success(done); } catch (e) { setError(e); } finally { setBusy(false); }
  }
  const save = () => run(async () => { await apiRequest(`/api/admin/legal/${slug}/${locale}`, { method: 'PUT', body: { body: text, note: note.trim() || undefined } }); onSaved(); }, t('ac.legal.saved'));
  const discard = () => run(async () => { await apiRequest(`/api/admin/legal/${slug}/${locale}`, { method: 'DELETE' }); onSaved(); }, t('ac.legal.discarded'));
  const publish = () => run(async () => { await apiRequest(`/api/admin/legal/${slug}/${locale}/publish`, { body: { reason: reason.trim(), confirm: typed, version: loaded?.version, hash: loaded?.hash } }); setPublishing(false); setReason(''); setTyped(''); onSaved(); }, t('ac.legal.published'));

  return (
    <>
      {!page?.published_version ? <p role="status" className="rounded-xl border border-warn-line bg-warn-bg px-4 py-2.5 text-[13px] text-warn">{t('ac.legal.unpublishedNote')}</p> : null}
      <div className="flex gap-2 md:hidden" role="group" aria-label={t('ac.legal.view')}>
        <Button variant={view === 'edit' ? 'outline' : 'ghost'} aria-pressed={view === 'edit'} onClick={() => setView('edit')}>{t('ac.legal.edit')}</Button>
        <Button variant={view === 'preview' ? 'outline' : 'ghost'} aria-pressed={view === 'preview'} onClick={() => setView('preview')}>{t('ac.legal.preview')}</Button>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className={cn(view === 'preview' && 'hidden md:block')}>
          <label htmlFor="legal-body" className="block text-xs font-medium uppercase tracking-wider text-dim">{t('ac.legal.markdown')}</label>
          <textarea
            id="legal-body" value={text} onChange={(e) => setText(e.target.value)} readOnly={!writer} rows={22} maxLength={max} spellCheck lang={locale}
            aria-describedby="legal-body-hint" className={cn(inputClass, 'mt-1.5 min-h-[24rem] resize-y border-line-2 font-mono text-[13px] leading-relaxed')}
          />
          <p id="legal-body-hint" className="mt-1 text-xs text-dim">{t('ac.legal.hint', { n: num(text.length), max: num(max) })}</p>
        </div>
        <div className={cn(view === 'edit' && 'hidden md:block')}>
          <p className="text-xs font-medium uppercase tracking-wider text-dim" id="legal-preview-label">{t('ac.legal.livePreview')}</p>
          <div role="region" aria-labelledby="legal-preview-label" className="mt-1.5 min-h-[24rem] overflow-auto rounded-xl border border-line bg-sunken p-4 text-[14px] leading-relaxed text-body">
            {text.trim() ? <MarkdownView source={text} /> : <p className="text-mute">{t('ac.legal.previewEmpty')}</p>}
          </div>
        </div>
      </div>
      <TextField label={t('ac.legal.note')} optional value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} disabled={!writer} />
      {error ? <Problems error={error} /> : null}
      {writer ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={busy || !text.trim() || (!dirty && Boolean(draftId))} onClick={() => void save()}>{busy ? t('common.loading') : t('ac.legal.saveDraft')}</Button>
          {draftId ? <Button variant="outline" disabled={busy} onClick={() => void discard()}>{t('ac.legal.discard')}</Button> : null}
          {publisher && draftId && loaded?.draft && !publishing ? <Button variant="outline" disabled={busy || dirty} onClick={() => setPublishing(true)}>{t('ac.legal.publish')}</Button> : null}
          {dirty ? <span role="status" className="text-xs text-warn">{t('ac.legal.unsaved')}</span> : null}
          {draftId && !publisher ? <span className="text-xs text-dim">{t('ac.legal.ownerPublishes')}</span> : null}
        </div>
      ) : <p className="text-[13px] text-mute">{t('ac.legal.readOnly')}</p>}
      {publishing ? (
        <div role="group" aria-label={t('ac.legal.publish')} className="flex flex-col gap-3 rounded-xl border border-brand-line bg-brand-bg/30 p-4">
          <p className="text-[13px] text-soft">{t('ac.legal.publishBody', { n: draftId ?? 0 })}</p>
          <ConfirmFields reasonRequired phrase={phrase} reason={reason} onReason={setReason} typed={typed} onTyped={setTyped} />
          <div className="flex gap-2">
            <Button disabled={busy || !confirmReady({ reasonRequired: true, reason, phrase, typed })} onClick={() => void publish()}>{t('ac.legal.publishDo')}</Button>
            <Button variant="ghost" onClick={() => setPublishing(false)}>{t('common.cancel')}</Button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function Versions({ slug, locale, page, onLoadIntoEditor, canEdit }: { slug: LegalSlug; locale: LegalLocale; page: LegalPageView | undefined; onLoadIntoEditor: (n: number, body: string) => void; canEdit: boolean }) {
  const t = useT();
  const lang = useLocale();
  const versions = useMemo(() => page?.versions ?? [], [page]);
  const [a, setA] = useState<number | ''>('');
  const [b, setB] = useState<number | ''>('');
  const [ops, setOps] = useState<DiffOp[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const fetchBody = (n: number) => apiRequest<Detail>(`/api/admin/legal/${slug}/${locale}?version=${n}`).then((d) => d.version?.body ?? '');

  async function compare() {
    if (a === '' || b === '') return;
    setBusy(true); setErr(null);
    try { setOps(diffLines(await fetchBody(a), await fetchBody(b))); } catch (e) { setErr(e); setOps(null); } finally { setBusy(false); }
  }
  async function load(n: number) {
    try { onLoadIntoEditor(n, await fetchBody(n)); toast.success(t('ac.legal.loaded', { n })); } catch (e) { setErr(e); }
  }

  const stats = ops ? diffStats(ops) : null;
  return (
    <Card>
      <CardHead title={t('ac.legal.versions')} subtitle={t('ac.legal.versionsSub')} />
      {versions.length === 0 ? <p className="p-5 text-[13px] text-mute">{t('ac.legal.versionsNone')}</p> : (
        <>
          <ul className="divide-y divide-line">
            {versions.map((v) => (
              <li key={v.version} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[14px] font-medium text-white">{t('ac.legal.version', { n: v.version })}</span>
                    {v.draft ? <Badge tone="unsure">{t('ac.legal.badgeDraft')}</Badge> : v.version === page?.published_version ? <Badge tone="routine">{t('ac.legal.badgePublished')}</Badge> : <Badge>{t('ac.legal.badgeOld')}</Badge>}
                  </div>
                  <p className="mt-0.5 text-xs text-dim">{v.published_at ? t('ac.legal.publishedOn', { when: formatWhen(v.published_at, lang) }) : t('ac.legal.createdOn', { when: formatWhen(v.created_at, lang) })} · {t('ac.legal.chars', { n: v.chars })}{v.note ? ` · ${v.note}` : ''}</p>
                </div>
                {canEdit ? <Button variant="ghost" onClick={() => void load(v.version)}>{t('ac.legal.loadIntoEditor')}</Button> : null}
              </li>
            ))}
          </ul>
          {versions.length >= 2 ? (
            <div className="flex flex-col gap-3 border-t border-line p-5">
              <h3 className="text-sm font-semibold text-white">{t('ac.legal.compare')}</h3>
              <div className="flex flex-wrap items-end gap-3">
                <SelectField label={t('ac.legal.compareFrom')} value={a} onChange={(e) => setA(e.target.value === '' ? '' : Number(e.target.value))} className="min-w-40">
                  <option value="">{t('ac.legal.choose')}</option>{versions.map((v) => <option key={v.version} value={v.version}>{t('ac.legal.version', { n: v.version })}</option>)}
                </SelectField>
                <SelectField label={t('ac.legal.compareTo')} value={b} onChange={(e) => setB(e.target.value === '' ? '' : Number(e.target.value))} className="min-w-40">
                  <option value="">{t('ac.legal.choose')}</option>{versions.map((v) => <option key={v.version} value={v.version}>{t('ac.legal.version', { n: v.version })}</option>)}
                </SelectField>
                <Button variant="outline" disabled={busy || a === '' || b === ''} onClick={() => void compare()}>{busy ? t('common.loading') : t('ac.legal.compareDo')}</Button>
              </div>
              {err ? <Problems error={err} /> : null}
              {ops ? <DiffView ops={ops} added={stats?.added ?? 0} removed={stats?.removed ?? 0} /> : null}
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}

function DiffView({ ops, added, removed }: { ops: DiffOp[]; added: number; removed: number }) {
  const t = useT();
  if (added === 0 && removed === 0) return <p role="status" className="text-[13px] text-mute">{t('ac.legal.identical')}</p>;
  return (
    <div>
      <p role="status" className="mb-2 text-xs text-dim">{t('ac.legal.diffStats', { added, removed })}</p>
      <pre aria-label={t('ac.legal.compare')} className="max-h-[28rem] overflow-auto rounded-xl border border-line bg-sunken p-0 font-mono text-[12px] leading-relaxed">
        {ops.map((o, i) => (
          <span key={i} className={cn('block whitespace-pre-wrap break-words px-3', o.type === 'add' && 'bg-mint-bg text-mint-text', o.type === 'del' && 'bg-danger-bg text-danger', o.type === 'same' && 'text-mute')}>
            <span aria-hidden="true">{o.type === 'add' ? '+ ' : o.type === 'del' ? '− ' : '  '}</span>
            <span className="sr-only">{o.type === 'add' ? t('ac.legal.srAdded') : o.type === 'del' ? t('ac.legal.srRemoved') : ''}</span>
            {o.text || ' '}
          </span>
        ))}
      </pre>
    </div>
  );
}
