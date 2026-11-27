import type { Metadata } from 'next';
import { ProviderConsole } from '@/components/admin/provider-console';
import { requireAdminPage } from '@/lib/admin-ui/server';

export const metadata: Metadata = { robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

/** Providers and secrets. Admin only (the gate answers 404 to anyone else); the page reads everything through the console JSON routes. */
export default async function ProvidersPage() {
  await requireAdminPage('settings.read');
  return <ProviderConsole />;
}
