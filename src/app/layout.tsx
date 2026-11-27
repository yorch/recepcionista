import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { connection } from 'next/server';
import { Toaster } from 'sonner';
import { SkipLink } from '@/components/ui/skip-link';
import { PlatformBanner } from '@/components/platform-banner';
import { siteUrl } from '@/app/site-config';
import { I18nProvider } from '@/lib/i18n/client';
import { getLocale, getMessages } from '@/lib/i18n/server';
import { makeT } from '@/lib/i18n';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const t = makeT(locale);
  const title = t('meta.title');
  const description = t('meta.description');
  return {
    metadataBase: new URL(siteUrl()),
    title: { default: title, template: t('meta.titleTemplate', { page: '%s' }) },
    description,
    applicationName: 'Recepcionista',
    openGraph: { type: 'website', siteName: 'Recepcionista', title, description, locale: locale === 'es' ? 'es_US' : 'en_US' },
    twitter: { card: 'summary', title, description },
  };
}

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
  const { locale, messages } = await getMessages();
  return (
    <html lang={locale} className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
      <body className="min-h-screen">
        <I18nProvider locale={locale} messages={messages}>
          <SkipLink />
          <PlatformBanner />
          {children}
          {/* sonner renders an aria-live="polite" region labelled "Notifications" (localized). */}
          <Toaster theme="dark" position="bottom-right" closeButton containerAriaLabel={makeT(locale)('toast.notifications')} />
        </I18nProvider>
      </body>
    </html>
  );
}
