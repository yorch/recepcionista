/**
 * Out-of-band notifications of the admin console: critical-tier changes and every use of the break-glass token go to EVERY enabled admin plus the env ALERT_EMAIL
 * (and the registry `platform.alert_recipients`). Node runtime only.
 *
 * The transport: never the one being changed. Critical changes pass the configuration that was active BEFORE the change (`transportEnv`); everything else
 * uses the live configuration. A failed notification is logged and audited (`admin.notify_failed`), never thrown: it must not undo a change that committed.
 */
import { configEnv, setting } from '@/lib/config';
import { prisma } from '@/lib/db/client';
import { recordAudit } from '@/lib/db/audit';
import { sendEmail } from '@/lib/email';
import { logger } from '@/lib/log';

const log = logger('admin-notify');
const ADDRESS = /^[^\s<>@,;"']+@[^\s<>@,;"']+\.[^\s<>@,;"']+$/;

/** Emails of every enabled admin account (any platform role), the env ALERT_EMAIL and the registry alert recipients, de-duplicated and lowercased. */
export async function adminRecipients(env: NodeJS.ProcessEnv = configEnv()): Promise<string[]> {
  const set = new Set<string>();
  try {
    const rows = await prisma.user.findMany({ where: { role: 'admin', disabledAt: null }, select: { email: true } });
    for (const r of rows) set.add(r.email.toLowerCase());
  } catch (err) {
    log.error('recipients_failed', { error: (err as Error).message });
  }
  for (const raw of [env.ALERT_EMAIL ?? '', ...((setting('platform.alert_recipients') as string[] | null) ?? [])]) {
    for (const part of String(raw).split(/[,;\s]+/)) if (ADDRESS.test(part)) set.add(part.toLowerCase());
  }
  return [...set];
}

export interface AdminNotice {
  subject: string;
  /** Plain text. NEVER put a secret value or a full settings value here: keys, tiers, reasons and fingerprints only. */
  lines: string[];
  /** What happened (audit action suffix on a failure). */
  kind: string;
  /** The configuration to send through. Default: the live one. */
  transportEnv?: NodeJS.ProcessEnv;
  business_id?: string | null;
}

export interface NotifyResult { recipients: number; sent: number; failed: number }

export async function notifyAdmins(n: AdminNotice): Promise<NotifyResult> {
  const env = n.transportEnv ?? configEnv();
  const to = await adminRecipients(env);
  const text = `${n.lines.join('\n')}\n\n(This notice is sent to every administrator. If you do not recognise this activity, freeze settings and rotate the break-glass token.)`;
  const results = await Promise.allSettled(to.map((addr) => sendEmail({ to: addr, subject: n.subject.replace(/[\r\n]+/g, ' ').slice(0, 200), text }, env)));
  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed > 0) {
    log.error('notify_failed', { kind: n.kind, failed, of: to.length });
    await recordAudit({ actor_kind: 'system', action: 'admin.notify_failed', target: n.kind, business_id: n.business_id ?? null, meta: { failed, recipients: to.length } });
  }
  return { recipients: to.length, sent: to.length - failed, failed };
}
