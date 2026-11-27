'use client';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHead } from '@/components/ui/card';
import { apiRequest } from '@/hooks/use-api';
import { useLocale, useT } from '@/lib/i18n/client';
import { useAdmin } from './provider';
import type { SupportGrantView, TenantDetail } from './tenant-api';
import { ReasonAction } from './tenant-action';
import { formatWhen } from './ui';
import { Problems } from './tenant-errors';

/** Minutes and seconds left until `iso` (mm:ss), or null once past. Pure. */
export function countdown(iso: string, now: number): string | null {
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function useNow(intervalMs = 1000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const first = setTimeout(() => setNow(Date.now()), 0);
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => { clearTimeout(first); clearInterval(id); };
  }, [intervalMs]);
  return now;
}

/** Read-only support view by default; WRITE mode needs a reason and a fresh step-up, lasts 30 minutes, is audited and can be ended here. */
export function TenantSupport({ d, reload }: { d: TenantDetail; reload: () => void }) {
  const t = useT();
  const locale = useLocale();
  const { can, me } = useAdmin();
  const now = useNow();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const open = d.support_grants.find((g) => g.ended_at === null && new Date(g.expires_at).getTime() > (now ?? 0)) ?? null;
  const left = open && now ? countdown(open.expires_at, now) : null;
  const personal = me.email !== null;

  async function viewDashboard() {
    setBusy(true); setError(null);
    try {
      await apiRequest(`/api/admin/tenants/${d.id}/support-view`, { method: 'POST' });
      // a full navigation on purpose: the support view switches to the tenant dashboard layout with the business cookie just set
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign('/dashboard');
    } catch (err) { setError(err); setBusy(false); }
  }
  async function exit() {
    setBusy(true); setError(null);
    try { await apiRequest(`/api/admin/tenants/${d.id}/support-mode`, { method: 'DELETE' }); toast.success(t('at.support.exited')); reload(); } catch (err) { setError(err); } finally { setBusy(false); }
  }

  return (
    <Card>
      <CardHead title={t('at.support.title')} subtitle={t('at.support.sub')} right={<Badge tone={left ? 'unsure' : 'sky'}>{t(left ? 'at.support.writeBadge' : 'at.support.readBadge')}</Badge>} />
      <div className="flex flex-col gap-4 p-5">
        <p role="note" className={`rounded-xl px-4 py-3 text-[13px] ${left ? 'bg-warn-bg text-warn' : 'bg-sky-bg text-sky-text'}`}>
          {left ? t('at.support.writeBanner', { time: left }) : t('at.support.readBanner')}
        </p>
        <div className="flex flex-wrap gap-2">
          {can('tenants.read') ? <Button onClick={() => void viewDashboard()} disabled={busy}>{t('at.support.openDashboard')}</Button> : null}
          {left ? <Button variant="outline" onClick={() => void exit()} disabled={busy}>{t('at.support.exit')}</Button> : null}
        </div>
        {!left && can('tenants.support_enter') ? (
          personal ? (
            <ReasonAction
              label={t('at.support.enter')} variant="danger" description={t('at.support.enterHint')} doneMessage={t('at.support.entered')}
              run={(reason) => apiRequest(`/api/admin/tenants/${d.id}/support-mode`, { method: 'POST', body: { reason } })} onDone={reload}
            />
          ) : <p className="text-[13px] text-mute">{t('at.support.needsAccount')}</p>
        ) : null}
        {!can('tenants.support_enter') ? <p className="text-[13px] text-mute">{t('at.support.noWrite')}</p> : null}
        {error ? <Problems error={error} /> : null}
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-dim">{t('at.support.history')}</p>
          {d.support_grants.length === 0 ? <p className="mt-1 text-[13px] text-mute">{t('at.support.noHistory')}</p> : (
            <ul className="mt-2 flex flex-col gap-2 text-[13px]">
              {d.support_grants.map((g: TenantDetail['support_grants'][number]) => (
                <li key={g.id} className="rounded-lg border border-line px-3 py-2 text-soft">
                  <span className="block">{formatWhen(g.started_at, locale)} {g.ended_at ? `- ${formatWhen(g.ended_at, locale)}` : `- ${formatWhen(g.expires_at, locale)}`}</span>
                  <span className="block text-mute">{g.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}
export type { SupportGrantView };
