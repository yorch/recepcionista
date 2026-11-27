'use client';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/core';
import type { ProviderTestResult } from './provider-api';
import { formatWhen } from './ui';

const TONE: Record<ProviderTestResult['outcome'], BadgeTone> = { ok: 'routine', auth_failed: 'emergency', unreachable: 'unsure', misconfigured: 'unsure' };

/** Outcome of a connection test: a text badge (never colour alone), what it means, the sub-checks, and for Stripe the mode. Coarse by design: no provider text. */
export function TestOutcomeBadge({ outcome }: { outcome: ProviderTestResult['outcome'] }) {
  const t = useT();
  return <Badge tone={TONE[outcome]}>{t(`ap.test.outcome.${outcome}` as MessageKey)}</Badge>;
}

export function TestResultView({ result, local }: { result: ProviderTestResult; local?: boolean }) {
  const t = useT();
  const locale = useLocale();
  const checks = Object.entries(result.checks ?? {}).filter(([, v]) => v !== 'skipped');
  return (
    <div className="flex flex-col gap-2" data-testid="test-result">
      <div className="flex flex-wrap items-center gap-2">
        <TestOutcomeBadge outcome={result.outcome} />
        {typeof result.livemode === 'boolean' ? <Badge tone={result.livemode ? 'brand' : 'neutral'}>{t(result.livemode ? 'ap.sec.mode.live' : 'ap.sec.mode.test')}</Badge> : null}
        <span className="text-xs text-dim">{t('ap.test.checkedAt', { when: formatWhen(result.tested_at, locale) })}</span>
      </div>
      <p className="text-[13px] text-soft">{t(`ap.test.outcomeHelp.${result.outcome}` as MessageKey)}</p>
      {local ? <p className="text-xs text-dim">{t('ap.test.local')}</p> : null}
      {checks.length ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <dt className="sr-only">{t('ap.test.checks')}</dt>
          {checks.map(([name, v]) => (
            <div key={name} className="contents">
              <dt className="text-dim">{t(`ap.check.${name}` as MessageKey)}</dt>
              <dd className={v === 'ok' ? 'text-mint-text' : 'text-warn'}>{t(`ap.checkOutcome.${v}` as MessageKey)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
