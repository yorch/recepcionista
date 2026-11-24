import { cn } from './cn';

const tones = {
  neutral: 'bg-[#1b232e] text-body ring-line-3',
  emergency: 'bg-danger-bg text-danger ring-danger-line',
  routine: 'bg-mint-bg text-mint-text ring-mint-line',
  unsure: 'bg-warn-bg text-warn ring-warn-line',
  brand: 'bg-brand-bg text-[#ffb08a] ring-brand-line',
  sky: 'bg-sky-bg text-sky-text ring-sky-line',
} as const;

export type BadgeTone = keyof typeof tones;

export function Badge({
  children, tone = 'neutral', className,
}: { children: React.ReactNode; tone?: BadgeTone | (string & {}); className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        tones[tone as BadgeTone] ?? tones.neutral,
        className,
      )}
    >
      {children}
    </span>
  );
}
