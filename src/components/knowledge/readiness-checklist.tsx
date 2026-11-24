import type { Readiness } from '@/lib/kb/readiness';

/** The go-live checklist: what is required (blocks turning her on), what is recommended, and a score. Presentational: pass a Readiness. */
export function ReadinessChecklist({ readiness, className = '' }: { readiness: Readiness; className?: string }) {
  const { score, blockers, warnings, ready } = readiness;
  return (
    <section aria-label="Go-live checklist" className={`rounded-2xl border border-line bg-panel/70 p-4 ${className}`}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[13px] font-semibold text-white">{ready ? 'Ready to go live' : 'Not ready to go live yet'}</h2>
        <span className="text-xs tabular-nums text-dim">Readiness {score}/100</span>
      </div>
      <div role="meter" aria-label="Readiness" aria-valuemin={0} aria-valuemax={100} aria-valuenow={score} className="mt-2 h-1.5 overflow-hidden rounded-full bg-raised">
        <div className={`h-full rounded-full ${ready ? 'bg-mint' : 'bg-warn'}`} style={{ width: `${score}%` }} />
      </div>
      {blockers.length > 0 ? (
        <>
          <p className="mt-3 text-xs font-medium uppercase tracking-wider text-danger">Required</p>
          <ul className="mt-1 space-y-1">{blockers.map((b) => <li key={b.key} className="text-[13px] text-soft"><span aria-hidden="true">✗ </span>{b.message}</li>)}</ul>
        </>
      ) : null}
      {warnings.length > 0 ? (
        <>
          <p className="mt-3 text-xs font-medium uppercase tracking-wider text-warn">Recommended</p>
          <ul className="mt-1 space-y-1">{warnings.map((w) => <li key={w.key} className="text-[13px] text-mute"><span aria-hidden="true">○ </span>{w.message}</li>)}</ul>
        </>
      ) : null}
      {ready && warnings.length === 0 ? <p className="mt-2 text-[13px] text-mint-text">Everything she needs is in place.</p> : null}
    </section>
  );
}
