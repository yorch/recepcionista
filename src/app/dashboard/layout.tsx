import Link from 'next/link';
import { Suspense } from 'react';
import { Sidebar } from '@/components/dashboard/shell';
import { BillingBanner } from '@/components/dashboard/billing-banner';
import { OnboardingReturn } from '@/components/dashboard/onboarding-return';
import { getDashboardContext } from '@/lib/dashboard-context';
import { hasRole } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Validates the session against the database (the proxy only checks that a cookie exists).
  const ctx = await getDashboardContext();
  const { business: biz } = ctx;
  const isOwner = hasRole(ctx.principal, 'owner');
  const live = biz.status === 'live' && Boolean(biz.phone);

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <Sidebar
        businessName={biz.name}
        phone={biz.phone}
        live={live}
        who={ctx.who}
        role={ctx.role}
        isAdmin={ctx.role === 'admin'}
        isOwner={isOwner}
        currentBusinessId={biz.id}
        businesses={ctx.role === 'admin' ? ctx.businesses.map((b) => ({ id: b.id, name: b.name })) : []}
      />
      <div className="min-w-0 flex-1">
        <Suspense fallback={null}><OnboardingReturn unprovisioned={!live && isOwner} /></Suspense>
        <BillingBanner business={biz} canManage={isOwner} />
        {!live && isOwner ? (
          <div role="status" className="border-b border-warn-line bg-warn-bg px-4 py-3 text-[13px] text-warn sm:px-6">
            Your receptionist is not answering calls yet.{' '}
            <Link href="/onboarding" className="font-semibold underline underline-offset-2">Finish setup</Link>
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}
