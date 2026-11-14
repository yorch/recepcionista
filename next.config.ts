import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The dashboard reads the local JSON store on every request; disabling the
  // cache-components experiment keeps `dynamic = 'force-dynamic'` legal.
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
