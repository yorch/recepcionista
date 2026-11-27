import type { Metadata } from 'next';
import { PlansPage } from '@/components/admin/plans-page';
import { requireAdminPage } from '@/lib/admin-ui/server';
import { getT } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> { return { title: (await getT())('at.plans.title') }; }

export default async function AdminPlansPage() {
  await requireAdminPage('plans.read');
  return <PlansPage />;
}
