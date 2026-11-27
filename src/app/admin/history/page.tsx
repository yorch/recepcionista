import type { Metadata } from 'next';
import { HistoryPage } from '@/components/admin/history';
import { requireAdminPage } from '@/lib/admin-ui/server';
import { getT } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> { return { title: (await getT())('ac.page.history.title') }; }

export default async function AdminHistoryPage() {
  await requireAdminPage('settings.read');
  return <HistoryPage />;
}
