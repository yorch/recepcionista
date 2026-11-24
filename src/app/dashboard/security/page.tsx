import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { SecurityPanel, type SessionView } from '@/components/auth/security-panel';
import { countUnusedRecoveryCodes, listAdminSessions, listUserSessions } from '@/lib/db';
import { getServerResolution, require2faForAdmins } from '@/lib/session';
import type { UserSession } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Security' };

const view = (s: UserSession, current: string | null): SessionView => ({
  id: s.id, created_at: s.created_at, last_used_at: s.last_used_at, expires_at: s.expires_at, ip: s.ip, user_agent: s.user_agent, current: s.id === current,
});

export default async function SecurityPage() {
  const res = await getServerResolution();
  if (!res) redirect('/login');
  const { principal, sessionId } = res;
  const user = 'user' in principal ? principal.user : undefined;
  const [sessions, recoveryLeft, adminSessions] = await Promise.all([
    user ? listUserSessions(user.id) : Promise.resolve([]),
    user?.totp_enabled ? countUnusedRecoveryCodes(user.id) : Promise.resolve(0),
    principal.kind === 'admin' ? listAdminSessions() : Promise.resolve([]),
  ]);
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-8">
      <header>
        <h1 className="text-[24px] font-semibold tracking-[-0.02em]">Security</h1>
        <p className="mt-1 text-[13px] text-[#8b98ab]">Your email, two-step verification and signed-in devices.</p>
      </header>
      <SecurityPanel
        email={user?.email ?? null}
        emailVerified={principal.email_verified}
        totpEnabled={user?.totp_enabled ?? false}
        recoveryLeft={recoveryLeft}
        sessions={sessions.map((s) => view(s, sessionId))}
        isAdmin={principal.kind === 'admin'}
        adminSessionCount={adminSessions.length}
        twoFactorRequired={principal.kind === 'admin' && Boolean(user) && require2faForAdmins()}
      />
    </main>
  );
}
