import { headers } from 'next/headers';
import { setting } from '@/lib/config';
import { getT } from '@/lib/i18n/server';

/**
 * The platform notices of the console (registry platform.maintenance_mode and platform.announcement), shown on every page except the console itself (which
 * has its own chrome). Plain text only: the announcement is escaped by React, never parsed as markup. Reads the live snapshot, so a console change shows within
 * the 10 second settings poll.
 */
export async function PlatformBanner() {
  const maintenance = setting('platform.maintenance_mode') === true;
  const announcement = (setting('platform.announcement') ?? '').trim();
  if (!maintenance && !announcement) return null;
  let path = '';
  try { path = (await headers()).get('x-rc-pathname') ?? ''; } catch { /* outside a request */ }
  if (path === '/admin' || path.startsWith('/admin/')) return null;
  const t = await getT();
  return (
    <div>
      {maintenance ? <p role="status" className="border-b border-warn-line bg-warn-bg px-4 py-2.5 text-center text-[13px] font-medium text-warn">{t('ac.banner.maintenance')}</p> : null}
      {announcement ? <p role="status" className="border-b border-sky-line bg-sky-bg px-4 py-2.5 text-center text-[13px] text-sky-text">{announcement}</p> : null}
    </div>
  );
}
