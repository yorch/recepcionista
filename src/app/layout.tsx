import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { connection } from 'next/server';
import { Toaster } from 'sonner';
import { SkipLink } from '@/components/ui/skip-link';
import { siteUrl } from '@/app/site-config';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

const TITLE = 'Recepcionista — Your bilingual AI front desk';
const DESCRIPTION =
  'Paste your website and get a bilingual AI receptionist that answers your phone, books jobs, collects deposits, and briefs you at the end of the day.';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: { default: TITLE, template: '%s · Recepcionista' },
  description: DESCRIPTION,
  applicationName: 'Recepcionista',
  openGraph: {
    type: 'website',
    siteName: 'Recepcionista',
    title: TITLE,
    description: DESCRIPTION,
    locale: 'en_US',
  },
  twitter: { card: 'summary', title: TITLE, description: DESCRIPTION },
};

export const viewport: Viewport = {
  themeColor: '#07090d',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Render every page per request: the Content-Security-Policy nonce is minted per request in src/proxy.ts and Next can
  // only stamp it on scripts during request-time rendering, never into a prerendered (static) page.
  await connection();
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
      <body className="min-h-screen">
        <SkipLink />
        {children}
        {/* sonner renders an aria-live="polite" region labelled "Notifications". */}
        <Toaster theme="dark" position="bottom-right" closeButton />
      </body>
    </html>
  );
}
