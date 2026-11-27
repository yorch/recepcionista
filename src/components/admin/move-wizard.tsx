'use client';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardHead } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { useLocale, useT } from '@/lib/i18n/client';
import type { FreezeState, SettingView } from '@/lib/admin/settings-store';
import { classifyMove, type MoveRow } from '@/lib/admin-ui/move';
import { settingDef } from '@/lib/config/registry';
import { displayValue } from '@/lib/admin-ui/model';
import { settingText } from '@/lib/admin-ui/setting-text';
import { ChangeReview } from './change-review';
import { useAdmin } from './provider';
import { useJson } from './use-json';
import { ErrorPanel, LoadingBlock, SourceBadge, TierBadge } from './ui';

interface Listing { version: number; frozen: FreezeState; settings: SettingView[] }

/**
 * "Move to console": the keys the ENVIRONMENT pins today (non-secret ones can be copied; secrets are entered once in the provider cards). The copy stores a console
 * value equal to the pinned one (dormant while the variable exists: the environment still wins); once the line is deleted from the env file and the app restarted,
 * the console value serves it. Nothing here deletes anything: the page tells which lines are safe to delete.
 */
export function MoveWizard() {
  const t = useT();
  const locale = useLocale();
  const { me } = useAdmin();
  const { data, error, loading, reload } = useJson<Listing>('/api/admin/settings');
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [reviewing, setReviewing] = useState(false);

  const cls = useMemo(() => (data ? classifyMove(data.settings, me.permissions) : null), [data, me.permissions]);
  const selectable = cls?.movable ?? [];
  const isOn = (r: MoveRow) => picked[r.key] ?? r.preselect;
  const chosen = selectable.filter(isOn);
  const frozen = (data?.frozen.frozen ?? false) || me.frozen;

  const changes = chosen.map((r) => ({ key: r.key, value: r.value }));
  const viewOf = (key: string) => data?.settings.find((s) => s.key === key);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t('ac.page.move.title')} subtitle={t('ac.page.move.sub')} />
      {loading && !data ? <LoadingBlock rows={4} /> : error && !data ? <ErrorPanel error={error} onRetry={reload} /> : cls ? (
        <>
          <Card>
            <CardHead title={t('ac.move.step1')} subtitle={t('ac.move.step1Sub')} />
            {selectable.length === 0 && cls.blocked.length === 0 ? <p className="p-5 text-[13px] text-mute">{t('ac.move.none')}</p> : (
              <ul className="divide-y divide-line">
                {selectable.map((r) => {
                  const def = settingDef(r.key);
                  const text = def ? settingText(def, locale) : { label: r.key, help: '' };
                  const id = `mv-${r.key.replace(/\./g, '-')}`;
                  return (
                    <li key={r.key} className="flex items-start gap-3 px-5 py-3">
                      <input id={id} type="checkbox" checked={isOn(r)} onChange={(e) => setPicked((p) => ({ ...p, [r.key]: e.target.checked }))} disabled={frozen || reviewing} className="mt-1 h-5 w-5 accent-[var(--color-brand)]" />
                      <label htmlFor={id} className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2"><span className="text-[14px] font-medium text-white">{text.label}</span><TierBadge tier={r.tier} /><SourceBadge source="env" locked envName={r.env} /></span>
                        <span className="mt-0.5 block break-words font-mono text-[12px] text-soft">{displayValue(r.value, t('ac.diff.unset'))}</span>
                        <span className="mt-0.5 block font-mono text-[11px] text-dim">{r.env}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            {cls.blocked.length ? (
              <div className="border-t border-line px-5 py-4">
                <p className="text-[13px] font-medium text-soft">{t('ac.move.blocked')}</p>
                <ul className="mt-1.5 flex flex-col gap-1 text-[12px] text-mute">
                  {cls.blocked.map((b) => <li key={b.key}><code className="font-mono text-soft">{b.env}</code> — {t(`ac.move.why.${b.why}` as 'ac.move.why.secret')}</li>)}
                </ul>
              </div>
            ) : null}
            {selectable.length > 0 ? (
              <div className="border-t border-line p-5">
                <Button disabled={chosen.length === 0 || frozen || reviewing} onClick={() => setReviewing(true)}>{t('ac.move.review', { n: chosen.length })}</Button>
                {frozen ? <p className="mt-2 text-xs text-warn">{t('ac.block.frozenBanner')}</p> : null}
              </div>
            ) : null}
          </Card>

          {reviewing ? (
            <ChangeReview
              adopt changes={changes} title={t('ac.move.step2')} subtitle={t('ac.move.step2Sub')} submitLabel={t('ac.move.apply')}
              effectiveOf={(k) => viewOf(k)?.value}
              onCancel={() => setReviewing(false)} onApplied={() => { setReviewing(false); setPicked({}); reload(); }}
            />
          ) : null}

          <Card>
            <CardHead title={t('ac.move.step3')} subtitle={t('ac.move.step3Sub')} />
            <div className="p-5">
              {cls.ready.length === 0 ? <p className="text-[13px] text-mute">{t('ac.move.readyNone')}</p> : (
                <>
                  <p className="text-[13px] text-soft">{t('ac.move.readyBody')}</p>
                  <pre aria-label={t('ac.move.linesLabel')} className="mt-3 overflow-x-auto rounded-xl border border-line bg-sunken p-3 font-mono text-[12.5px] text-soft">{cls.ready.map((r) => r.env).join('\n')}</pre>
                  <p className="mt-2 text-xs text-dim">{t('ac.move.restartNote')}</p>
                </>
              )}
              {cls.differs.length ? (
                <div className="mt-4">
                  <p className="text-[13px] font-medium text-warn">{t('ac.move.differs')}</p>
                  <ul className="mt-1 list-disc pl-5 text-[12px] text-mute">{cls.differs.map((r) => <li key={r.key}><code className="font-mono text-soft">{r.env}</code></li>)}</ul>
                </div>
              ) : null}
            </div>
          </Card>
        </>
      ) : null}
    </div>
  );
}
