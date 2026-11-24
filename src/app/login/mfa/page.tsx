import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { MfaForm } from '@/components/auth/mfa-form';
import { getT } from '@/lib/i18n/server';
import { resolvePendingMfa } from '@/lib/session';

export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('auth.meta.mfa'), robots: { index: false } };
}

/** Only reachable with a password-accepted, second-factor-pending session; anything else goes back to /login. */
export default async function MfaPage() {
  const pending = await resolvePendingMfa(new Headers(await headers())).catch(() => null);
  if (!pending) redirect('/login');
  return <MfaForm />;
}
