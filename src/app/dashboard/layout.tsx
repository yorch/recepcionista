import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { Sidebar } from '@/components/dashboard/shell';
import { BillingBanner } from '@/components/dashboard/billing-banner';
import { OnboardingReturn } from '@/components/dashboard/onboarding-return';
import { getT } from '@/lib/i18n/server';
import { getDashboardContext } from '@/lib/dashboard-context';
import { hasRole } from '@/lib/session';
import { resolveCallRoute } from '@/lib/voice/call-mode';

/** Signed-in pages are never indexed. */
export const metadata: Metadata = { robots: { index: false, follow: false } };

export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Validates the session against the database (the proxy only checks that a cookie exists).
  const t = await getT();
  const ctx = await getDashboardContext();
  const { business: biz } = ctx;
  const isOwner = hasRole(ctx.principal, 'owner');
  const live = biz.status === 'live' && Boolean(biz.phone);
  const route = resolveCallRoute(biz).action;

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <Sidebar
        businessName={biz.name}
        phone={biz.phone}
        live={live}
        status={route === 'paused' ? 'paused' : route === 'forward' ? 'forward' : 'ai'}
        who={ctx.who}
        role={ctx.role}
        isAdmin={ctx.role === 'admin'}
        isOwner={isOwner}
        currentBusinessId={biz.id}
        businesses={ctx.role === 'admin' ? ctx.businesses.map((b) => ({ id: b.id, name: b.name })) : []}
        memberships={ctx.memberships.map((m) => ({ business_id: m.business_id, business_name: m.business_name, role: m.role }))}
        canAddBusiness={ctx.canAddBusiness && ctx.principal.email_verified}
      />
      <div className="min-w-0 flex-1">
        <Suspense fallback={null}><OnboardingReturn unprovisioned={!live && isOwner} /></Suspense>
        {ctx.principal.kind === 'user' && !ctx.principal.email_verified ? (
          <div role="status" className="border-b border-warn-line bg-warn-bg px-4 py-3 text-[13px] text-warn sm:px-6">
            {t('shell.verifyBanner', { email: ctx.who })}{' '}
            <Link href="/verify-email-sent" className="font-semibold underline underline-offset-2">{t('shell.verifyBannerResend')}</Link>
          </div>
        ) : null}
        <BillingBanner business={biz} canManage={isOwner} />
        {!live && isOwner ? (
          <div role="status" className="border-b border-warn-line bg-warn-bg px-4 py-3 text-[13px] text-warn sm:px-6">
            {t('shell.notAnswering')}{' '}
            <Link href="/onboarding" className="font-semibold underline underline-offset-2">{t('shell.finishSetup')}</Link>
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}
