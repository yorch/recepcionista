import { NextResponse, type NextRequest } from 'next/server';
import { authConfig, isAuthenticated, isPublicPath } from '@/lib/auth';

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  if (await isAuthenticated(req)) return NextResponse.next();

  const misconfigured = authConfig().mode === 'misconfigured';
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { ok: false, error: misconfigured ? 'server auth not configured' : 'unauthorized' },
      { status: misconfigured ? 503 : 401 },
    );
  }
  if (misconfigured) return new NextResponse('Server auth not configured', { status: 503 });
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  url.searchParams.set('next', pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except Next internals and static assets (audio, icons, etc.).
  matcher: ['/((?!_next/static|_next/image|favicon.ico|audio/|.*\\.(?:png|jpg|jpeg|svg|gif|webp|ico|mp3|m4a|css|js|map|txt)$).*)'],
};
