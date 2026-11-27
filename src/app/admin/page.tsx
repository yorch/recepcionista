import type { Metadata } from 'next';
import { Overview } from '@/components/admin/overview';
import { requireAdminPage } from '@/lib/admin-ui/server';
import { getT } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> { return { title: (await getT())('ac.page.overview.title') }; }

export default async function AdminOverviewPage() {
  await requireAdminPage();
  return <Overview />;
}
