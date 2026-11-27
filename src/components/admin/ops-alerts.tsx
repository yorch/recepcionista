'use client';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SelectField, TextField } from '@/components/ui/field';
import { Stat } from '@/components/ui/stat';
import { apiRequest } from '@/hooks/use-api';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/core';
import { ACK_DEFAULT_HOURS, type AlertView } from '@/lib/admin/ops-model';
import { EmptyStateInline } from './empty-inline';
import { OpsPage, SeverityBadge, useFormat, usePoll } from './ops-ui';
import { opsErrorText } from './ops-errors';
import { useAdmin } from './provider';
import { ErrorPanel, LoadingBlock } from './ui';
import { useJson } from './use-json';

interface AlertsData { alerts: AlertView[]; summary: { critical: number; warning: number; info: number; open: number; acknowledged: number }; generated_at: string }
const HOURS = [1, 4, 24, 72, 168] as const;

/** One localized sentence per alert: what is wrong and how many, from the non-secret detail the API returns. */
export function alertLine(t: ReturnType<typeof useT>, a: AlertView): string {
  const d = a.detail;
  const base = { count: a.count, subject: a.subject ?? '', code: String(d.top_code ?? '-'), job: String(d.job ?? a.subject ?? ''), outcome: String(d.outcome ?? ''), behind: Number(d.instances_behind ?? 0), alive: Number(d.instances_alive ?? 0), pending: Number(d.pending ?? 0) };
  return t(`ao.alert.${a.kind}.line` as MessageKey, base);
}

export function AlertsPage() {
  const t = useT();
  const { data, error, loading, reload } = useJson<AlertsData>('/api/admin/alerts');
  const info = useJson<{ recipients: number; spacing_hours: number }>('/api/admin/alerts/notify');
  const { can, guard } = useAdmin();
  const fmt = useFormat();
  const [notifying, setNotifying] = useState(false);
  usePoll(reload, 60_000);

  async function notifyNow() {
    setNotifying(true);
    try {
      await guard(async () => {
        const r = await apiRequest<{ due: string[]; recipients: number; sent: number; failed: number }>('/api/admin/alerts/notify', { method: 'POST', body: {} });
        toast.success(t('ao.alerts.notified', { alerts: r.due.length, sent: r.sent }));
      });
    } catch (err) { toast.error(opsErrorText(t, err)); } finally { setNotifying(false); }
  }

  const right = (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" onClick={reload} disabled={loading}>{loading ? t('common.loading') : t('ao.refresh')}</Button>
      {can('jobs.run') ? <Button variant="outline" onClick={() => void notifyNow()} disabled={notifying}>{notifying ? t('common.loading') : t('ao.alerts.notifyNow')}</Button> : null}
    </div>
  );

  return (
    <OpsPage title={t('ao.alerts.title')} subtitle={t('ao.alerts.sub')} right={right}>
      {loading && !data ? <LoadingBlock /> : error && !data ? <ErrorPanel error={error} onRetry={reload} /> : data ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label={t('ao.severity.critical')} value={fmt.n(data.summary.critical)} sub={t('ao.alerts.statOpen')} tone={data.summary.critical > 0 ? 'warn' : undefined} />
            <Stat label={t('ao.severity.warning')} value={fmt.n(data.summary.warning)} sub={t('ao.alerts.statOpen')} tone={data.summary.warning > 0 ? 'warn' : undefined} />
            <Stat label={t('ao.alerts.statAcked')} value={fmt.n(data.summary.acknowledged)} sub={t('ao.alerts.statAckedSub')} />
            <Stat label={t('ao.alerts.statRecipients')} value={info.data ? fmt.n(info.data.recipients) : '-'} sub={t('ao.alerts.statRecipientsSub', { hours: info.data?.spacing_hours ?? 6 })} />
          </div>
          <p className="text-[13px] text-mute">{t('ao.alerts.routing')}</p>
          {data.alerts.length === 0 ? <EmptyStateInline title={t('ao.alerts.emptyTitle')} body={t('ao.alerts.emptyBody')} /> : (
            <ul className="flex flex-col gap-3" aria-label={t('ao.alerts.listLabel')}>
              {data.alerts.map((a) => <AlertCard key={a.id} a={a} onChanged={reload} />)}
            </ul>
          )}
          <p className="text-xs text-dim">{t('ao.generatedAt', { when: fmt.when(data.generated_at) })}</p>
        </>
      ) : null}
    </OpsPage>
  );
}

function AlertCard({ a, onChanged }: { a: AlertView; onChanged: () => void }) {
  const t = useT();
  const { can, guard } = useAdmin();
  const fmt = useFormat();
  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState<number>(ACK_DEFAULT_HOURS);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const canAck = can('jobs.run') && a.severity !== 'info';

  async function ack(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await guard(async () => { await apiRequest('/api/admin/alerts/ack', { method: 'POST', body: { id: a.id, hours, reason: reason.trim() || undefined } }); });
      toast.success(t('ao.alerts.ackDone'));
      setOpen(false); setReason(''); onChanged();
    } catch (err) { setError(err); } finally { setBusy(false); }
  }
  async function unack() {
    setBusy(true);
    try {
      await guard(async () => { await apiRequest('/api/admin/alerts/ack', { method: 'DELETE', body: { id: a.id } }); });
      toast.success(t('ao.alerts.unackDone')); onChanged();
    } catch (err) { toast.error(opsErrorText(t, err)); } finally { setBusy(false); }
  }

  return (
    <li>
      <Card className={a.severity === 'critical' && !a.acknowledged ? 'border-danger-line p-4' : 'p-4'}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-white">
              <SeverityBadge severity={a.severity} />
              {t(`ao.alert.${a.kind}.title` as MessageKey)}{a.subject ? <span className="font-mono text-xs font-normal text-mute">{a.subject}</span> : null}
              {a.acknowledged ? <Badge tone="neutral">{t('ao.alerts.acknowledged')}</Badge> : null}
            </p>
            <p className="mt-1 text-[13px] text-soft">{alertLine(t, a)}</p>
            <p className="mt-1 text-xs text-dim">{t(`ao.alert.${a.kind}.help` as MessageKey)}</p>
            {a.since ? <p className="mt-1 text-xs text-dim">{t('ao.alerts.since', { when: fmt.when(a.since) })}</p> : null}
            {a.acknowledged ? <p className="mt-1 text-xs text-dim">{t('ao.alerts.ackUntil', { when: fmt.when(a.acknowledged.until) })}{a.acknowledged.reason ? ` · ${a.acknowledged.reason}` : ''}</p> : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href={a.href} className="inline-flex min-h-11 items-center rounded-xl border border-line-3 px-4 text-sm font-medium text-soft hover:bg-panel-2 hover:text-white">{t('ao.alerts.open')}</Link>
            {canAck && !a.acknowledged && !open ? <Button variant="outline" onClick={() => setOpen(true)}>{t('ao.alerts.ack')}</Button> : null}
            {canAck && a.acknowledged ? <Button variant="ghost" disabled={busy} onClick={() => void unack()}>{t('ao.alerts.unack')}</Button> : null}
          </div>
        </div>
        {open ? (
          <form onSubmit={ack} aria-label={t('ao.alerts.ackTitle')} className="mt-4 flex flex-col gap-3 rounded-xl border border-line-3 bg-sunken/60 p-4">
            <p className="text-[13px] text-mute">{t('ao.alerts.ackHelp')}</p>
            <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
              <SelectField label={t('ao.alerts.ackFor')} value={String(hours)} onChange={(e) => setHours(Number(e.target.value))}>
                {HOURS.map((h) => <option key={h} value={h}>{t('ao.alerts.ackHours', { hours: h })}</option>)}
              </SelectField>
              <TextField label={t('ao.alerts.ackReason')} optional value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
            </div>
            {error ? <p role="alert" className="text-[13px] text-danger">{opsErrorText(t, error)}</p> : null}
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>{busy ? t('common.loading') : t('ao.alerts.ack')}</Button>
              <Button variant="ghost" onClick={() => { setOpen(false); setError(null); }}>{t('common.cancel')}</Button>
            </div>
          </form>
        ) : null}
      </Card>
    </li>
  );
}
