import type { NextConfig } from 'next';

const isProd = process.env.NODE_ENV === 'production';

/**
 * Content-Security-Policy is NOT set here: it carries a per-request nonce, so src/proxy.ts mints it (src/lib/csp.ts;
 * rationale and the CSP_REPORT_ONLY / CSP_REPORT_URI switches in docs/security-headers.md). These are the static headers.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  ...(isProd ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }] : []),
];

const nextConfig: NextConfig = {
  // Emit .next/standalone with a traced, minimal node_modules + server.js.
  // The container runs `node server.js` from that bundle instead of `next start`,
  // which is what keeps the runtime image small enough to ship.
  output: 'standalone',
  poweredByHeader: false,
  // Dev tunnels (e.g. a Cloudflare tunnel) must be listed here, or dev-only
  // assets and server-action posts from that origin are rejected. Set
  // ALLOWED_DEV_ORIGINS to a comma-separated list of hostnames in .env.
  allowedDevOrigins: (process.env.ALLOWED_DEV_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  // One line per request (method, path, status, duration) in dev, and dev-only
  // browser console forwarding at warn+ so client errors reach journalctl too.
  logging: {
    incomingRequests: true,
    browserToTerminal: 'warn',
    fetches: { fullUrl: false },
  },
  // Briefing audio is written at runtime, which Next does not serve from public/. Serve it through an
  // authenticated route (src/app/api/briefings/audio) while keeping the stored /audio/<file> URLs.
  async rewrites() {
    return { beforeFiles: [{ source: '/audio/:name', destination: '/api/briefings/audio/:name' }], afterFiles: [], fallback: [] };
  },
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      // The payment page must not leak the (guessable-by-referrer) link to anything it loads or links to.
      { source: '/pay/:path*', headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }, { key: 'Cache-Control', value: 'no-store' }] },
    ];
  },
  turbopack: {
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css',
      },
    },
  },
};

export default nextConfig;
