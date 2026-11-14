'use client';
import { cn } from './cn';

type Variant = 'primary' | 'ghost' | 'outline' | 'danger';

const styles: Record<Variant, string> = {
  primary:
    'bg-[#ff6b35] text-[#150800] hover:bg-[#ff8558] shadow-[0_8px_24px_-10px_rgba(255,107,53,.9)]',
  ghost: 'text-[#a8b6c8] hover:bg-[#161e29] hover:text-white',
  outline: 'border border-[#2a3546] text-[#cbd7e6] hover:bg-[#141c26] hover:text-white',
  danger: 'bg-[#3a1512] text-[#ff9b86] ring-1 ring-inset ring-[#5a221c] hover:bg-[#4a1a15]',
};

export function Button({
  children, variant = 'primary', className, ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...props}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        styles[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}
