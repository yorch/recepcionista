/**
 * Management of the console's own administrators (users with role 'admin'). Node runtime only.
 *   list / invite (e-mail with a set-password link) / create with a password (RECOVERY only: break-glass token) / disable / enable ("unlock") / revoke sessions /
 *   reset 2FA / change platform role (owners only).
 * Invariants: at least one ENABLED owner always remains (a disable or demotion of the last one is refused, 409 last_owner); nobody changes their own role or disables themselves;
 * a role change, a disable and a 2FA reset revoke the affected sessions; every action is audited with the acting role.
 */
import crypto from 'node:crypto';
import { prisma } from '@/lib/db/client';
import { auditRowData } from '@/lib/db/audit';
import { createEmailToken } from '@/lib/db/email-tokens';
import { createUser, disableTotp, deleteUserSessions, EmailTakenError, normalizeEmail } from '@/lib/db/users';
import { hashPassword } from '@/lib/password';
import { resetPasswordTemplate, emailLink, RESET_PATH } from '@/lib/email/templates';
import { sendEmail } from '@/lib/email';
import { validateEmail, validateNewPassword } from '@/lib/user-policy';
import { logger } from '@/lib/log';
import { adminSettingsViaToken, isPlatformRole, roleCan, type AdminRole, type PlatformRole } from './permissions';
import { requireConfirmPhrase, requireReason } from './confirm';
import { SettingsError, type StoreActor } from './settings-store';

const log = logger('admins');
const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;

export interface AdminView {
  id: string; email: string; platform_role: PlatformRole | null; disabled: boolean; two_factor: boolean; created_at: string; email_verified: boolean; sessions: number;
}

export async function listAdmins(): Promise<AdminView[]> {
  const rows = await prisma.user.findMany({ where: { role: 'admin' }, orderBy: { createdAt: 'asc' }, include: { _count: { select: { sessions: true } } } });
  return rows.map((u) => ({
    id: u.id, email: u.email, platform_role: isPlatformRole(u.platformRole) ? u.platformRole : null, disabled: u.disabledAt !== null, two_factor: u.totpEnabledAt !== null,
    created_at: u.createdAt.toISOString(), email_verified: u.emailVerifiedAt !== null, sessions: u._count.sessions,
  }));
}

const need = (a: StoreActor, ...perms: ('admins.manage' | 'admins.recover' | 'admins.role')[]) => { if (a.role === 'system' || !perms.some((p) => roleCan(a.role as AdminRole, p))) throw new SettingsError(403, 'forbidden', 'not allowed to manage administrators'); };
const audit = (a: StoreActor, action: string, target: string, meta: Record<string, unknown>) =>
  prisma.auditEvent.create({ data: auditRowData({ actor_kind: a.kind, actor_user_id: a.user_id, action, target: `user:${target}`, ip: a.ip, meta: { ...meta, role: a.role, via: a.via }, meta_trusted: true }) });

async function enabledOwners(excludingId?: string): Promise<number> {
  return prisma.user.count({ where: { role: 'admin', platformRole: 'owner', disabledAt: null, ...(excludingId ? { id: { not: excludingId } } : {}) } });
}

export async function inviteAdmin(opts: { email: unknown; platform_role: unknown; password?: unknown; actor: StoreActor }): Promise<{ admin: AdminView; email_sent: boolean }> {
  const withPassword = opts.password !== undefined;
  need(opts.actor, 'admins.manage', 'admins.recover'); // an owner invites; the break-glass token may also create an admin (recovery)
  if (withPassword && opts.actor.via !== 'bearer' && opts.actor.role !== 'owner') throw new SettingsError(403, 'forbidden', 'only the break-glass token or an owner may set an initial password');
  const bad = validateEmail(opts.email);
  if (bad) throw new SettingsError(422, 'invalid_email', bad);
  if (!isPlatformRole(opts.platform_role)) throw new SettingsError(422, 'invalid_role', 'platform_role must be owner, ops, support or read_only');
  if (withPassword) { const pw = validateNewPassword(opts.password); if (pw) throw new SettingsError(422, 'invalid_password', pw); }
  // The break-glass token is recovery, not a way to mint standing owners: it may create an OWNER only when no enabled owner exists (lock-out recovery) or ADMIN_TOKEN_ALLOW_SETTINGS=true.
  // Otherwise it limits itself to unlocking (enable, revoke sessions) and inviting the lesser roles.
  if (opts.actor.via === 'bearer' && opts.platform_role === 'owner' && !adminSettingsViaToken() && (await enabledOwners()) > 0) {
    throw new SettingsError(403, 'owner_requires_owner', 'the break-glass token cannot create an owner while an enabled owner exists (an owner invites owners; ADMIN_TOKEN_ALLOW_SETTINGS=true lifts this)');
  }
  const email = normalizeEmail(opts.email as string);
  let user;
  try {
    user = await createUser({
      email, role: 'admin', platform_role: opts.platform_role, email_verified: true,
      password_hash: await hashPassword(withPassword ? (opts.password as string) : crypto.randomBytes(24).toString('base64url')), // an invite: nobody knows the password until the link is used
    });
  } catch (err) {
    if (err instanceof EmailTakenError) throw new SettingsError(409, 'email_taken', 'email already registered');
    throw err;
  }
  let sent = false;
  if (!withPassword) {
    try {
      const { token } = await createEmailToken({ purpose: 'reset', email, user_id: user.id, ttlMs: INVITE_TTL_MS });
      const mail = resetPasswordTemplate({ link: emailLink(RESET_PATH, token), ttlMinutes: INVITE_TTL_MS / 60_000 });
      await sendEmail({ to: email, subject: mail.subject, text: mail.text, html: mail.html });
      sent = true;
    } catch (err) {
      log.warn('invite_mail_failed', { error: (err as Error).message });
    }
  }
  await audit(opts.actor, 'admin.invited', user.id, { email_domain: email.split('@')[1], platform_role: opts.platform_role, with_password: withPassword, email_sent: sent });
  const [view] = (await listAdmins()).filter((a) => a.id === user.id);
  return { admin: view, email_sent: sent };
}

async function target(id: string) {
  const u = await prisma.user.findUnique({ where: { id } });
  if (!u || u.role !== 'admin') throw new SettingsError(404, 'not_found', 'administrator not found');
  return u;
}

export async function setAdminDisabled(opts: { id: string; disabled: boolean; actor: StoreActor }): Promise<void> {
  need(opts.actor, opts.disabled ? 'admins.manage' : 'admins.recover');
  const u = await target(opts.id);
  if (opts.disabled) {
    if (opts.actor.user_id === u.id) throw new SettingsError(409, 'self', 'you cannot disable yourself');
    if (u.platformRole === 'owner' && u.disabledAt === null && (await enabledOwners(u.id)) === 0) throw new SettingsError(409, 'last_owner', 'at least one enabled owner must remain');
  }
  await prisma.user.update({ where: { id: u.id }, data: { disabledAt: opts.disabled ? new Date() : null } });
  if (opts.disabled) await deleteUserSessions(u.id);
  await audit(opts.actor, opts.disabled ? 'admin.disabled' : 'admin.enabled', u.id, {});
}

export async function revokeAdminUserSessions(opts: { id: string; actor: StoreActor }): Promise<{ revoked: number }> {
  need(opts.actor, 'admins.recover');
  const u = await target(opts.id);
  const revoked = await deleteUserSessions(u.id);
  await audit(opts.actor, 'admin.sessions_revoked', u.id, { revoked });
  return { revoked };
}

/** Clear the second factor (and every session): the admin must enrol again at the next sign-in (always required while the console is active). */
export async function resetAdminTwoFactor(opts: { id: string; reason: unknown; confirm: unknown; actor: StoreActor }): Promise<{ revoked: number }> {
  need(opts.actor, 'admins.manage');
  const u = await target(opts.id);
  const reason = requireReason(opts.reason);
  requireConfirmPhrase(opts.confirm, [u.email]); // the console asks for the administrator's e-mail address
  const revoked = await disableTotp(u.id);
  await prisma.passkeyCredential.deleteMany({ where: { userId: u.id } });
  await audit(opts.actor, 'admin.two_factor_reset', u.id, { revoked, reason });
  return { revoked };
}

export async function changeAdminRole(opts: { id: string; platform_role: unknown; actor: StoreActor }): Promise<AdminView> {
  need(opts.actor, 'admins.role');
  if (!isPlatformRole(opts.platform_role)) throw new SettingsError(422, 'invalid_role', 'platform_role must be owner, ops, support or read_only');
  const u = await target(opts.id);
  if (opts.actor.user_id === u.id) throw new SettingsError(409, 'self', 'you cannot change your own role');
  if (u.platformRole === opts.platform_role) return (await listAdmins()).find((a) => a.id === u.id)!;
  if (u.platformRole === 'owner' && u.disabledAt === null && (await enabledOwners(u.id)) === 0) throw new SettingsError(409, 'last_owner', 'at least one enabled owner must remain');
  await prisma.user.update({ where: { id: u.id }, data: { platformRole: opts.platform_role } });
  await deleteUserSessions(u.id); // a downgrade must not wait for a session to expire
  await audit(opts.actor, 'admin.role_changed', u.id, { from: u.platformRole, to: opts.platform_role });
  return (await listAdmins()).find((a) => a.id === u.id)!;
}
