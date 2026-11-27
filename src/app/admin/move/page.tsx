import type { Metadata } from 'next';
import { MoveWizard } from '@/components/admin/move-wizard';
import { requireAdminPage } from '@/lib/admin-ui/server';
import { getT } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> { return { title: (await getT())('ac.page.move.title') }; }

export default async function AdminMovePage() {
  await requireAdminPage('settings.read');
  return <MoveWizard />;
}
