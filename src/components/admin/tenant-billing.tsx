'use client';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardHead } from '@/components/ui/card';
import { SelectField, TextField } from '@/components/ui/field';
import { apiRequest } from '@/hooks/use-api';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/core';
import { useAdmin } from './provider';
import { BILLING_STATUSES, dateInput, endOfDayIso, type PlanView, type TenantDetail } from './tenant-api';
import { ReasonAction } from './tenant-action';
import { useJson } from './use-json';
import { formatWhen } from './ui';

const capText = (v: string): number | null | undefined => (v.trim() === '' ? null : /^\d+$/.test(v.trim()) ? Number(v.trim()) : undefined);

/**
 * Billing and comp of one tenant: status, plan (from the plans table), trial / paid-through / comp expiry, per-business cap overrides. Replaces the raw
 * `curl POST /api/admin/billing`: the reason becomes the audit note, only CHANGED fields are sent, and Stripe ids are never touched.
 */
export function TenantBilling({ d, reload }: { d: TenantDetail; reload: () => void }) {
  const t = useT();
  const locale = useLocale();
  const { can } = useAdmin();
  const plans = useJson<{ plans: PlanView[] }>(can('plans.read') ? '/api/admin/plans?archived=1' : null);
  const b = d.billing;
  const [status, setStatus] = useState(b.status);
  const [plan, setPlan] = useState(b.plan ?? '');
  const [trial, setTrial] = useState(dateInput(b.trial_ends_at));
  const [period, setPeriod] = useState(dateInput(b.current_period_end));
  const [sms, setSms] = useState(b.sms_cap_override === null ? '' : String(b.sms_cap_override));
  const [calls, setCalls] = useState(b.call_minutes_cap_override === null ? '' : String(b.call_minutes_cap_override));
  const list = (plans.data?.plans ?? []).filter((p) => !p.archived_at || p.key === b.plan);
  const current = list.find((p) => p.key === (plan || b.plan));
  const smsV = capText(sms), callsV = capText(calls);
  const capsOk = smsV !== undefined && callsV !== undefined;

  const patch: Record<string, unknown> = {};
  if (status !== b.status) patch.billing_status = status;
  if (plan !== (b.plan ?? '')) patch.plan = plan === '' ? null : plan;
  if (trial !== dateInput(b.trial_ends_at)) patch.trial_ends_at = endOfDayIso(trial);
  if (period !== dateInput(b.current_period_end)) patch.current_period_end = endOfDayIso(period);
  if (smsV !== undefined && smsV !== b.sms_cap_override) patch.sms_cap_override = smsV;
  if (callsV !== undefined && callsV !== b.call_minutes_cap_override) patch.call_minutes_cap_override = callsV;
  const changed = Object.keys(patch).length > 0;
  const canEdit = can('tenants.billing');

  return (
    <Card>
      <CardHead title={t('at.billing.title')} subtitle={t('at.billing.sub')} right={b.plan_comped ? <Badge tone="brand">{t('at.flag.comped')}</Badge> : undefined} />
      <div className="flex flex-col gap-5 p-5">
        <dl className="grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2">
          <div><dt className="text-xs text-dim">{t('at.billing.stripeSub')}</dt><dd className="font-mono text-soft">{d.provider_ids.stripe_subscription_id ?? t('at.none')}</dd></div>
          <div><dt className="text-xs text-dim">{t('at.billing.interval')}</dt><dd className="text-soft">{b.interval ?? t('at.none')}</dd></div>
          <div><dt className="text-xs text-dim">{t('at.billing.pastDueSince')}</dt><dd className="text-soft">{b.past_due_since ? formatWhen(b.past_due_since, locale) : t('at.none')}</dd></div>
        </dl>
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => e.preventDefault()} aria-label={t('at.billing.title')}>
          <SelectField label={t('at.billing.status')} value={status} onChange={(e) => setStatus(e.target.value)} disabled={!canEdit}>
            {BILLING_STATUSES.map((s) => <option key={s} value={s}>{t(`at.billing.${s}` as MessageKey)}</option>)}
          </SelectField>
          <SelectField label={t('at.billing.plan')} value={plan} onChange={(e) => setPlan(e.target.value)} disabled={!canEdit || plans.loading} hint={current ? t('at.billing.planHint', { sms: current.sms_cap ?? t('at.planDefault'), calls: current.call_minutes_cap ?? t('at.planDefault') }) : undefined}>
            <option value="">{t('at.billing.noPlan')}</option>
            {b.plan && !list.some((p) => p.key === b.plan) ? <option value={b.plan}>{b.plan}</option> : null}
            {list.map((p) => <option key={p.key} value={p.key}>{p.name}{p.is_comped ? ` (${t('at.flag.comped')})` : ''}</option>)}
          </SelectField>
          <TextField type="date" label={t('at.billing.trialEnds')} value={trial} onChange={(e) => setTrial(e.target.value)} disabled={!canEdit} />
          <TextField type="date" label={t('at.billing.periodEnd')} hint={t('at.billing.periodEndHint')} value={period} onChange={(e) => setPeriod(e.target.value)} disabled={!canEdit} />
          <TextField label={t('at.billing.smsCap')} hint={t('at.billing.capHint')} inputMode="numeric" value={sms} onChange={(e) => setSms(e.target.value)} disabled={!canEdit} error={smsV === undefined ? t('at.billing.capInvalid') : null} />
          <TextField label={t('at.billing.callCap')} hint={t('at.billing.capHint')} inputMode="numeric" value={calls} onChange={(e) => setCalls(e.target.value)} disabled={!canEdit} error={callsV === undefined ? t('at.billing.capInvalid') : null} />
        </form>
        <p className="text-xs text-dim">{t('at.billing.stripeNote')}</p>
        {canEdit ? (
          <ReasonAction
            label={t('at.billing.save')} variant="primary" disabled={!changed || !capsOk} ready={changed && capsOk} description={t('at.billing.saveHint')}
            run={(reason) => apiRequest('/api/admin/billing', { method: 'POST', body: { business_id: d.id, ...patch, note: reason.slice(0, 300) } })}
            onDone={reload}
          />
        ) : <p className="text-[13px] text-mute">{t('at.noPermission')}</p>}
      </div>
    </Card>
  );
}
