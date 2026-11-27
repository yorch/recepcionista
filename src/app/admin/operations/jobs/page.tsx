import type { Metadata } from 'next';
import { JobsPage } from '@/components/admin/ops-jobs';
import { requireAdminPage } from '@/lib/admin-ui/server';
import { getT } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> { return { title: (await getT())('ao.jobs.title') }; }

export default async function AdminJobsPageRoute() {
  await requireAdminPage('jobs.read');
  return <JobsPage />;
}
