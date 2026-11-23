import { getDashboardContext, requireRolePage } from '@/lib/dashboard-context';
import { Card, CardHead } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { billingSummary } from '@/lib/billing/summary';
import { daysLeft } from '@/lib/billing/banner-state';
import { BillingActions } from './billing-actions';
import type { BillingStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

const LABEL: Record<BillingStatus, string> = {
  none: 'No plan', trialing: 'Free trial', active: 'Active', past_due: 'Payment failed', canceled: 'Canceled', unpaid: 'On hold',
};
const TONE: Record<BillingStatus, string> = {
  none: 'neutral', trialing: 'sky', active: 'routine', past_due: 'unsure', canceled: 'emergency', unpaid: 'emergency',
};

const EXPLAIN: Record<BillingStatus, string> = {
  none: 'Add a card to start your free trial. You will not be charged until the trial ends, and you can cancel before then.',
  trialing: 'Your free trial is running. Your card is charged when it ends unless you cancel first.',
  active: 'Your subscription is active.',
  past_due: 'We could not charge your card. Service continues for a few days; update your payment method to avoid an interruption.',
  canceled: 'Your subscription is canceled, so your receptionist is paused. Resubscribe to turn it back on.',
  unpaid: 'Payment could not be collected and your plan is on hold. Update your payment method to resume service.',
};

const fmtDate = (iso: string | null, tz: string) =>
  iso ? new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: tz }).format(new Date(iso)) : null;

function Meter({ label, used, cap, unit }: { label: string; used: number; cap: number; unit: string }) {
  const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 100;
  const over = used >= cap;
  const near = !over && pct >= 80;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="font-medium text-white">{label}</span>
        <span className="tabular-nums text-[#9fb0c5]">
          {used.toLocaleString('en-US')} of {cap.toLocaleString('en-US')} {unit}
        </span>
      </div>
      <div
        role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={cap} aria-valuenow={Math.min(used, cap)}
        aria-valuetext={`${used} of ${cap} ${unit} used${over ? ', limit reached' : ''}`}
        className="mt-2 h-2 overflow-hidden rounded-full bg-[#1b232e]"
      >
        <div
          className={`h-full rounded-full ${over ? 'bg-[#ff9b86]' : near ? 'bg-[#f2c86b]' : 'bg-[#6ee7b0]'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {over ? <p className="mt-1 text-[11px] text-[#ff9b86]">Limit reached for this month.</p> : null}
    </div>
  );
}

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ checkout?: string }> }) {
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
  const trialEnd = fmtDate(s.trial_ends_at, tz);
  const periodEnd = fmtDate(s.current_period_end, tz);
  const graceEnd = fmtDate(s.grace_ends_at, tz);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <header>
        <h1 className="text-[24px] font-semibold tracking-[-0.02em]">Billing</h1>
        <p className="mt-1 text-[13px] text-[#8b98ab]">Your plan, free trial and monthly usage for {biz.name}.</p>
      </header>

      {sp.checkout === 'success' ? (
        <p role="status" className="mt-4 rounded-xl border border-[#1c4635] bg-[#10291f] px-4 py-3 text-[13px] text-[#6ee7b0]">
          Thanks. Your plan can take a few seconds to show up here; refresh if it still says no plan.
        </p>
      ) : null}
      {sp.checkout === 'cancel' ? (
        <p role="status" className="mt-4 rounded-xl border border-[#2a3546] bg-[#141c26] px-4 py-3 text-[13px] text-[#cbd7e6]">
          Checkout was canceled. Nothing was charged.
        </p>
      ) : null}

      <Card className="mt-6">
        <CardHead
          title="Plan"
          subtitle={s.plan ? `Plan: ${s.plan}` : undefined}
          right={<Badge tone={TONE[s.billing_status]}>{LABEL[s.billing_status]}</Badge>}
        />
        <div className="space-y-3 p-5 text-[13px] leading-relaxed text-[#cbd7e6]">
          <p>{EXPLAIN[s.billing_status]}</p>
          {trialDays !== null && trialEnd ? (
            <p>
              <strong className="text-white">{trialDays === 0 ? 'Ends today' : `${trialDays} day${trialDays === 1 ? '' : 's'} left`}</strong>
              {' '}(trial ends {trialEnd}).
            </p>
          ) : null}
          {s.billing_status === 'active' && periodEnd ? (
            <p>{s.cancel_at_period_end ? `Cancels on ${periodEnd}; service stops then.` : `Renews on ${periodEnd}.`}</p>
          ) : null}
          {s.billing_status === 'trialing' && s.cancel_at_period_end ? <p>Set to cancel when the trial ends.</p> : null}
          {s.billing_status === 'past_due' && graceEnd ? <p>Service pauses on {graceEnd} unless the payment goes through.</p> : null}
          {!s.enforced && s.billing_status === 'none' ? (
            <p className="text-[#8b98ab]">Plans are not enforced on this installation yet, so nothing is paused.</p>
          ) : null}
          <div className="pt-1">
            {canStart ? <BillingActions businessId={biz.id} mode="start" /> : null}
            {canManage ? <BillingActions businessId={biz.id} mode="manage" /> : null}
          </div>
        </div>
      </Card>

      <Card className="mt-6">
        <CardHead title="Usage this month" subtitle={s.usage.period_start ? `Since ${s.usage.period_start}` : undefined} />
        <div className="space-y-5 p-5">
          <Meter label="Text messages" used={s.usage.sms.used} cap={s.usage.sms.cap} unit="texts" />
          <Meter label="Call minutes" used={s.usage.call_minutes.used} cap={s.usage.call_minutes.cap} unit="minutes" />
          <p className="text-[11px] text-[#6b7b91]">Counts reset on the first of each month in your time zone ({tz}).</p>
        </div>
      </Card>
    </main>
  );
}
