import Link from 'next/link';
import { LogoMark } from '@/components/ui/logo';

export default function PayNotFound() {
  return (
    <main id="main-content" className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center px-5 py-10 text-center">
      <LogoMark />
      <h1 className="mt-5 text-[24px] font-semibold tracking-[-0.02em] text-white">This payment link is not valid</h1>
      <p className="mt-2 text-[14px] leading-relaxed text-mute">
        It may have expired, already been used, or been copied incorrectly. Please check the text message you received,
        or contact the business that sent it. No payment was taken.
      </p>
      <Link href="/" className="mt-6 inline-flex min-h-11 items-center text-[13px] text-brand-soft hover:underline">Go to Recepcionista</Link>
    </main>
  );
}
