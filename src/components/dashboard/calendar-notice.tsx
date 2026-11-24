import Link from 'next/link';
import { getT } from '@/lib/i18n/server';
import { prisma } from '@/lib/db';
import { getCalendarConnection } from '@/lib/db/calendar';
import type { Business } from '@/lib/types';

const CHANGE_KEY = {
  deleted_in_google: 'gcalnotice.deleted',
  edited_in_google_before_push: 'gcalnotice.edited',
} as const;

/**
 * Server component for the Today page. Renders nothing unless Google Calendar needs attention:
 *  - the connection needs to be reconnected (it is NOT blocking time for the receptionist until then), or
 *  - the owner moved / deleted / edited a booking's event in Google in the last 7 days (the booking in Recepcionista may no longer match).
 * Reads one connection row and at most three audit rows; a lookup failure renders nothing (never breaks the dashboard).
 */
async function load(businessId: string): Promise<{ reauth: boolean; changes: { target: string; meta: unknown }[] } | null> {
  try {
    const conn = await getCalendarConnection(businessId);
    if (!conn || conn.status === 'revoked') return null;
    const changes = await prisma.auditEvent.findMany({
      where: { businessId, action: 'calendar.event_changed_externally', at: { gte: new Date(Date.now() - 7 * 86_400_000) } },
      orderBy: { at: 'desc' }, take: 3, select: { target: true, meta: true },
    });
    const reauth = conn.status === 'needs_reauth';
    return reauth || changes.length > 0 ? { reauth, changes } : null;
  } catch {
    return null;
  }
}

export async function CalendarNotice({ business, canManage }: { business: Business; canManage: boolean }) {
  const t = await getT();
  const state = await load(business.id);
  if (!state) return null;
  const { reauth, changes } = state;
  return (
    <section aria-label={t('gcalnotice.region')} className="mt-6 space-y-2 rounded-2xl border border-[#473817] bg-[#2e2410] p-4 text-[#f7dc9b]">
      {reauth ? (
        <p className="text-[13px] leading-relaxed">
          <strong className="font-semibold">{t('gcalnotice.reconnectTitle')}</strong> {t('gcalnotice.reconnectBody')}{' '}
          {canManage ? <Link href="/dashboard/settings" className="underline underline-offset-2">{t('gcalnotice.reconnectLink')}</Link> : t('gcalnotice.askOwner')}
        </p>
      ) : null}
      {changes.length > 0 ? (
        <div className="text-[13px] leading-relaxed">
          <p><strong className="font-semibold">{t('gcalnotice.changedTitle')}</strong> {t('gcalnotice.changed', { count: changes.length })}</p>
          <ul className="mt-1 list-disc pl-5">
            {changes.map((c) => (
              <li key={c.target}>
                <Link href="/dashboard/bookings?tab=agenda" className="underline underline-offset-2">{t('gcalnotice.aJob')}</Link>{' '}
                {t(CHANGE_KEY[String((c.meta as { change?: unknown } | null)?.change ?? '') as keyof typeof CHANGE_KEY] ?? 'gcalnotice.changedGeneric')}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
