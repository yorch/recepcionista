import type { Metadata } from 'next';
import { AlertsPage } from '@/components/admin/ops-alerts';
import { requireAdminPage } from '@/lib/admin-ui/server';
import { getT } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> { return { title: (await getT())('ao.alerts.title') }; }

export default async function AdminAlertsPageRoute() {
  await requireAdminPage('system.read');
  return <AlertsPage />;
}
