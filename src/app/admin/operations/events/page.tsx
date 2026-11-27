import type { Metadata } from 'next';
import { EventsPage } from '@/components/admin/ops-events';
import { requireAdminPage } from '@/lib/admin-ui/server';
import { getT } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> { return { title: (await getT())('ao.events.title') }; }

export default async function AdminEventsPageRoute() {
  await requireAdminPage('system.read');
  return <EventsPage />;
}
