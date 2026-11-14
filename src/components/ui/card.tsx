import { cn } from './cn';

export function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-[#1f2937] bg-[#0d1117]/80 backdrop-blur-sm',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHead({
  title, subtitle, right,
}: { title: string; subtitle?: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[#1f2937] px-5 py-4">
      <div>
        <h2 className="text-sm font-semibold tracking-tight text-white">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-xs text-[#8b98ab]">{subtitle}</p> : null}
      </div>
      {right}
    </div>
  );
}
