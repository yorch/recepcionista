import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { Sidebar } from '@/components/dashboard/shell';
import { BillingBanner } from '@/components/dashboard/billing-banner';
import { OnboardingReturn } from '@/components/dashboard/onboarding-return';
import { getDashboardContext } from '@/lib/dashboard-context';
import { hasRole } from '@/lib/session';
import { resolveCallRoute } from '@/lib/voice/call-mode';

/** Signed-in pages are never indexed. */
export const metadata: Metadata = { robots: { index: false, follow: false } };

export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Validates the session against the database (the proxy only checks that a cookie exists).
  const ctx = await getDashboardContext();
  const { business: biz } = ctx;
  const isOwner = hasRole(ctx.principal, 'owner');
  const live = biz.status === 'live' && Boolean(biz.phone);
  const route = resolveCallRoute(biz).action;
  const statusText = route === 'paused' ? 'Paused' : route === 'forward' ? 'Forwarding calls' : 'Answering calls';

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <Sidebar
        businessName={biz.name}
        phone={biz.phone}
        live={live}
        statusText={statusText}
        who={ctx.who}
        role={ctx.role}
        isAdmin={ctx.role === 'admin'}
        isOwner={isOwner}
        currentBusinessId={biz.id}
        businesses={ctx.role === 'admin' ? ctx.businesses.map((b) => ({ id: b.id, name: b.name })) : []}
      />
      <div className="min-w-0 flex-1">
        <Suspense fallback={null}><OnboardingReturn unprovisioned={!live && isOwner} /></Suspense>
        {ctx.principal.kind === 'user' && !ctx.principal.email_verified ? (
          <div role="status" className="border-b border-warn-line bg-warn-bg px-4 py-3 text-[13px] text-warn sm:px-6">
            Confirm your email address ({ctx.who}) to start your plan and turn on your receptionist. We sent you a link.{' '}
            <Link href="/verify-email-sent" className="font-semibold underline underline-offset-2">Send it again</Link>
          </div>
        ) : null}
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
