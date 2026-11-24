import type { Metadata } from 'next';
import Link from 'next/link';
import { TeamPanel } from '@/components/auth/team-panel';
import { getDashboardContext, requireRolePage } from '@/lib/dashboard-context';
import { getT } from '@/lib/i18n/server';
import { listPendingInvites, listTeamUsers } from '@/lib/team';

export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('team.title') };
}

/** Owners and admins only (staff get a 404). Admins manage the business picked in the sidebar switcher. */
export default async function TeamPage() {
  const t = await getT();
  const ctx = await getDashboardContext();
  requireRolePage(ctx, 'owner');
  const biz = ctx.business;
  const [users, invites] = await Promise.all([listTeamUsers(biz.id), listPendingInvites(biz.id)]);
  const selfId = 'user' in ctx.principal ? ctx.principal.user?.id : undefined;
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[24px] font-semibold tracking-[-0.02em]">{t('team.title')}</h1>
          <p className="mt-1 text-[13px] text-[#8b98ab]">{t('team.subtitle', { business: biz.name })}</p>
        </div>
        <Link href="/dashboard/team/audit" className="text-[13px] text-[#ffb08a] hover:underline">{t('team.auditLink')}</Link>
      </header>
      <TeamPanel
        businessId={biz.id}
        isAdmin={ctx.role === 'admin'}
        canInvite={ctx.principal.email_verified}
        members={users.map((u) => ({
          id: u.id, email: u.email, role: u.role === 'owner' ? 'owner' : 'staff', disabled: u.disabled_at !== null,
          verified: u.email_verified_at !== null, totp: u.totp_enabled, isSelf: u.id === selfId,
        }))}
        invites={invites.map((i) => ({ id: i.id, email: i.email, role: i.role, expires_at: i.expires_at, invited_by_email: i.invited_by_email }))}
      />
    </main>
  );
}
