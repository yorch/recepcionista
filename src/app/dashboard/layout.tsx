import { redirect } from 'next/navigation';
import { listBusinesses } from '@/lib/db';
import { Sidebar } from '@/components/dashboard/shell';

export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const businesses = await listBusinesses();
  const biz = businesses[0];
  if (!biz) redirect('/onboarding');

  return (
    <div className="flex min-h-screen">
      <Sidebar businessName={biz.name} phone={biz.phone} live={biz.status === 'live'} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
