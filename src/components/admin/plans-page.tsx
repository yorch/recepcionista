'use client';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHead } from '@/components/ui/card';
import { TextField } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/page-header';
import { apiRequest } from '@/hooks/use-api';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/core';
import { EmptyStateInline } from './empty-inline';
import { useAdmin } from './provider';
import type { PlanView } from './tenant-api';
import { useJson } from './use-json';
import { ConfirmFields, confirmReady, ErrorPanel, LoadingBlock } from './ui';
import { Problems } from './tenant-errors';

interface PriceInfo { amount_cents: number; currency: string; interval: 'month' | 'year'; interval_count: number }
interface Prices { platform: { monthly: PriceInfo | null; annual: PriceInfo | null }; plans: Record<string, { monthly: PriceInfo | null; annual: PriceInfo | null }>; stripe_configured: boolean }
interface Listing { plans: PlanView[]; features: string[] }

export const NUMERIC_FIELDS = ['trial_days', 'sms_cap', 'call_minutes_cap', 'voicemail_minutes_cap', 'forward_minutes_cap', 'max_locations'] as const;
type NumField = (typeof NUMERIC_FIELDS)[number];

/** The editable shape of a plan (strings for inputs). */
export interface PlanDraft {
  key: string; name: string; public: boolean; is_comped: boolean; sort: string; stripe_price_id: string; stripe_price_id_annual: string;
  nums: Record<NumField, string>; features: Record<string, boolean>;
}
export const draftOf = (p: PlanView | null, features: readonly string[]): PlanDraft => ({
  key: p?.key ?? '', name: p?.name ?? '', public: p?.public ?? false, is_comped: p?.is_comped ?? false, sort: String(p?.sort ?? 100),
  stripe_price_id: p?.stripe_price_id ?? '', stripe_price_id_annual: p?.stripe_price_id_annual ?? '',
  nums: Object.fromEntries(NUMERIC_FIELDS.map((f) => [f, p?.[f] === null || p?.[f] === undefined ? '' : String(p[f])])) as Record<NumField, string>,
  features: Object.fromEntries(features.map((f) => [f, p?.features?.[f] !== false])),
});

/** The API body of a draft (null = inherit the platform value); `errors` lists the fields that do not parse. Pure. */
export function bodyOf(d: PlanDraft): { body: Record<string, unknown>; errors: string[] } {
  const errors: string[] = [];
  const body: Record<string, unknown> = { name: d.name.trim(), public: d.public, is_comped: d.is_comped };
  for (const f of NUMERIC_FIELDS) {
    const v = d.nums[f].trim();
    if (v === '') body[f] = null;
    else if (/^\d+$/.test(v)) body[f] = Number(v);
    else errors.push(f);
  }
  if (/^\d+$/.test(d.sort.trim())) body.sort = Number(d.sort.trim()); else errors.push('sort');
  for (const f of ['stripe_price_id', 'stripe_price_id_annual'] as const) {
    const v = d[f].trim();
    if (v !== '' && !/^price_[A-Za-z0-9_]{4,80}$/.test(v)) errors.push(f);
    body[f] = v === '' ? null : v;
  }
  body.features = d.features;
  return { body, errors };
}

function priceText(p: PriceInfo | null | undefined, locale: string, t: ReturnType<typeof useT>): string {
  if (!p) return t('at.plans.priceUnknown');
  const amount = new Intl.NumberFormat(locale === 'es' ? 'es-US' : 'en-US', { style: 'currency', currency: p.currency, minimumFractionDigits: p.amount_cents % 100 === 0 ? 0 : 2 }).format(p.amount_cents / 100);
  return t(p.interval === 'month' ? 'at.plans.perMonth' : 'at.plans.perYear', { amount, count: p.interval_count });
}

export function PlansPage() {
  const t = useT();
  const locale = useLocale();
  const { can } = useAdmin();
  const list = useJson<Listing>('/api/admin/plans?archived=1');
  const prices = useJson<Prices>('/api/admin/plans/prices');
  const [editing, setEditing] = useState<string | null>(null); // plan key, or '' for new
  if (list.loading && !list.data) return <LoadingBlock />;
  if (list.error && !list.data) return <ErrorPanel error={list.error} onRetry={list.reload} />;
  if (!list.data) return null;
  const { plans, features } = list.data;
  const writer = can('plans.write');
  const done = () => { setEditing(null); list.reload(); prices.reload(); };
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={t('at.page.eyebrow')} title={t('at.plans.title')} subtitle={t('at.plans.sub')}
        right={writer && editing === null ? <Button onClick={() => setEditing('')}>{t('at.plans.new')}</Button> : undefined}
      />
      {!writer ? <p role="note" className="text-[13px] text-mute">{t('at.noPermission')}</p> : null}
      {editing !== null ? <PlanEditor key={editing} plan={plans.find((p) => p.key === editing) ?? null} features={features} onDone={done} onCancel={() => setEditing(null)} /> : null}
      {plans.length === 0 ? <EmptyStateInline title={t('at.plans.emptyTitle')} body={t('at.plans.emptyBody')} /> : (
        <ul className="grid gap-4 lg:grid-cols-2">
          {plans.map((p) => {
            const live = prices.data?.plans[p.key];
            return (
              <li key={p.key}>
                <Card className="h-full">
                  <CardHead
                    title={p.name} subtitle={p.key}
                    right={<span className="flex flex-wrap justify-end gap-1">
                      {p.is_comped ? <Badge tone="brand">{t('at.flag.comped')}</Badge> : null}
                      <Badge tone={p.public ? 'routine' : 'neutral'}>{t(p.public ? 'at.plans.public' : 'at.plans.hidden')}</Badge>
                      {p.archived_at ? <Badge tone="unsure">{t('at.plans.archived')}</Badge> : null}
                    </span>}
                  />
                  <div className="flex flex-col gap-3 p-5 text-[13px]">
                    <p className="text-soft">
                      {prices.loading && !prices.data ? t('common.loading') : [
                        p.stripe_price_id ? priceText(live?.monthly, locale, t) : t('at.plans.platformPrice', { price: priceText(prices.data?.platform.monthly, locale, t) }),
                        p.stripe_price_id_annual ? priceText(live?.annual, locale, t) : null,
                      ].filter(Boolean).join(' · ')}
                    </p>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                      <dt className="text-dim">{t('at.plans.trialDays')}</dt><dd className="text-right text-soft">{p.trial_days ?? t('at.planDefault')}</dd>
                      <dt className="text-dim">{t('at.plans.smsCap')}</dt><dd className="text-right text-soft">{p.sms_cap ?? t('at.planDefault')}</dd>
                      <dt className="text-dim">{t('at.plans.callCap')}</dt><dd className="text-right text-soft">{p.call_minutes_cap ?? t('at.planDefault')}</dd>
                      <dt className="text-dim">{t('at.plans.maxLocations')}</dt><dd className="text-right text-soft">{p.max_locations ?? t('at.plans.unlimited')}</dd>
                      <dt className="text-dim">{t('at.plans.businesses')}</dt><dd className="text-right text-soft">{p.businesses}</dd>
                    </dl>
                    <ul className="flex flex-wrap gap-1" aria-label={t('at.plans.features')}>
                      {features.map((f) => <li key={f}><Badge tone={p.features[f] === false ? 'neutral' : 'sky'}>{t(`at.feature.${f}` as MessageKey)}: {t(p.features[f] === false ? 'at.off' : 'at.on')}</Badge></li>)}
                    </ul>
                    {writer ? <div><Button variant="outline" onClick={() => setEditing(p.key)}>{t('at.plans.edit')}</Button></div> : null}
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function PlanEditor({ plan, features, onDone, onCancel }: { plan: PlanView | null; features: readonly string[]; onDone: () => void; onCancel: () => void }) {
  const t = useT();
  const { guard } = useAdmin();
  const [d, setD] = useState<PlanDraft>(() => draftOf(plan, features));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const isNew = plan === null;
  const { body, errors } = bodyOf(d);
  const keyOk = !isNew || /^[a-z0-9][a-z0-9_-]{0,59}$/.test(d.key);
  const ready = errors.length === 0 && keyOk && d.name.trim().length > 0 && confirmReady({ reasonRequired: true, reason, phrase: null, typed: '' });
  const num = (f: NumField, label: MessageKey, hint?: MessageKey) => (
    <TextField label={t(label)} hint={hint ? t(hint) : undefined} inputMode="numeric" value={d.nums[f]} error={errors.includes(f) ? t('at.billing.capInvalid') : null} onChange={(e) => setD({ ...d, nums: { ...d.nums, [f]: e.target.value } })} />
  );

  async function call<T>(fn: () => Promise<T>, msg: string) {
    setBusy(true); setError(null);
    try { await guard(async () => { await fn(); }); toast.success(msg); onDone(); } catch (err) { setError(err); } finally { setBusy(false); }
  }
  const save = () => call(() => (isNew
    ? apiRequest('/api/admin/plans', { method: 'POST', body: { key: d.key, ...body, reason: reason.trim() } })
    : apiRequest(`/api/admin/plans/${encodeURIComponent(plan.key)}`, { method: 'PATCH', body: { ...body, reason: reason.trim() } })), t('at.action.done'));
  const archive = () => call(() => apiRequest(`/api/admin/plans/${encodeURIComponent(plan!.key)}`, { method: 'PATCH', body: { archived: !plan!.archived_at, reason: reason.trim() } }), t('at.action.done'));
  const remove = () => call(() => apiRequest(`/api/admin/plans/${encodeURIComponent(plan!.key)}`, { method: 'DELETE', body: { reason: reason.trim() } }), t('at.action.done'));
  const reasonOk = reason.trim().length >= 8;

  return (
    <Card>
      <CardHead title={t(isNew ? 'at.plans.newTitle' : 'at.plans.editTitle', { name: plan?.name ?? '' })} />
      <form className="flex flex-col gap-5 p-5" onSubmit={(e) => { e.preventDefault(); if (ready && !busy) void save(); }} aria-label={t('at.plans.editor')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label={t('at.plans.key')} hint={t('at.plans.keyHint')} value={d.key} disabled={!isNew} onChange={(e) => setD({ ...d, key: e.target.value })} mono error={isNew && d.key !== '' && !keyOk ? t('at.plans.keyInvalid') : null} />
          <TextField label={t('at.plans.name')} value={d.name} maxLength={80} onChange={(e) => setD({ ...d, name: e.target.value })} />
          <TextField label={t('at.plans.priceMonthly')} hint={t('at.plans.priceHint')} mono value={d.stripe_price_id} error={errors.includes('stripe_price_id') ? t('at.plans.priceInvalid') : null} onChange={(e) => setD({ ...d, stripe_price_id: e.target.value })} />
          <TextField label={t('at.plans.priceAnnual')} mono value={d.stripe_price_id_annual} error={errors.includes('stripe_price_id_annual') ? t('at.plans.priceInvalid') : null} onChange={(e) => setD({ ...d, stripe_price_id_annual: e.target.value })} />
          {num('trial_days', 'at.plans.trialDays', 'at.plans.inheritHint')}
          {num('sms_cap', 'at.plans.smsCap', 'at.plans.inheritHint')}
          {num('call_minutes_cap', 'at.plans.callCap', 'at.plans.inheritHint')}
          {num('voicemail_minutes_cap', 'at.plans.voicemailCap', 'at.plans.inheritHint')}
          {num('forward_minutes_cap', 'at.plans.forwardCap', 'at.plans.inheritHint')}
          {num('max_locations', 'at.plans.maxLocations', 'at.plans.unlimitedHint')}
          <TextField label={t('at.plans.sort')} inputMode="numeric" value={d.sort} error={errors.includes('sort') ? t('at.billing.capInvalid') : null} onChange={(e) => setD({ ...d, sort: e.target.value })} />
        </div>
        <fieldset className="flex flex-wrap gap-x-6 gap-y-1">
          <legend className="mb-1 text-xs font-medium uppercase tracking-wider text-dim">{t('at.plans.flags')}</legend>
          <label className="flex min-h-11 items-center gap-2 text-[13px] text-soft"><input type="checkbox" className="h-4 w-4 accent-[#ff6b35]" checked={d.public} onChange={(e) => setD({ ...d, public: e.target.checked })} />{t('at.plans.public')}</label>
          <label className="flex min-h-11 items-center gap-2 text-[13px] text-soft"><input type="checkbox" className="h-4 w-4 accent-[#ff6b35]" checked={d.is_comped} onChange={(e) => setD({ ...d, is_comped: e.target.checked })} />{t('at.plans.comped')}</label>
        </fieldset>
        <fieldset className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
          <legend className="mb-1 text-xs font-medium uppercase tracking-wider text-dim">{t('at.plans.features')}</legend>
          {features.map((f) => (
            <label key={f} className="flex min-h-11 items-center gap-2 text-[13px] text-soft">
              <input type="checkbox" className="h-4 w-4 accent-[#ff6b35]" checked={d.features[f] !== false} onChange={(e) => setD({ ...d, features: { ...d.features, [f]: e.target.checked } })} />
              {t(`at.feature.${f}` as MessageKey)}
            </label>
          ))}
        </fieldset>
        <ConfirmFields reasonRequired phrase={null} reason={reason} onReason={setReason} typed="" onTyped={() => undefined} />
        {error ? <Problems error={error} /> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!ready || busy}>{busy ? t('common.loading') : t('at.plans.save')}</Button>
          <Button variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button>
          {!isNew ? <Button variant="outline" disabled={busy || !reasonOk} onClick={() => void archive()}>{t(plan.archived_at ? 'at.plans.unarchive' : 'at.plans.archive')}</Button> : null}
          {!isNew && plan.businesses === 0 && plan.key !== 'standard' ? <Button variant="danger" disabled={busy || !reasonOk} onClick={() => void remove()}>{t('at.plans.delete')}</Button> : null}
        </div>
      </form>
    </Card>
  );
}
