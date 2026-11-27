import type { Metadata } from 'next';
import { DeliveriesPage } from '@/components/admin/ops-deliveries';
import { requireAdminPage } from '@/lib/admin-ui/server';
import { getT } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> { return { title: (await getT())('ao.sms.title') }; }

export default async function AdminDeliveriesPageRoute() {
  await requireAdminPage('audit.read');
  return <DeliveriesPage />;
}
