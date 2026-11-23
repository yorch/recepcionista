import { NextResponse } from 'next/server';
import { authenticate, principalRole } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Who am I? Role, business, email verification and 2FA state (for banners and the security page). No secrets. */
export async function GET(req: Request) {
  const auth = await authenticate(req, { allowEnrollment: true });
  if (!auth.ok) return auth.response;
  const p = auth.principal;
  const user = 'user' in p ? p.user : undefined;
  return NextResponse.json({
    ok: true,
    data: {
      role: principalRole(p),
      email: user?.email ?? null,
      business_id: p.kind === 'user' ? p.business_id : null,
      email_verified: p.email_verified,
      totp_enabled: user?.totp_enabled ?? false,
      needs_2fa_enrollment: p.kind === 'admin' ? Boolean(p.needs_2fa_enrollment) : false,
    },
  });
}
