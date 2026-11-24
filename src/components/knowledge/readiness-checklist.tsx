'use client';
import { useT } from '@/lib/i18n/client';
import type { Readiness } from '@/lib/kb/readiness';

/** The go-live checklist: what is required (blocks turning her on), what is recommended, and a score. Presentational: pass a Readiness. */
export function ReadinessChecklist({ readiness, className = '' }: { readiness: Readiness; className?: string }) {
  const t = useT();
  const { score, blockers, warnings, ready } = readiness;
  return (
    <section aria-label={t('kb.ready.region')} className={`rounded-2xl border border-line bg-panel/70 p-4 ${className}`}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[13px] font-semibold text-white">{ready ? t('kb.ready.ready') : t('kb.ready.notReady')}</h2>
        <span className="text-xs tabular-nums text-dim">{t('kb.ready.score', { score })}</span>
      </div>
      <div role="meter" aria-label={t('kb.ready.meter')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={score} className="mt-2 h-1.5 overflow-hidden rounded-full bg-raised">
        <div className={`h-full rounded-full ${ready ? 'bg-mint' : 'bg-warn'}`} style={{ width: `${score}%` }} />
      </div>
      {blockers.length > 0 ? (
        <>
          <p className="mt-3 text-xs font-medium uppercase tracking-wider text-danger">{t('kb.ready.required')}</p>
          <ul className="mt-1 space-y-1">{blockers.map((b) => <li key={b.key} className="text-[13px] text-soft"><span aria-hidden="true">✗ </span>{b.message}</li>)}</ul>
        </>
      ) : null}
      {warnings.length > 0 ? (
        <>
          <p className="mt-3 text-xs font-medium uppercase tracking-wider text-warn">{t('kb.ready.recommended')}</p>
          <ul className="mt-1 space-y-1">{warnings.map((w) => <li key={w.key} className="text-[13px] text-mute"><span aria-hidden="true">○ </span>{w.message}</li>)}</ul>
        </>
      ) : null}
      {ready && warnings.length === 0 ? <p className="mt-2 text-[13px] text-mint-text">{t('kb.ready.allSet')}</p> : null}
    </section>
  );
}
