import { cn } from './cn';

type Variant = 'primary' | 'ghost' | 'outline' | 'danger';

const styles: Record<Variant, string> = {
  primary: 'bg-brand text-on-brand hover:bg-brand-hover shadow-[0_8px_24px_-10px_rgba(255,107,53,.9)]',
  ghost: 'text-body hover:bg-raised hover:text-white',
  outline: 'border border-line-3 text-soft hover:bg-panel-2 hover:text-white',
  danger: 'bg-danger-bg text-danger ring-1 ring-inset ring-danger-line hover:bg-[#4a1a15]',
};

/** Shared button look for <button> and <Link>: min 44px tall (touch target), visible focus from globals.css. */
export function buttonClass(variant: Variant = 'primary', className?: string) {
  return cn(
    'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
    styles[variant],
    className,
  );
}

export function Button({
  children, variant = 'primary', className, type = 'button', ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button type={type} {...props} className={buttonClass(variant, className)}>
      {children}
    </button>
  );
}
