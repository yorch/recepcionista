import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Emit .next/standalone with a traced, minimal node_modules + server.js.
  // The container runs `node server.js` from that bundle instead of `next start`,
  // which is what keeps the runtime image small enough to ship.
  output: 'standalone',
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
