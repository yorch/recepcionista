import type { Metadata } from 'next';
import { InstancesPage } from '@/components/admin/ops-instances';
import { requireAdminPage } from '@/lib/admin-ui/server';
import { getT } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> { return { title: (await getT())('ao.inst.title') }; }

export default async function AdminInstancesPageRoute() {
  await requireAdminPage('system.read');
  return <InstancesPage />;
}
