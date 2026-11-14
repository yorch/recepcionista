import { cn } from './cn';

const tones: Record<string, string> = {
  neutral: 'bg-[#1b232e] text-[#9fb0c5] ring-[#2a3546]',
  emergency: 'bg-[#3a1512] text-[#ff9b86] ring-[#5a221c]',
  routine: 'bg-[#10291f] text-[#6ee7b0] ring-[#1c4635]',
  unsure: 'bg-[#2e2410] text-[#f2c86b] ring-[#473817]',
  brand: 'bg-[#3a1e10] text-[#ffb08a] ring-[#57301c]',
  sky: 'bg-[#0d2a35] text-[#7fdcf5] ring-[#17445a]',
};

export function Badge({
  children, tone = 'neutral', className,
}: { children: React.ReactNode; tone?: keyof typeof tones | string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset',
        tones[tone] ?? tones.neutral,
        className,
      )}
    >
      {children}
    </span>
  );
}
