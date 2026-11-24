import { NextResponse } from 'next/server';
import { listAdminSessions, listUserSessions } from '@/lib/db';
import { authenticate } from '@/lib/session';
import type { UserSession } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const view = (s: UserSession, current: string | null) => ({
  id: s.id, created_at: s.created_at, last_used_at: s.last_used_at, expires_at: s.expires_at,
  ip: s.ip, user_agent: s.user_agent, current: s.id === current,
});

/** The caller's own live sessions (never anyone else's). Admins also get the break-glass admin sessions. */
export async function GET(req: Request) {
  const auth = await authenticate(req, { allowEnrollment: true });
  if (!auth.ok) return auth.response;
  const { principal, sessionId } = auth;
  const user = 'user' in principal ? principal.user : undefined;
  const mine = user ? await listUserSessions(user.id) : [];
  const admin = principal.kind === 'admin' ? await listAdminSessions() : undefined;
  return NextResponse.json({
    ok: true,
    data: { sessions: mine.map((s) => view(s, sessionId)), ...(admin ? { admin_sessions: admin.map((s) => view(s, sessionId)) } : {}) },
  });
}
