import Link from 'next/link';
import { Card } from './card';
import { buttonClass } from './button';

/** Meaningful empty state: what this page is for, and the next thing to do. */
export function EmptyState({
  title, body, cta, secondary, children,
}: {
  title: string;
  body: string;
  cta?: { href: string; label: string };
  secondary?: { href: string; label: string };
  children?: React.ReactNode;
}) {
  return (
    <Card className="px-6 py-10 text-center">
      <h2 className="text-[15px] font-semibold text-white">{title}</h2>
      <p className="mx-auto mt-1.5 max-w-md text-[13px] leading-relaxed text-mute">{body}</p>
      {cta || secondary || children ? (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          {cta ? <Link href={cta.href} className={buttonClass('primary')}>{cta.label}</Link> : null}
          {secondary ? <Link href={secondary.href} className={buttonClass('outline')}>{secondary.label}</Link> : null}
          {children}
        </div>
      ) : null}
    </Card>
  );
}
