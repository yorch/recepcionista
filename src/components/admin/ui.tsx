'use client';
import { useId } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TextAreaField, TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { useT } from '@/lib/i18n/client';
import { adminErrorText, problemsOf } from './errors';

/** Where a value comes from: the default, the console, or locked by an environment variable. Text, not colour alone. */
export function SourceBadge({ source, locked, envName }: { source: 'env' | 'console' | 'default'; locked?: boolean; envName?: string | null }) {
  const t = useT();
  if (source === 'env' || locked) {
    return <Badge tone="unsure" className="whitespace-nowrap">{t('ac.src.lockedEnv')}{envName ? <span className="sr-only"> ({envName})</span> : null}</Badge>;
  }
  return source === 'console' ? <Badge tone="sky">{t('ac.src.console')}</Badge> : <Badge>{t('ac.src.default')}</Badge>;
}

export function TierBadge({ tier }: { tier: 'normal' | 'sensitive' | 'critical' }) {
  const t = useT();
  if (tier === 'normal') return null;
  return <Badge tone={tier === 'critical' ? 'emergency' : 'brand'}>{t(tier === 'critical' ? 'ac.tier.critical' : 'ac.tier.sensitive')}</Badge>;
}

export function LoadingBlock({ rows = 3 }: { rows?: number }) {
  const t = useT();
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-3">
      <span className="sr-only">{t('common.loading')}</span>
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-16 w-full" />)}
    </div>
  );
}

/** A failed load: what happened (localized) and a retry. */
export function ErrorPanel({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const t = useT();
  return (
    <Card role="alert" className="border-danger-line bg-danger-bg/40 p-5">
      <p className="text-sm font-semibold text-danger">{t('ac.error.title')}</p>
      <p className="mt-1 text-[13px] text-soft">{adminErrorText(t, error)}</p>
      {onRetry ? <Button variant="outline" className="mt-3" onClick={onRetry}>{t('common.retry')}</Button> : null}
    </Card>
  );
}

/** The per-key problems of a rejected change set, each with its localized code and the offending key. */
export function Problems({ error, labelOf }: { error: unknown; labelOf?: (key: string) => string }) {
  const t = useT();
  const list = problemsOf(error);
  return (
    <div role="alert" className="rounded-xl border border-danger-line bg-danger-bg/40 p-3 text-[13px] text-danger">
      <p className="font-medium">{adminErrorText(t, error)}</p>
      {list.length > 1 ? (
        <ul className="mt-1.5 list-disc space-y-1 pl-5 text-soft">
          {list.map((p, i) => <li key={`${p.key}-${i}`}><span className="font-mono text-xs">{labelOf ? labelOf(p.key) : p.key}</span>: {p.message}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Reason + typed confirmation of the tiers: `reason` for sensitive and critical, `phrase` (the exact words to type) for critical. The caller owns
 * the state; the Apply button stays disabled until both are valid (the server checks again).
 */
export function ConfirmFields({
  reasonRequired, phrase, reason, onReason, typed, onTyped, minReason = 8,
}: { reasonRequired: boolean; phrase: string | null; reason: string; onReason: (v: string) => void; typed: string; onTyped: (v: string) => void; minReason?: number }) {
  const t = useT();
  const phraseId = useId();
  return (
    <div className="flex flex-col gap-3">
      {reasonRequired ? (
        <TextAreaField
          label={t('ac.confirm.reason')} hint={t('ac.confirm.reasonHint', { n: minReason })} rows={2} maxLength={500}
          value={reason} onChange={(e) => onReason(e.target.value)} required aria-required="true"
        />
      ) : null}
      {phrase ? (
        <div>
          <p id={phraseId} className="text-[13px] text-soft">
            {t('ac.confirm.typePrompt')} <code className="rounded bg-raised px-1.5 py-0.5 font-mono text-[12px] text-white select-all">{phrase}</code>
          </p>
          <TextField
            label={t('ac.confirm.typeLabel')} srOnlyLabel mono autoComplete="off" autoCapitalize="off" spellCheck={false}
            value={typed} onChange={(e) => onTyped(e.target.value)} aria-describedby={phraseId}
          />
        </div>
      ) : null}
    </div>
  );
}

export const confirmReady = (opts: { reasonRequired: boolean; reason: string; phrase: string | null; typed: string; minReason?: number }): boolean =>
  (!opts.reasonRequired || opts.reason.trim().length >= (opts.minReason ?? 8)) && (!opts.phrase || opts.typed.trim() === opts.phrase);

/** A short date-time in the viewer's locale. */
export function formatWhen(iso: string | null | undefined, locale: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(locale === 'es' ? 'es-US' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}
