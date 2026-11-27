import type { Metadata } from 'next';
import { TenantsPage } from '@/components/admin/tenants-page';
import { requireAdminPage } from '@/lib/admin-ui/server';
import { getT } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> { return { title: (await getT())('at.tenants.title') }; }

export default async function AdminTenantsPage() {
  await requireAdminPage('tenants.read');
  return <TenantsPage />;
}
