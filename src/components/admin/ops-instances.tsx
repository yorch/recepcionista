'use client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Stat } from '@/components/ui/stat';
import { useT } from '@/lib/i18n/client';
import type { InstancesOverview } from '@/lib/admin/ops-model';
import { EmptyStateInline } from './empty-inline';
import { DataTable, OpsPage, Td, useFormat, usePoll } from './ops-ui';
import { ErrorPanel, LoadingBlock } from './ui';
import { useJson } from './use-json';

export function InstancesPage() {
  const t = useT();
  const fmt = useFormat();
  const { data, error, loading, reload } = useJson<InstancesOverview>('/api/admin/instances');
  usePoll(reload, 30_000);
  return (
    <OpsPage title={t('ao.inst.title')} subtitle={t('ao.inst.sub')} right={<Button variant="outline" onClick={reload} disabled={loading}>{loading ? t('common.loading') : t('ao.refresh')}</Button>}>
      {loading && !data ? <LoadingBlock /> : error && !data ? <ErrorPanel error={error} onRetry={reload} /> : data ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label={t('ao.inst.statVersion')} value={fmt.n(data.version)} sub={t('ao.inst.statVersionSub')} />
            <Stat label={t('ao.inst.statAlive')} value={fmt.n(data.alive)} sub={t('ao.inst.statAliveSub')} tone={data.alive === 0 ? 'warn' : undefined} />
            <Stat label={t('ao.inst.statCurrent')} value={`${fmt.n(data.current)} / ${fmt.n(data.alive)}`} sub={t('ao.inst.statCurrentSub')} tone={data.current < data.alive ? 'warn' : undefined} />
            <Stat label={t('ao.inst.statBuilds')} value={fmt.n(data.builds.length)} sub={data.mixed_builds ? t('ao.inst.mixed') : t('ao.inst.single')} tone={data.mixed_builds ? 'warn' : undefined} />
          </div>
          {data.mixed_builds ? <p role="note" className="rounded-xl border border-warn-line bg-warn-bg/40 px-3 py-2 text-[13px] text-warn">{t('ao.inst.mixedNote')}</p> : null}
          {data.instances.length === 0 ? <EmptyStateInline title={t('ao.inst.emptyTitle')} body={t('ao.inst.emptyBody')} /> : (
            <DataTable caption={t('ao.inst.title')} min={860} head={[{ label: t('ao.inst.col.instance') }, { label: t('ao.inst.col.state') }, { label: t('ao.inst.col.version'), right: true }, { label: t('ao.inst.col.build') }, { label: t('ao.inst.col.canary') }, { label: t('ao.inst.col.started') }, { label: t('ao.inst.col.seen') }]}>
              {data.instances.map((i) => (
                <tr key={i.instance_id} className="border-b border-line last:border-0">
                  <Td mono className="max-w-[12rem] break-all">{i.instance_id}</Td>
                  <Td>
                    <span className="flex flex-wrap gap-1">
                      <Badge tone={i.alive ? 'routine' : 'neutral'}>{i.alive ? t('ao.inst.alive') : t('ao.inst.gone')}</Badge>
                      {i.alive ? <Badge tone={i.current ? 'routine' : 'unsure'}>{i.current ? t('ao.inst.current') : t('ao.inst.behind', { n: i.behind_by })}</Badge> : null}
                    </span>
                  </Td>
                  <Td right>{fmt.n(i.settings_version)}</Td>
                  <Td mono>{i.build_sha ? i.build_sha.slice(0, 12) : <span className="text-dim">{t('ao.inst.noBuild')}</span>}</Td>
                  <Td><Badge tone={i.canary === 'ok' ? 'routine' : i.canary === 'failed' ? 'emergency' : 'neutral'}>{i.canary}</Badge>{i.ignored_rows > 0 ? <span className="ml-2 text-xs text-warn">{t('ao.inst.ignored', { n: i.ignored_rows })}</span> : null}</Td>
                  <Td className="whitespace-nowrap">{fmt.when(i.started_at)}</Td>
                  <Td className="whitespace-nowrap">{fmt.when(i.seen_at)}</Td>
                </tr>
              ))}
            </DataTable>
          )}
          <Card className="p-4"><p className="text-[13px] text-mute">{t('ao.inst.note')}</p></Card>
        </>
      ) : null}
    </OpsPage>
  );
}
