import type { Metadata } from 'next';
import { TenantDetailPage } from '@/components/admin/tenant-detail';
import { requireAdminPage } from '@/lib/admin-ui/server';
import { getT } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> { return { title: (await getT())('at.detail.title') }; }

export default async function AdminTenantDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdminPage('tenants.read');
  return <TenantDetailPage id={(await params).id} />;
}
