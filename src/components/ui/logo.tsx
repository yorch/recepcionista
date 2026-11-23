import Link from 'next/link';
import { cn } from './cn';

/** The brand mark. Single source for the landing page, login, onboarding, dashboard and pay page. */
export function LogoMark({ className, letter = 'R' }: { className?: string; letter?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand text-[15px] font-bold text-on-brand', className)}
    >
      {letter}
    </span>
  );
}

export function Logo({ href = '/', className, label = 'Recepcionista' }: { href?: string | null; className?: string; label?: string }) {
  const inner = (
    <>
      <LogoMark />
      <span className="text-[15px] font-semibold tracking-tight text-white">{label}</span>
    </>
  );
  const cls = cn('inline-flex min-h-11 items-center gap-2.5', className);
  return href ? (
    <Link href={href} className={cls} aria-label={`${label} home`}>
      {inner}
    </Link>
  ) : (
    <span className={cls}>{inner}</span>
  );
}
