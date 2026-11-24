'use client';
import { useEffect } from 'react';
import Link from 'next/link';
import { Button, buttonClass } from '@/components/ui/button';
import { Logo } from '@/components/ui/logo';

export default function RootError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  const digest = error instanceof Error ? (error as Error & { digest?: string }).digest : undefined;
  return (
    <main id="main-content" className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center px-5 py-10 text-center">
      <Logo />
      <h1 className="mt-8 text-[26px] font-semibold tracking-[-0.02em] text-white">Something went wrong</h1>
      <p role="alert" className="mt-2 text-[14px] leading-relaxed text-mute">
        We hit an unexpected problem. Try again, and if it keeps happening let us know{digest ? ` (reference ${digest})` : ''}.
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <Button onClick={() => retry()}>Try again</Button>
        <Link href="/" className={buttonClass('outline')}>Home</Link>
      </div>
    </main>
  );
}
