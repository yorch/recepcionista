import { redirect } from 'next/navigation';
import { requireAdminPage } from '@/lib/admin-ui/server';
import { OPS_TABS } from '@/components/admin/ops-ui';

export const dynamic = 'force-dynamic';

/** `/admin/operations` has no page of its own: it opens the first operations view the caller's role may read. */
export default async function AdminOperationsIndex() {
  const ctx = await requireAdminPage();
  const first = OPS_TABS.find((i) => ctx.permissions.includes(i.permission));
  redirect(first?.href ?? '/admin');
}
