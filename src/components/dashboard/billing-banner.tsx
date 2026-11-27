import { configEnv } from '@/lib/config';
import Link from 'next/link';
import { getLocale, getT } from '@/lib/i18n/server';
import { getUsage, callMinutesCapFor, smsCapFor } from '@/lib/db';
import { bannerFor, type BannerTone } from '@/lib/billing/banner-state';
import { usageWarningsFor } from '@/lib/billing/warnings';
import type { Business } from '@/lib/types';
import { cn } from '@/components/ui/cn';

const tones: Record<BannerTone, string> = {
  info: 'border-[#17445a] bg-[#0d2a35] text-[#bfeaf8]',
  warning: 'border-[#473817] bg-[#2e2410] text-[#f7dc9b]',
  danger: 'border-[#5a221c] bg-[#3a1512] text-[#ffc2b3]',
};

/**
 * Server component. Renders nothing when there is nothing to say (legacy/demo tenants, healthy plans).
 *
 *   <BillingBanner business={ctx.business} canManage={hasRole(ctx.principal, 'owner')} />
 *
 * `business`: the tenant being viewed (needs the billing fields of getBusiness()).
 * `canManage`: true for owner/admin (shows the call to action linking to /dashboard/billing); false for staff
 * (the message tells them to ask the owner). Usage for the over-cap case is loaded here.
 */
export async function BillingBanner({ business, canManage }: { business: Business; canManage: boolean }) {
  const t = await getT();
  const locale = await getLocale();
  let usage = null;
  const status = business.billing_status ?? 'none';
  if (status === 'trialing' || status === 'active') {
    try {
      const u = await getUsage(business.id);
      if (u) usage = { sms_count: u.sms_count, call_seconds: u.call_seconds, sms_cap: smsCapFor(business), call_minutes_cap: callMinutesCapFor(business) };
    } catch {
      usage = null; // a usage lookup failure must never break the dashboard
    }
  }
  let banner = bannerFor(business, usage, canManage, new Date(), configEnv(), locale);
  if (!banner && (status === 'trialing' || status === 'active')) {
    // No billing problem: say when a monthly allowance is nearly or fully used (the owner was also emailed / texted once).
    const warnings = await usageWarningsFor(business.id);
    const worst = warnings.sort((a, b) => b.percent - a.percent)[0];
    if (worst) {
      const label = t(`banner.usage.label.${worst.kind}` as const);
      banner = {
        kind: 'over_cap', tone: worst.level === 100 ? 'danger' : 'warning',
        title: worst.level === 100 ? t('banner.usage.allUsed', { label }) : t('banner.usage.percentUsed', { percent: worst.percent, label }),
        message: t('banner.usage.of', { used: worst.used, cap: worst.cap, unit: t(worst.unit === 'texts' ? 'banner.usage.unit.texts' : 'banner.usage.unit.minutes') }) + (worst.level === 100 ? t('banner.usage.limitApplies') : ''),
        cta: canManage ? t('banner.usage.cta') : null,
      };
    }
  }
  if (!banner) return null;
  const urgent = banner.tone === 'danger';
  return (
    <div
      role={urgent ? 'alert' : 'status'}
      className={cn('flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-4 py-3 text-[13px] sm:px-6', tones[banner.tone])}
    >
      <p className="min-w-0 flex-1 basis-64 leading-snug">
        <strong className="font-semibold">{banner.title}.</strong> {banner.message}
      </p>
      {banner.cta ? (
        <Link
          href="/dashboard/billing"
          className="inline-flex min-h-10 shrink-0 items-center rounded-xl border border-current px-3 py-2 text-[13px] font-medium hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {banner.cta}
        </Link>
      ) : null}
    </div>
  );
}
