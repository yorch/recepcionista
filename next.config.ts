import type { NextConfig } from 'next';

const isProd = process.env.NODE_ENV === 'production';

/**
 * Content-Security-Policy.
 *
 * script-src keeps 'unsafe-inline' because Next's bootstrap/RSC payload scripts are inline. A strict
 * nonce + 'strict-dynamic' policy needs a per-request nonce minted in src/proxy.ts and every page
 * rendered dynamically (docs: content-security-policy); that touches the auth proxy and gives up static
 * pages, so it is a documented follow-up (docs/security-headers.md). Everything else is locked down:
 * no framing, no plugins, same-origin form posts and connections, and no mixed content in production.
 * Set CSP_REPORT_ONLY=true to ship the same policy as Content-Security-Policy-Report-Only while
 * watching for violations before enforcing it on a new deployment.
 * Dev needs 'unsafe-eval' (React debugging) and ws: (HMR).
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${isProd ? '' : ' ws: wss:'}`,
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isProd ? ['upgrade-insecure-requests'] : []),
].join('; ');

const securityHeaders = [
  { key: process.env.CSP_REPORT_ONLY === 'true' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy', value: csp },
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
