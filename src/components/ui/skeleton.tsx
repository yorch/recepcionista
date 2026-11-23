import { cn } from './cn';

/** Decorative placeholder block; the surrounding region announces loading via PageSkeleton. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('skeleton', className)} />;
}

export function PageSkeleton({ rows = 4, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">{label}…</span>
      <Skeleton className="h-7 w-48" />
      <Skeleton className="mt-3 h-4 w-72 max-w-full" />
      <div className="mt-6 grid gap-3 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}
      </div>
      <div className="mt-5 flex flex-col gap-3">
        {Array.from({ length: rows }).map((_, i) => <Skeleton key={i} className="h-20" />)}
      </div>
    </main>
  );
}
