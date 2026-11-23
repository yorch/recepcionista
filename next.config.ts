import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Emit .next/standalone with a traced, minimal node_modules + server.js.
  // The container runs `node server.js` from that bundle instead of `next start`,
  // which is what keeps the runtime image small enough to ship.
  output: 'standalone',
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
