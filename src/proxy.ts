import { NextResponse, type NextRequest } from 'next/server';
import {
  authConfig, checkSameOrigin, hasAdminCredentials, hasBearer, hasSessionCookie, isPublicPath, SAFE_METHODS, userSessionTokenFrom,
} from '@/lib/auth';

/**
 * Cheap gate only. The proxy cannot reach the database, so it checks that a request CARRIES a
 * credential (valid admin Bearer, or a WELL-FORMED admin/user session cookie: shape only) and, for cookie
 * authenticated state-changing requests, that it is same-origin. A syntactically plausible user
 * cookie proves nothing: every non-public handler/page re-validates it in Node via
 * authenticate() / getServerPrincipal() (src/lib/session.ts).
 */
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  // Forward the path to server components (they cannot read it otherwise). Always overwritten here, so a client-sent
  // header of the same name is never trusted. Used only to let admins who must enrol in 2FA reach the security page.
  const forwarded = new Headers(req.headers);
  forwarded.set('x-rc-pathname', pathname);
  const next = () => NextResponse.next({ request: { headers: forwarded } });
  if (isPublicPath(pathname)) return next();

  const isApi = pathname.startsWith('/api/');
  const cfg = authConfig();
  if (cfg.mode === 'misconfigured') {
    if (isApi) return NextResponse.json({ ok: false, error: 'server auth not configured' }, { status: 503 });
    return new NextResponse('Server auth not configured', { status: 503 });
  }

  if (!SAFE_METHODS.has(req.method) && !hasBearer(req.headers) && hasSessionCookie(req.headers) && !checkSameOrigin(req.headers, { requirePresent: true })) {
    return NextResponse.json({ ok: false, error: 'cross-site request refused' }, { status: 403 });
  }

  if (cfg.mode === 'open') return next();
  if (userSessionTokenFrom(req.headers) || (await hasAdminCredentials(req.headers))) return next();

  if (isApi) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  url.searchParams.set('next', pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // Only Next internals and the favicon bypass the proxy. Public API/page
  // paths are decided by isPublicPath() (never by file extension: a dynamic
  // /api/**/x.js must still be authenticated). Handlers re-validate (session.ts).
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
