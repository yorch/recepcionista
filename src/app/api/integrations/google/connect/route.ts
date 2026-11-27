import { NextResponse } from 'next/server';
import { recordAudit } from '@/lib/db';
import { appBase, googleConfigured, googleMockEnabled, googleMockRefused, redirectUri } from '@/lib/integrations/google/config';
import { buildAuthUrl } from '@/lib/integrations/google/oauth';
import { scoped } from '@/lib/integrations/google/route-helpers';
import { newPkce, PKCE_COOKIE, sealVerifier, signState, STATE_TTL_MS } from '@/lib/integrations/google/state';
import { fail } from '@/lib/http';

export const dynamic = 'force-dynamic';

/**
 * GET /api/integrations/google/connect   OWNER (or admin with ?business_id=). Step-up is not required.
 * Starts OAuth 2.0 authorization-code + PKCE: sets the sealed verifier cookie and 302s to Google (a redirect: no new CSP origins).
 * `state` is HMAC-signed and bound to user + business + session. Mock mode (non-production only) skips Google entirely.
 */
export async function GET(req: Request) {
  if (googleMockRefused()) return fail('GOOGLE_OAUTH_MOCK is not allowed in production', 503);
  const r = await scoped(req, 'owner', { stateChanging: true });
  if (!r.ok) return r.response;
  const { s } = r;
  if (!googleConfigured()) return fail('Google Calendar is not configured on this server', 503);
  const { verifier, challenge } = newPkce();
  const { state, nonce } = signState({ u: s.actor.user_id, b: s.businessId, s: s.sessionId });
  await recordAudit({ actor_kind: s.actor.kind, actor_user_id: s.actor.user_id, business_id: s.businessId, action: 'calendar.connect_started', target: `business:${s.businessId}`, ip: s.ip });
  const url = googleMockEnabled()
    ? `${redirectUri()}?code=mock-code&state=${encodeURIComponent(state)}`
    : buildAuthUrl(state, challenge);
  const res = NextResponse.redirect(url, 302);
  res.cookies.set(PKCE_COOKIE, sealVerifier(verifier, nonce), {
    httpOnly: true, sameSite: 'lax', secure: appBase().startsWith('https://'), path: '/api/integrations/google', maxAge: Math.floor(STATE_TTL_MS / 1000),
  });
  res.headers.set('cache-control', 'no-store');
  return res;
}
