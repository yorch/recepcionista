import { STATUS_META, STATUS_ORDER } from '@/lib/calendar';
import { cn } from '@/components/ui/cn';
import type { BookingStatus } from '@/lib/types';

/** The status icon: shape + label carry the meaning, colour only reinforces it. */
export function StatusIcon({ status, className }: { status: BookingStatus; className?: string }) {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={cn('shrink-0', className)}>
      <path d={STATUS_META[status].icon} />
    </svg>
  );
}

export function StatusBadge({ status, className }: { status: BookingStatus; className?: string }) {
  const meta = STATUS_META[status];
  // `line-through` belongs to the calendar block; the badge keeps the label readable.
  const tone = meta.tone.replace('line-through', '');
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium', tone, className)}>
      <StatusIcon status={status} />
      {meta.label}
    </span>
  );
}

export function StatusLegend({ className }: { className?: string }) {
  return (
    <ul aria-label="Status legend" className={cn('flex flex-wrap items-center gap-x-3 gap-y-1.5', className)}>
      {STATUS_ORDER.map((s) => (
        <li key={s} title={STATUS_META[s].hint}><StatusBadge status={s} /></li>
      ))}
    </ul>
  );
}
