import type { Metadata } from 'next';
import { SystemPage } from '@/components/admin/system-page';
import { requireAdminPage } from '@/lib/admin-ui/server';
import { getT } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> { return { title: (await getT())('ac.page.system.title') }; }

export default async function AdminSystemPage() {
  await requireAdminPage('system.read');
  return <SystemPage />;
}
