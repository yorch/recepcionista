import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SettingsPage } from '@/components/admin/settings-form';
import { isSettingsPageId } from '@/lib/admin-ui/model';
import { requireAdminPage } from '@/lib/admin-ui/server';
import { getT } from '@/lib/i18n/server';
import type { MessageKey } from '@/lib/i18n/core';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ page: string }> }): Promise<Metadata> {
  const { page } = await params;
  return isSettingsPageId(page) ? { title: (await getT())(`ac.page.${page}.title` as MessageKey) } : {};
}

export default async function AdminSettingsPage({ params }: { params: Promise<{ page: string }> }) {
  const { page } = await params;
  if (!isSettingsPageId(page)) notFound();
  await requireAdminPage('settings.read');
  return <SettingsPage page={page} />;
}
