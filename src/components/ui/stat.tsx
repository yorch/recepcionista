import { cn } from './cn';

export function Stat({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: 'warn' }) {
  return (
    <div className="rounded-xl border border-line bg-panel/80 p-4">
      <p className="text-xs uppercase tracking-wider text-dim">{label}</p>
      <p className={cn('mt-1.5 text-[22px] font-semibold tabular-nums tracking-tight', tone === 'warn' ? 'text-warn' : 'text-white')}>{value}</p>
      <p className="text-xs text-dim">{sub}</p>
    </div>
  );
}
