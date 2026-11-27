import type { Metadata } from 'next';
import { LegalEditorPage } from '@/components/admin/legal-editor';
import { requireAdminPage } from '@/lib/admin-ui/server';
import { getT } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> { return { title: (await getT())('ac.page.legal.title') }; }

export default async function AdminLegalPage() {
  await requireAdminPage('legal.read');
  return <LegalEditorPage />;
}
