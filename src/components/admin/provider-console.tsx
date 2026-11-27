'use client';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { useT } from '@/lib/i18n/client';
import { CARDS } from '@/lib/admin/provider-meta';
import { ErrorPanel, LoadingBlock } from './ui';
import { useJson } from './use-json';
import { useAdmin } from './provider';
import { FollowUpBanner } from './provider-followup';
import { ProviderCard } from './provider-card';
import { KeyRotationPanel } from './provider-rotation';
import type { LiveSelftest, ProvidersInfo, SettingsListing, SystemInfo } from './provider-api';

/**
 * /admin/providers: one card per provider (status, connection test, ids, write-only secrets, webhook addresses), the follow-up banners that loop the re-sync / repair
 * batches, and the APP_SECRET_KEY rotation panel. Everything is read from the console JSON routes; the server enforces every permission again.
 */
export function ProviderConsole() {
  const t = useT();
  const { can, me } = useAdmin();
  const settings = useJson<SettingsListing>('/api/admin/settings');
  const info = useJson<ProvidersInfo>(can('selftest.read') ? '/api/admin/providers' : null);
  const [liveOn, setLiveOn] = useState(true);
  const live = useJson<LiveSelftest>(can('selftest.read') && liveOn ? '/api/admin/selftest?live=1' : null);
  const system = useJson<SystemInfo>(can('system.read') ? '/api/admin/system' : null);

  const views = useMemo(() => new Map((settings.data?.settings ?? []).map((v) => [v.key, v])), [settings.data]);
  const liveBy = useMemo(() => new Map((live.data?.providers ?? []).map((p) => [p.provider, p])), [live.data]);

  const reloadAll = () => { settings.reload(); info.reload(); live.reload(); system.reload(); };
  const pending = (info.data?.follow_ups ?? []).filter((f) => f.pending);
  const totalFor = (action: string): number | null => (info.data ? (action === 'resync_agents' ? info.data.usage.agents : info.data.usage.numbers) : null);

  return (
    <main id="main" className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <PageHeader
        eyebrow={t('ap.page.eyebrow')} title={t('ap.page.title')} subtitle={t('ap.page.sub')}
        right={<Button variant="outline" onClick={() => { setLiveOn(true); live.reload(); info.reload(); }} disabled={live.loading}>{live.loading ? t('ap.page.refreshing') : t('ap.page.refresh')}</Button>}
      />
      <div className="mt-2 text-xs text-dim">
        {info.data ? (info.data.base_url ? <p>{t('ap.page.baseUrl', { url: info.data.base_url })} {t('ap.page.baseUrlNote')}</p> : <p role="status" className="text-warn">{t('ap.page.baseUrlNone')}</p>) : null}
        {me.frozen ? <p role="status" className="mt-1 text-warn">{t('ap.page.frozen')}</p> : null}
      </div>

      {settings.loading && !settings.data ? <div className="mt-6"><LoadingBlock rows={5} /></div> : null}
      {settings.error ? <div className="mt-6"><ErrorPanel error={settings.error} onRetry={reloadAll} /></div> : null}

      {settings.data ? (
        <div className="mt-6 flex flex-col gap-5">
          {pending.map((f) => <FollowUpBanner key={f.action} state={f} total={totalFor(f.action)} onFinished={() => info.reload()} />)}
          {CARDS.map((card) => (
            <ProviderCard key={card.id} card={card} views={views} info={info.data} live={liveBy.get(card.selftest) ?? null} onChanged={reloadAll} />
          ))}
          <KeyRotationPanel system={system.data} onDone={() => system.reload()} />
        </div>
      ) : null}
    </main>
  );
}
