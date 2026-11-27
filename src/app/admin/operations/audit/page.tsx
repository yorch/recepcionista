import type { Metadata } from 'next';
import { AuditPage } from '@/components/admin/ops-audit';
import { requireAdminPage } from '@/lib/admin-ui/server';
import { getT } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> { return { title: (await getT())('ao.audit.title') }; }

export default async function AdminAuditPageRoute() {
  await requireAdminPage('audit.read');
  return <AuditPage />;
}
