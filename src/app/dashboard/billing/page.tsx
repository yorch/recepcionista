import type { Metadata } from 'next';
import { getDashboardContext, requireRolePage } from '@/lib/dashboard-context';
import { Card, CardHead } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { billingSummary } from '@/lib/billing/summary';
import { daysLeft } from '@/lib/billing/banner-state';
import { getLocale, getT } from '@/lib/i18n/server';
import { formatNumber, intlTag, type Locale } from '@/lib/i18n/core';
import type { TFunction } from '@/lib/i18n/core';
import { BillingActions } from './billing-actions';
import { planPriceDisplay, planPriceDisplayAnnual } from '@/app/site-config';
import { planCapLines, planPriceTexts } from '@/lib/billing/price';
import type { BillingStatus } from '@/lib/types';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('bill.metaTitle') };
}

export const dynamic = 'force-dynamic';

const TONE: Record<BillingStatus, string> = {
  none: 'neutral', trialing: 'sky', active: 'routine', past_due: 'unsure', canceled: 'emergency', unpaid: 'emergency',
};


const fmtDate = (iso: string | null, tz: string, locale: Locale) =>
  iso ? new Intl.DateTimeFormat(intlTag(locale), { dateStyle: 'medium', timeZone: tz }).format(new Date(iso)) : null;

function Meter({ label, used, cap, unit, t, locale }: { label: string; used: number; cap: number; unit: string; t: TFunction; locale: Locale }) {
  const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 100;
  const over = used >= cap;
  const near = !over && pct >= 80;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="font-medium text-white">{label}</span>
        <span className="tabular-nums text-[#9fb0c5]">
          {t('bill.usage.of', { used: formatNumber(locale, used), cap: formatNumber(locale, cap), unit })}
        </span>
      </div>
      <div
        role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={cap} aria-valuenow={Math.min(used, cap)}
        aria-valuetext={t('bill.usage.valueText', { used, cap, unit, over: over ? t('bill.usage.overText') : '' })}
        className="mt-2 h-2 overflow-hidden rounded-full bg-[#1b232e]"
      >
        <div
          className={`h-full rounded-full ${over ? 'bg-[#ff9b86]' : near ? 'bg-[#f2c86b]' : 'bg-[#6ee7b0]'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {over ? <p className="mt-1 text-[11px] text-[#ff9b86]">{t('bill.usage.limitReached')}</p> : null}
    </div>
  );
}

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ checkout?: string }> }) {
  const t = await getT();
  const locale = await getLocale();
  const ctx = await getDashboardContext();
  requireRolePage(ctx, 'owner');
  const biz = ctx.business;
  const sp = await searchParams;
  const now = new Date();
  const s = await billingSummary(biz, now);
  const tz = biz.timezone ?? 'America/New_York';
  const trialDays = s.billing_status === 'trialing' ? daysLeft(s.trial_ends_at, now) : null;
  const canStart = s.billing_status === 'none' || s.billing_status === 'canceled';
  const canManage = s.has_customer && !canStart;
  const trialEnd = fmtDate(s.trial_ends_at, tz, locale);
  const periodEnd = fmtDate(s.current_period_end, tz, locale);
  const graceEnd = fmtDate(s.grace_ends_at, tz, locale);
  // The price shown is Stripe's own (cached, fail-soft to the operator's display text); the caps are the ones the metering enforces.
  const prices = await planPriceTexts(locale, { monthly: planPriceDisplay(locale), annual: planPriceDisplayAnnual(locale) });
  const capLines = planCapLines(locale);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <header>
        <h1 className="text-[24px] font-semibold tracking-[-0.02em]">{t('bill.title')}</h1>
        <p className="mt-1 text-[13px] text-[#8b98ab]">{t('bill.subtitle', { business: biz.name })}</p>
      </header>

      {sp.checkout === 'success' ? (
        <p role="status" className="mt-4 rounded-xl border border-[#1c4635] bg-[#10291f] px-4 py-3 text-[13px] text-[#6ee7b0]">
          {t('bill.checkoutSuccess')}
        </p>
      ) : null}
      {sp.checkout === 'cancel' ? (
        <p role="status" className="mt-4 rounded-xl border border-[#2a3546] bg-[#141c26] px-4 py-3 text-[13px] text-[#cbd7e6]">
          {t('bill.checkoutCancel')}
        </p>
      ) : null}

      <Card className="mt-6">
        <CardHead
          title={t('bill.plan')}
          subtitle={s.plan ? t('bill.planName', { plan: s.plan }) : undefined}
          right={<Badge tone={TONE[s.billing_status]}>{t(`bill.status.${s.billing_status}` as const)}</Badge>}
        />
        <div className="space-y-3 p-5 text-[13px] leading-relaxed text-[#cbd7e6]">
          <p>{t(`bill.explain.${s.billing_status}` as const)}</p>
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-[#6b7b91]">{t('bill.includes')}</p>
            {s.billing_status === 'none' || s.billing_status === 'canceled' ? <p className="mt-1 text-white">{prices.monthly}{prices.annual ? ` · ${prices.annual}` : ''}</p> : null}
            <ul className="mt-1.5 space-y-1">
              {capLines.map((l) => <li key={l} className="flex gap-2"><span aria-hidden="true" className="text-[#6ee7b0]">✓</span>{l}</li>)}
            </ul>
          </div>
          {trialDays !== null && trialEnd ? (
            <p>
              <strong className="text-white">{trialDays === 0 ? t('bill.endsToday') : t('bill.daysLeft', { count: trialDays })}</strong>
              {' '}{t('bill.trialEnds', { date: trialEnd })}
            </p>
          ) : null}
          {s.billing_status === 'active' && periodEnd ? (
            <p>{s.cancel_at_period_end ? t('bill.cancelsOn', { date: periodEnd }) : t('bill.renewsOn', { date: periodEnd })}</p>
          ) : null}
          {s.billing_status === 'trialing' && s.cancel_at_period_end ? <p>{t('bill.cancelAtTrialEnd')}</p> : null}
          {s.billing_status === 'past_due' && graceEnd ? <p>{t('bill.pausesOn', { date: graceEnd })}</p> : null}
          {s.billing_status !== 'none' && s.billing_status !== 'canceled' ? (
            <p>{s.billing_interval === 'year' ? t('bill.billedYearly') : t('bill.billedMonthly')}
              {s.annual_available && s.billing_interval === 'month' && s.has_customer ? t('bill.switchAnnual') : ''}
              {s.billing_interval === 'year' && s.has_customer ? t('bill.backMonthly') : ''}
            </p>
          ) : null}
          {s.usage_warnings.length > 0 ? (
            <ul aria-label={t('bill.warnings')} className="space-y-1 text-[#f2c86b]">
              {s.usage_warnings.map((w) => (
                <li key={`${w.kind}-${w.level}`}>{t('bill.warn.line', { state: w.level === 100 ? t('bill.warn.limit') : t('bill.warn.near'), label: t(`banner.usage.label.${w.kind}` as const), used: formatNumber(locale, w.used), cap: formatNumber(locale, w.cap), unit: t(w.unit === 'texts' ? 'banner.usage.unit.texts' : 'banner.usage.unit.minutes') })}</li>
              ))}
            </ul>
          ) : null}
          {!s.enforced && s.billing_status === 'none' ? (
            <p className="text-[#8b98ab]">{t('bill.notEnforced')}</p>
          ) : null}
          <div className="pt-1">
            {canStart ? <BillingActions businessId={biz.id} mode="start" annualAvailable={s.annual_available} monthlyLabel={prices.monthly} annualLabel={prices.annual} /> : null}
            {canManage ? <BillingActions businessId={biz.id} mode="manage" /> : null}
          </div>
        </div>
      </Card>

      <Card className="mt-6">
        <CardHead title={t('bill.usage.title')} subtitle={s.usage.period_start ? t('bill.usage.since', { date: s.usage.period_start }) : undefined} />
        <div className="space-y-5 p-5">
          <Meter t={t} locale={locale} label={t('bill.usage.sms')} used={s.usage.sms.used} cap={s.usage.sms.cap} unit={t('bill.usage.unit.segments')} />
          <Meter t={t} locale={locale} label={t('bill.usage.call')} used={s.usage.call_minutes.used} cap={s.usage.call_minutes.cap} unit={t('bill.usage.unit.minutes')} />
          <Meter t={t} locale={locale} label={t('bill.usage.forward')} used={s.usage.forward_minutes.used} cap={s.usage.forward_minutes.cap} unit={t('bill.usage.unit.minutes')} />
          <Meter t={t} locale={locale} label={t('bill.usage.voicemail')} used={s.usage.voicemail_minutes.used} cap={s.usage.voicemail_minutes.cap} unit={t('bill.usage.unit.minutes')} />
          <p className="text-[11px] text-[#6b7b91]">
            {t('bill.usage.note1')}
          </p>
          <p className="text-[11px] text-[#6b7b91]">
            {t('bill.usage.note2')}
            {s.billing_status === 'trialing' ? t('bill.usage.trialLower') : ''}
          </p>
          <p className="text-[11px] text-[#6b7b91]">{t('bill.usage.reset', { tz })}</p>
        </div>
      </Card>
    </main>
  );
}
