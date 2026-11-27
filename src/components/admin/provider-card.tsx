'use client';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHead } from '@/components/ui/card';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/core';
import { CARDS, type CardDef, type TestId } from '@/lib/admin/provider-meta';
import { cardStatus, isPartnerField, labelKeyOf, partnersOf, testsFor, type CardStatus } from '@/lib/admin/provider-ui';
import { adminErrorText } from './errors';
import { formatWhen } from './ui';
import { useAdmin } from './provider';
import { PlainField } from './provider-field';
import { SecretField } from './secret-field';
import { TestOutcomeBadge, TestResultView } from './provider-test-result';
import { testCandidate, type LiveCard, type ProviderTestResult, type ProvidersInfo, type SettingView } from './provider-api';

const STATUS_TONE: Record<CardStatus, BadgeTone> = { locked_env: 'unsure', console: 'sky', mixed: 'sky', unset: 'neutral', incomplete: 'emergency' };
const STATUS_KEY: Record<CardStatus, MessageKey> = { locked_env: 'ap.status.lockedEnv', console: 'ap.status.console', mixed: 'ap.status.mixed', unset: 'ap.status.unset', incomplete: 'ap.status.incomplete' };

interface Props {
  card: CardDef;
  views: ReadonlyMap<string, SettingView>;
  info: ProvidersInfo | null;
  live: LiveCard | null;
  onChanged: () => void;
}

/** One provider: configuration status, the connection test, ids (plain), secrets (write-only), webhook addresses and what depends on it. */
export function ProviderCard({ card, views, info, live, onChanged }: Props) {
  const t = useT();
  const locale = useLocale();
  const { can } = useAdmin();
  const [results, setResults] = useState<Partial<Record<TestId, ProviderTestResult>>>({});
  const [running, setRunning] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);

  const fields = card.fields.map((f) => ({ def: f, view: views.get(f.key) })).filter((x): x is { def: typeof x.def; view: SettingView } => x.view !== undefined);
  const states = fields.map(({ def, view }) => (def.role === 'secret'
    ? { key: def.key, source: view.secret?.source ?? 'none', set: view.secret?.set ?? false }
    : { key: def.key, source: view.source, set: view.value !== null && view.value !== undefined && view.value !== '' }));
  const status = cardStatus(card.id, states as never);
  const isSet = (key: string) => states.find((s) => s.key === key)?.set ?? false;
  const valueOf = (key: string) => views.get(key)?.value;
  const tests = testsFor(card, isSet, valueOf);
  const mayTest = can('providers.repair') || can('settings.secrets.write');
  const manual = Object.values(results);
  const shown = manual.length ? manual : live?.test ? [live.test] : [];

  async function runTests() {
    if (running || tests.length === 0) return;
    setRunning(true); setTestError(null);
    try {
      const out: Partial<Record<TestId, ProviderTestResult>> = {};
      for (const id of tests) out[id] = await testCandidate(id);
      setResults(out);
    } catch (err) {
      setTestError(adminErrorText(t, err));
      toast.error(t('ap.test.failed'));
    } finally { setRunning(false); }
  }

  const webhooks = (info?.webhooks ?? []).filter((w) => w.card === card.id);
  const headingId = `prov-${card.id}`;
  const secretFields = fields.filter((f) => f.def.role === 'secret');
  const plain = fields.filter((f) => f.def.role !== 'secret' && !isPartnerField(f.def.key) && f.def.key !== 'google.oauth_redirect_uri');
  const redirect = card.id === 'calendar' ? info?.google_redirect ?? null : null;

  return (
    <Card as-region="" role="region" aria-labelledby={headingId} data-card={card.id}>
      <CardHead
        title={t(`ap.card.${card.id}.title` as MessageKey)} subtitle={t(`ap.card.${card.id}.sub` as MessageKey)}
        right={<div className="flex flex-wrap items-center justify-end gap-2" id={headingId}><span className="sr-only">{t('ap.status.label')}: </span><Badge tone={STATUS_TONE[status]}>{t(STATUS_KEY[status])}</Badge></div>}
      />
      <div className="flex flex-col gap-5 p-5">
        <section aria-label={t('ap.status.connection')} className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            {shown.length === 0 ? <span className="text-[13px] text-dim">{status === 'unset' ? t('ap.status.unconfigured') : t('ap.status.pending')}</span> : shown.map((r) => (
              <span key={r.provider} className="flex flex-wrap items-center gap-2 text-[13px] text-soft">
                {card.tests.length > 1 ? <span className="font-mono text-xs text-dim">{r.provider}</span> : null}
                <TestOutcomeBadge outcome={r.outcome} />
                <span className="text-xs text-dim">{t('ap.test.checkedAt', { when: formatWhen(r.tested_at, locale) })}</span>
              </span>
            ))}
            {mayTest && tests.length > 0 ? <Button variant="outline" onClick={() => void runTests()} disabled={running}>{running ? t('ap.test.running') : t('ap.test.run')}</Button> : null}
          </div>
          {manual.map((r) => <TestResultView key={r.provider} result={r} />)}
          {testError ? <p role="alert" className="text-[13px] text-danger">{testError}</p> : null}
          <CardFacts card={card} info={info} />
        </section>

        {plain.length ? (
          <div className="grid gap-3 md:grid-cols-2">
            {plain.map(({ view }) => <PlainField key={view.key} view={view} onChanged={onChanged} />)}
          </div>
        ) : null}

        {secretFields.length ? (
          <div className="grid gap-3 lg:grid-cols-2">
            {secretFields.map(({ def, view }) => (
              <SecretField
                key={view.key} view={view} test={def.test} onChanged={onChanged}
                partners={partnersOf(view.key).map((k) => views.get(k)).filter((v): v is SettingView => v !== undefined)}
              />
            ))}
          </div>
        ) : null}

        {redirect ? (
          <div className="rounded-xl border border-line bg-sunken/40 p-4">
            <h4 className="text-sm font-medium text-white">{t(labelKeyOf('google.oauth_redirect_uri') as MessageKey)}</h4>
            <p className="mt-1 text-xs text-dim">{redirect.overridden ? t('ap.fld.override') : t('ap.fld.derived')}</p>
            {redirect.url ? <CopyAddress url={redirect.url} label={t(labelKeyOf('google.oauth_redirect_uri') as MessageKey)} /> : <p className="mt-1 text-xs text-dim">{t('ap.wh.noBase')}</p>}
            {views.get('google.oauth_redirect_uri') ? <div className="mt-3"><PlainField view={views.get('google.oauth_redirect_uri') as SettingView} onChanged={onChanged} /></div> : null}
          </div>
        ) : null}

        {webhooks.length ? (
          <section aria-label={t('ap.wh.title')}>
            <h3 className="text-xs font-medium uppercase tracking-wider text-dim">{t('ap.wh.title')}</h3>
            <p className="mt-1 text-xs text-dim">{t('ap.wh.hint')}</p>
            <ul className="mt-3 flex flex-col gap-3">
              {webhooks.map((w) => (
                <li key={w.id} className="rounded-xl border border-line bg-sunken/40 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[13px] font-medium text-white">{t(`ap.wh.name.${w.id}` as MessageKey)}</span>
                    {w.secret_key === 'twilio.auth_token' ? <Badge>{t('ap.wh.verifierToken')}</Badge> : w.verifier_configured === null ? null : w.verifier_configured ? <Badge tone="routine">{t('ap.wh.verifierOk')}</Badge> : <Badge tone="emergency">{t('ap.wh.verifierMissing')}</Badge>}
                  </div>
                  {w.url ? <CopyAddress url={w.url} label={t(`ap.wh.name.${w.id}` as MessageKey)} /> : <p className="mt-1 text-xs text-dim">{t('ap.wh.noBase')}</p>}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </Card>
  );
}

/** What depends on the provider (tenant numbers, agents, Stripe customers, the fixed timeout of the language model). Facts only, from the server. */
function CardFacts({ card, info }: { card: CardDef; info: ProvidersInfo | null }) {
  const t = useT();
  if (card.id === 'telephony' && info) {
    return <ul className="flex flex-col gap-0.5 text-xs text-dim"><li>{t('ap.use.numbers', { n: info.usage.numbers })}</li><li>{t(info.usage.messaging_service ? 'ap.use.poolOn' : 'ap.use.poolOff')}</li></ul>;
  }
  if (card.id === 'voice' && info) return <p className="text-xs text-dim">{t('ap.use.agents', { n: info.usage.agents })}</p>;
  if (card.id === 'payments' && info) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-dim">
        {info.stripe_mode ? <Badge tone={info.stripe_mode === 'live' ? 'brand' : 'neutral'}>{t(info.stripe_mode === 'live' ? 'ap.sec.mode.live' : 'ap.sec.mode.test')}</Badge> : null}
        <span>{t('ap.use.customers', { n: info.usage.stripe_customers })}</span>
      </div>
    );
  }
  if (card.id === 'ai') return <p className="text-xs text-dim">{t('ap.fld.timeout')}: {t('ap.fld.timeoutValue', { n: 30 })}</p>;
  return null;
}

/** A read-only address with a Copy button (clipboard, with a visible fallback: the address is selectable text). */
function CopyAddress({ url, label }: { url: string; label: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { toast.error(t('ap.wh.copyFailed')); }
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <code className="min-w-0 flex-1 select-all break-all rounded bg-raised px-2 py-1.5 font-mono text-xs text-white">{url}</code>
      <Button variant="outline" onClick={() => void copy()} aria-label={`${t('ap.wh.copy')}: ${label}`}>{copied ? t('ap.wh.copied') : t('ap.wh.copy')}</Button>
      <span className="sr-only" role="status">{copied ? t('ap.wh.copied') : ''}</span>
    </div>
  );
}

export const CARD_IDS = CARDS.map((c) => c.id);
