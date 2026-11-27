import type { Metadata } from 'next';
import { HealthPage } from '@/components/admin/ops-health';
import { requireAdminPage } from '@/lib/admin-ui/server';
import { getT } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> { return { title: (await getT())('ao.health.title') }; }

export default async function AdminHealthPageRoute() {
  await requireAdminPage('selftest.read');
  return <HealthPage />;
}
