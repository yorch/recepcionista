import { Sidebar } from '@/components/dashboard/shell';
import { getDashboardContext } from '@/lib/dashboard-context';
import { hasRole } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Validates the session against the database (the proxy only checks that a cookie exists).
  const ctx = await getDashboardContext();
  const { business: biz } = ctx;

  return (
    <div className="flex min-h-screen">
      <Sidebar
        businessName={biz.name}
        phone={biz.phone}
        live={biz.status === 'live'}
        who={ctx.who}
        role={ctx.role}
        isAdmin={ctx.role === 'admin'}
        canSettings={hasRole(ctx.principal, 'owner')}
        currentBusinessId={biz.id}
        businesses={ctx.role === 'admin' ? ctx.businesses.map((b) => ({ id: b.id, name: b.name })) : []}
      />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
