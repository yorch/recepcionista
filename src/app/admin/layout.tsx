import type { Metadata } from 'next';
import { AdminShell } from '@/components/admin/shell';
import { getAdminPageCtx } from '@/lib/admin-ui/server';
import { setting } from '@/lib/config';
import { getT } from '@/lib/i18n/server';

/** The console is never indexed and never cached: it renders per request after the server-side admin gate. */
export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> {
  return { title: { default: (await getT())('ac.shell.title'), template: `%s · ${(await getT())('ac.shell.title')}` }, robots: { index: false, follow: false } };
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Validates the credential against the database and enforces the 2FA invariant (see getServerResolution): a tenant owner gets a 404 here.
  const ctx = await getAdminPageCtx();
  return (
    <AdminShell
      me={{ role: ctx.role, via: ctx.via, email: ctx.email, twoFactor: ctx.twoFactor, permissions: ctx.permissions, sudoAt: ctx.sudoAt, frozen: ctx.freeze.frozen, frozenByEnv: ctx.freeze.by_env }}
      maintenance={setting('platform.maintenance_mode') === true}
    >
      {children}
    </AdminShell>
  );
}
