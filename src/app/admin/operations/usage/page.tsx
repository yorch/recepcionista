import type { Metadata } from 'next';
import { UsagePage } from '@/components/admin/ops-usage';
import { requireAdminPage } from '@/lib/admin-ui/server';
import { getT } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> { return { title: (await getT())('ao.usage.title') }; }

export default async function AdminUsagePageRoute() {
  await requireAdminPage('tenants.read');
  return <UsagePage />;
}
