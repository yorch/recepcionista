import type { Metadata } from 'next';
import { AdminsPage } from '@/components/admin/admins-page';
import { requireAdminPage } from '@/lib/admin-ui/server';
import { getT } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> { return { title: (await getT())('at.admins.title') }; }

export default async function AdminAdminsPage() {
  await requireAdminPage('admins.read');
  return <AdminsPage />;
}
