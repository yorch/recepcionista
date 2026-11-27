'use client';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardHead } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/core';
import { TenantAudit } from './tenant-audit';
import { TenantBilling } from './tenant-billing';
import { TenantOps } from './tenant-ops';
import { TenantOverrides } from './tenant-overrides';
import { TenantSupport } from './tenant-support';
import { minutesOf, type TenantDetail } from './tenant-api';
import { useJson } from './use-json';
import { useNow } from './tenant-support';
import { ErrorPanel, formatWhen, LoadingBlock } from './ui';

const TABS = ['overview', 'billing', 'status', 'overrides', 'support', 'audit'] as const;
type Tab = (typeof TABS)[number];

function Fact({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-dim">{label}</dt>
      <dd className={`break-words text-[13px] text-soft ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  );
}

function Overview({ d }: { d: TenantDetail }) {
  const t = useT();
  const locale = useLocale();
  const none = t('at.none');
  const u = d.usage;
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHead title={t('at.profile.title')} />
        <dl className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
          <Fact label={t('at.profile.id')} value={d.id} mono />
          <Fact label={t('at.profile.created')} value={formatWhen(d.created_at, locale)} />
          <Fact label={t('at.profile.timezone')} value={d.timezone ?? none} />
          <Fact label={t('at.profile.vertical')} value={d.vertical ?? none} />
          <Fact label={t('at.profile.language')} value={d.locale_default ?? none} />
          <Fact label={t('at.profile.callMode')} value={d.call_mode ?? none} />
          <Fact label={t('at.profile.phone')} value={d.contact.phone ?? none} mono />
          <Fact label={t('at.profile.ownerName')} value={d.contact.owner_name ?? none} />
          <Fact label={t('at.profile.ownerPhone')} value={<>{d.contact.owner_phone ?? none} {d.contact.owner_phone ? <Badge tone={d.contact.owner_phone_verified ? 'routine' : 'unsure'}>{t(d.contact.owner_phone_verified ? 'at.profile.verified' : 'at.profile.unverified')}</Badge> : null}</>} />
        </dl>
      </Card>
      <Card>
        <CardHead title={t('at.provider.title')} subtitle={t('at.provider.sub')} />
        <dl className="grid gap-4 p-5 sm:grid-cols-2">
          <Fact label={t('at.provider.agent')} value={d.provider_ids.agent_id ?? none} mono />
          <Fact label={t('at.provider.elNumber')} value={d.provider_ids.elevenlabs_phone_number_id ?? none} mono />
          <Fact label={t('at.provider.twilioSid')} value={d.provider_ids.twilio_phone_sid ?? none} mono />
          <Fact label={t('at.provider.stripeCustomer')} value={d.provider_ids.stripe_customer_id ?? none} mono />
          <Fact label={t('at.provider.stripeSub')} value={d.provider_ids.stripe_subscription_id ?? none} mono />
        </dl>
      </Card>
      <Card>
        <CardHead title={t('at.usage.title')} subtitle={u ? t('at.usage.period', { date: u.period_start }) : undefined} />
        {u ? (
          <dl className="grid gap-4 p-5 sm:grid-cols-4">
            <Fact label={t('at.col.sms')} value={u.sms_count} />
            <Fact label={t('at.col.calls')} value={minutesOf(u.call_seconds)} />
            <Fact label={t('at.col.forward')} value={minutesOf(u.forward_seconds)} />
            <Fact label={t('at.col.voicemail')} value={minutesOf(u.voicemail_seconds)} />
          </dl>
        ) : <p className="p-5 text-[13px] text-mute">{t('at.usage.none')}</p>}
      </Card>
      <Card>
        <CardHead title={t('at.closed.title')} subtitle={t('at.closed.sub')} />
        <div className="p-5">
          {d.closed_dates.length === 0 ? <p className="text-[13px] text-mute">{t('at.closed.none')}</p> : (
            <ul className="flex flex-wrap gap-2">{d.closed_dates.map((x) => <li key={x}><Badge>{x}</Badge></li>)}</ul>
          )}
        </div>
      </Card>
      <Card>
        <CardHead title={t('at.users.title')} />
        <ul className="divide-y divide-line">
          {d.users.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-[13px]">
              <span className="min-w-0 truncate text-soft">{x.email}</span>
              <span className="flex gap-1"><Badge>{x.role}</Badge>{x.disabled ? <Badge tone="emergency">{t('at.users.disabled')}</Badge> : null}{x.two_factor ? <Badge tone="routine">{t('at.users.twoFactor')}</Badge> : null}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

export function TenantDetailPage({ id }: { id: string }) {
  const t = useT();
  const locale = useLocale();
  const { data, error, loading, reload } = useJson<TenantDetail>(`/api/admin/tenants/${encodeURIComponent(id)}`);
  const now = useNow(15_000);
  const [tab, setTab] = useState<Tab>('overview');
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  if (loading && !data) return <LoadingBlock />;
  if (error && !data) return <ErrorPanel error={error} onRetry={reload} />;
  if (!data) return null;
  const d = data;
  const grantOpen = d.support_grants.some((g) => g.ended_at === null && new Date(g.expires_at).getTime() > (now ?? 0));

  function onKey(e: React.KeyboardEvent, i: number) {
    const next = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    setTab(TABS[next]);
    refs.current[TABS[next]]?.focus();
  }

  return (
    <div className="flex flex-col gap-6">
      <nav aria-label={t('at.detail.breadcrumb')} className="text-[13px]"><Link href="/admin/tenants" className="text-brand-soft hover:underline">{t('at.tenants.title')}</Link></nav>
      <PageHeader
        eyebrow={t('at.page.eyebrow')} title={d.name} subtitle={t('at.detail.sub', { when: formatWhen(d.created_at, locale) })}
        right={<span className="flex flex-wrap gap-1"><Badge tone={d.status === 'live' ? 'routine' : 'neutral'}>{t(`at.status.${d.status}` as MessageKey)}</Badge><Badge>{t(`at.billing.${d.billing.status}` as MessageKey)}</Badge>{d.suspension.suspended ? <Badge tone="emergency">{t('at.flag.suspended')}</Badge> : null}{d.billing.plan_comped ? <Badge tone="brand">{t('at.flag.comped')}</Badge> : null}</span>}
      />
      <div role="tablist" aria-label={t('at.detail.tabs')} className="flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((x, i) => (
          <button
            key={x} ref={(el) => { refs.current[x] = el; }} role="tab" id={`tab-${x}`} aria-selected={tab === x} aria-controls={`panel-${x}`} tabIndex={tab === x ? 0 : -1}
            onClick={() => setTab(x)} onKeyDown={(e) => onKey(e, i)}
            className={`min-h-11 shrink-0 border-b-2 px-4 text-[13px] font-medium ${tab === x ? 'border-brand text-white' : 'border-transparent text-mute hover:text-soft'}`}
          >{t(`at.tab.${x}` as MessageKey)}</button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={0} className="outline-none">
        {tab === 'overview' ? <Overview d={d} /> : null}
        {tab === 'billing' ? <TenantBilling d={d} reload={reload} /> : null}
        {tab === 'status' ? <TenantOps d={d} reload={reload} /> : null}
        {tab === 'overrides' ? <TenantOverrides knobs={d.overrides} businessId={d.id} locale={locale} reload={reload} grantOpen={grantOpen} /> : null}
        {tab === 'support' ? <TenantSupport d={d} reload={reload} /> : null}
        {tab === 'audit' ? <TenantAudit businessId={d.id} /> : null}
      </div>
    </div>
  );
}
