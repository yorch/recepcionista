import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail, readBody } from '@/lib/admin/guard';
import { dispatchAlertNotices } from '@/lib/admin/alerts';
import { adminRecipients } from '@/lib/admin/notify';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Notification routing of the alerts: GET answers WHO is notified (the number of recipients: every enabled admin, ALERT_EMAIL, the registry `platform.alert_recipients`; never the
 * addresses). POST { include_warnings?: boolean } mails every open, unacknowledged critical alert (and warnings when asked) to them NOW, ignoring the 6 hour spacing of the
 * automatic notice (the hourly cleanup job sends it). Permission: jobs.run; step-up for a cookie session.
 */
export async function GET(req: Request) {
  const g = await guardAdminRoute(req, { permission: 'system.read', rate: { name: 'alerts-notify-info', max: 30 } });
  if (!g.ok) return g.response;
  try { return ok({ recipients: (await adminRecipients()).length, automatic: 'hourly', spacing_hours: 6, severities: ['critical'] }); } catch (err) { return adminFail(err); }
}

export async function POST(req: Request) {
  const g = await guardAdminRoute(req, { permission: 'jobs.run', write: true, rate: { name: 'alerts-notify', max: 6 } });
  if (!g.ok) return g.response;
  try {
    const body = await readBody(req).catch(() => ({} as Record<string, unknown>));
    return ok(await dispatchAlertNotices({ force: true, severities: body.include_warnings === true ? ['critical', 'warning'] : ['critical'] }));
  } catch (err) { return adminFail(err); }
}
