/**
 * Platform roles and the permission matrix of the admin console (owner decision D7). PURE: no I/O, safe in any bundle.
 *
 * Roles (stored in users.platform_role; every pre-existing admin user was migrated to `owner`):
 *   owner      everything, including secrets, critical settings, admin management and role changes
 *   ops        day-to-day operations: normal and sensitive settings, plans, tenants, jobs, legal drafts; NO secrets, critical settings, import or admin management
 *   support    read-only support view of tenants, audit and settings; a TIME-BOXED write mode (30 min, with a reason) for the tenant knobs listed in SUPPORT_WRITE_SCOPE
 *   read_only  everything readable EXCEPT secret metadata; no writes at all
 *   bearer     the break-glass ADMIN_TOKEN (Bearer, or its cookie session): RECOVERY ONLY (D8). It may read, create / unlock an admin, revoke sessions, freeze, roll back and run the
 *              legacy operator actions that existed before the console; it may NOT write secrets or critical settings unless ADMIN_TOKEN_ALLOW_SETTINGS=true.
 * An admin user without a platform role (a row written outside createUser) is `read_only`: fail safe.
 */
import { configEnv } from '@/lib/config';

export const PLATFORM_ROLES = ['owner', 'ops', 'support', 'read_only'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];
export type AdminRole = PlatformRole | 'bearer';
export const isPlatformRole = (v: unknown): v is PlatformRole => typeof v === 'string' && (PLATFORM_ROLES as readonly string[]).includes(v);

export const PERMISSIONS = [
  // settings
  'settings.read', 'settings.export', 'settings.write', 'settings.write.critical', 'settings.secrets.write', 'settings.import',
  'settings.rollback', 'settings.rollback.critical', 'settings.freeze', 'settings.unfreeze',
  // plans, legal
  'plans.read', 'plans.write', 'legal.read', 'legal.write', 'legal.publish',
  // tenants
  'tenants.read', 'tenants.billing', 'tenants.suspend', 'tenants.overrides.write', 'tenants.users.create', 'tenants.release', 'tenants.support_enter',
  // operations
  'jobs.read', 'jobs.run', 'retention.run', 'providers.repair', 'providers.resync', 'selftest.read', 'system.read',
  // audit
  'audit.read', 'audit.export',
  // admins
  'admins.read', 'admins.manage', 'admins.recover', 'admins.role',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const READ: readonly Permission[] = ['settings.read', 'settings.export', 'plans.read', 'legal.read', 'tenants.read', 'jobs.read', 'selftest.read', 'system.read', 'audit.read', 'admins.read'];
const OPS: readonly Permission[] = [
  ...READ, 'settings.write', 'settings.rollback', 'settings.freeze', 'plans.write', 'legal.write', 'tenants.billing', 'tenants.suspend', 'tenants.overrides.write',
  'tenants.users.create', 'tenants.release', 'tenants.support_enter', 'jobs.run', 'retention.run', 'providers.repair', 'providers.resync', 'audit.export',
];

export const ROLE_PERMISSIONS: Readonly<Record<PlatformRole, ReadonlySet<Permission>>> = {
  owner: new Set(PERMISSIONS),
  ops: new Set(OPS),
  support: new Set<Permission>(['settings.read', 'settings.export', 'plans.read', 'legal.read', 'tenants.read', 'jobs.read', 'selftest.read', 'system.read', 'audit.read', 'tenants.support_enter']),
  read_only: new Set(READ),
};

/** Recovery set of the break-glass token (D8) plus the operator actions that predate the console. */
const BEARER_BASE: readonly Permission[] = [
  ...READ, 'settings.freeze', 'settings.unfreeze', 'settings.rollback', 'settings.rollback.critical', 'admins.recover',
  'tenants.billing', 'tenants.release', 'tenants.users.create', 'providers.repair', 'providers.resync', 'jobs.run', 'retention.run',
];
/** Added to the token only with ADMIN_TOKEN_ALLOW_SETTINGS=true. */
const BEARER_SETTINGS: readonly Permission[] = ['settings.write', 'settings.write.critical', 'settings.secrets.write', 'settings.import'];

/** What a support user may do while a write grant (SupportGrant, 30 min, with a reason) is open for the tenant. Everything else stays read-only. */
export const SUPPORT_WRITE_SCOPE: ReadonlySet<Permission> = new Set<Permission>(['tenants.overrides.write']);
export const SUPPORT_WRITE_MS = 30 * 60_000;

/** The structural part of a principal the matrix needs (the real `Principal` in session.ts satisfies it). */
export interface AdminLike {
  kind: string;
  via?: 'token' | 'cookie' | 'user' | 'dev';
  user?: { platform_role?: string | null } | null;
}

/** Break-glass credentials (Bearer ADMIN_TOKEN and its cookie session) are not a person's account: one shared secret, no individual accountability. */
export const isBreakGlass = (p: AdminLike): boolean => p.kind === 'admin' && (p.via === 'token' || p.via === 'cookie');

/** The role the matrix applies to this principal; null for a non-admin. */
export function adminRoleOf(p: AdminLike): AdminRole | null {
  if (p.kind !== 'admin') return null;
  if (isBreakGlass(p)) return 'bearer';
  if (p.via === 'dev') return 'owner'; // ALLOW_INSECURE_DEV open mode: never in production
  return isPlatformRole(p.user?.platform_role) ? p.user!.platform_role as PlatformRole : 'read_only';
}

export const adminSettingsViaToken = (env: NodeJS.ProcessEnv = configEnv()): boolean => (env.ADMIN_TOKEN_ALLOW_SETTINGS ?? '').trim().toLowerCase() === 'true';

/** Does this ROLE hold the permission (no grant, no principal)? */
export function roleCan(role: AdminRole, permission: Permission, env: NodeJS.ProcessEnv = configEnv()): boolean {
  if (role === 'bearer') return BEARER_BASE.includes(permission) || (BEARER_SETTINGS.includes(permission) && adminSettingsViaToken(env));
  return ROLE_PERMISSIONS[role].has(permission);
}

/** THE permission check for a principal. `grant`: the caller holds an open support write grant for the tenant the action targets. */
export function can(p: AdminLike, permission: Permission, opts: { env?: NodeJS.ProcessEnv; grant?: boolean } = {}): boolean {
  const role = adminRoleOf(p);
  if (!role) return false;
  if (roleCan(role, permission, opts.env)) return true;
  return role === 'support' && opts.grant === true && SUPPORT_WRITE_SCOPE.has(permission);
}

/** Roles that may change the platform_role of another admin: owners only. */
export const canManageRoles = (p: AdminLike): boolean => can(p, 'admins.role');

/** The full matrix (for the contracts doc, the console "roles" page and the tests). */
export function permissionMatrix(env: NodeJS.ProcessEnv = configEnv()): Record<AdminRole, Permission[]> {
  const out = {} as Record<AdminRole, Permission[]>;
  for (const r of [...PLATFORM_ROLES, 'bearer'] as AdminRole[]) out[r] = PERMISSIONS.filter((x) => roleCan(r, x, env));
  return out;
}
