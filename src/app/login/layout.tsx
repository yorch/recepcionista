import type { Metadata } from 'next';
import { getT } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('auth.meta.login') };
}

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
