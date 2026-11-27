/**
 * The settings store: validation, tier rules, ratchets, env-pin locks, atomic change sets, revisions, audit, notification, rollback, export / import, freeze and
 * secret helpers. Node runtime only. Every console write of a registry setting goes through `applyChanges`; nothing else touches `platform_settings`.
 *
 * Rules (docs/design/admin-console-contracts.md, section "Settings semantics"):
 *  - env pin > console > default (D1): a key pinned by its environment variable cannot be written (409 locked_by_env).
 *  - tiers: normal = step-up (routes); sensitive = + reason; critical = + typed confirmation + notification to every admin (the secret kind is critical).
 *  - ratchets (D10): a `tighten_only_in_ui` key may only move the safer way (422 ratchet_violation); rolling back a tightening is the same loosening and is refused too.
 *  - pairs: a key with `pairedWith` must travel with its partners (credential pairs) unless the partner is pinned by the environment (409 pair_required).
 *  - a secret is write-only: `secret` plaintext in, fingerprint out; never returned by any function here, never put in an audit row, a revision or a log.
 *  - audit rows are redacted BY KIND (`auditValue`), never through sanitizeAuditMeta.
 */
import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { configEnv, envFromSnapshot, pinnedByEnv, setting, settingSource } from '@/lib/config';
import { allSettings, ENV_ONLY, ratchetAllows, settingDef, defaultContext, defaultOf } from '@/lib/config/registry';
import type { SettingDef, Tier } from '@/lib/config/types';
import { prisma } from '@/lib/db/client';
import { auditRowData } from '@/lib/db/audit';
import { logger } from '@/lib/log';
import { canonicalJson, CANARY_KEY, decryptSetting, encryptSetting, fingerprintOf, last4Of, macPayload, masterKeys, settingMac, type MasterKeys } from './crypto';
import { loaderStarted, refreshNow, snapshotNow } from './loader';
import { notifyAdmins } from './notify';
import { roleCan, adminRoleOf, isBreakGlass, type AdminLike, type AdminRole, type Permission } from './permissions';
import { assertPublicSmtpTarget, smtpTargetOfUrl, SsrfError, type Resolver } from './ssrf';

const log = logger('settings-store');

export const MIN_REASON = 8;
export const MAX_REASON = 500;
export const MAX_SECRET_LENGTH = 8192;
/** Dual-secret acceptance window after a secret is replaced (verifiers accept current AND previous). */
export const DUAL_SECRET_WINDOW_MS = 15 * 60_000;
/** Previous envelopes stay recoverable for rollback this long (D13); the cleanup job nulls them afterwards. */
export const SECRET_ROLLBACK_WINDOW_MS = 7 * 24 * 60 * 60_000;

// ---- errors and actors ----------------------------------------------------------------------------------------------------------------------------

export interface KeyProblem { key: string; code: string; message: string }

export class SettingsError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 422 | 503, readonly code: string, message: string, readonly problems: KeyProblem[] = []) {
    super(message);
    this.name = 'SettingsError';
  }
}

export interface StoreActor {
  kind: 'user' | 'admin_token' | 'system';
  user_id: string | null;
  via: 'console' | 'import' | 'rollback' | 'api' | 'bearer' | 'system';
  role: AdminRole | 'system';
  ip?: string | null;
}

/** Actor of an authenticated admin principal. */
export function actorFromPrincipal(p: AdminLike & { user?: { id: string; platform_role?: string | null } | null }, ip?: string | null): StoreActor {
  const role = adminRoleOf(p);
  if (!role) throw new SettingsError(403, 'forbidden', 'not an admin');
  return { kind: p.user ? 'user' : 'admin_token', user_id: p.user?.id ?? null, via: isBreakGlass(p) ? 'bearer' : 'console', role, ip: ip ?? null };
}
export const systemActor = (): StoreActor => ({ kind: 'system', user_id: null, via: 'system', role: 'system' });

const actorCan = (a: StoreActor, perm: Permission, env?: NodeJS.ProcessEnv): boolean => a.role === 'system' || roleCan(a.role, perm, env);

// ---- freeze ---------------------------------------------------------------------------------------------------------------------------------------

export const frozenByEnv = (env: NodeJS.ProcessEnv = configEnv()): boolean => (env.SETTINGS_FREEZE ?? '').trim().toLowerCase() === 'true';

export interface FreezeState { frozen: boolean; by_env: boolean; frozen_at: string | null; frozen_by: string | null; reason: string | null }

export async function freezeState(db: Prisma.TransactionClient | typeof prisma = prisma, env?: NodeJS.ProcessEnv): Promise<FreezeState> {
  const row = await db.settingsState.findUnique({ where: { id: 1 } });
  const byEnv = frozenByEnv(env);
  return { frozen: byEnv || row?.frozenAt != null, by_env: byEnv, frozen_at: row?.frozenAt?.toISOString() ?? null, frozen_by: row?.frozenBy ?? null, reason: row?.frozenReason ?? null };
}

/** Throws 403 settings_frozen while the console is frozen (env SETTINGS_FREEZE=true or the database flag). Every console write calls it first. */
export async function assertSettingsWritable(db: Prisma.TransactionClient | typeof prisma = prisma, env?: NodeJS.ProcessEnv): Promise<void> {
  if ((await freezeState(db, env)).frozen) throw new SettingsError(403, 'settings_frozen', 'the console is frozen (read-only): unfreeze it or remove SETTINGS_FREEZE');
}

export async function setFrozen(opts: { frozen: boolean; reason: string; actor: StoreActor }): Promise<FreezeState> {
  const reason = (opts.reason ?? '').trim();
  if (reason.length < MIN_REASON) throw new SettingsError(422, 'reason_required', `a reason of at least ${MIN_REASON} characters is required`);
  if (opts.frozen ? !actorCan(opts.actor, 'settings.freeze') : !actorCan(opts.actor, 'settings.unfreeze')) throw new SettingsError(403, 'forbidden', 'not allowed to change the freeze flag');
  if (!opts.frozen && frozenByEnv()) throw new SettingsError(409, 'locked_by_env', 'SETTINGS_FREEZE=true is set in the environment: remove it and restart');
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO settings_state (id, global_version) VALUES (1, 0) ON CONFLICT (id) DO NOTHING`;
    await tx.settingsState.update({
      where: { id: 1 },
      data: opts.frozen ? { frozenAt: new Date(), frozenBy: opts.actor.user_id ?? opts.actor.kind, frozenReason: reason.slice(0, MAX_REASON), updatedAt: new Date() }
        : { frozenAt: null, frozenBy: null, frozenReason: null, updatedAt: new Date() },
    });
    await tx.auditEvent.create({ data: auditRowData({ actor_kind: opts.actor.kind, actor_user_id: opts.actor.user_id, action: opts.frozen ? 'settings.freeze' : 'settings.unfreeze', target: 'settings', ip: opts.actor.ip, meta: { reason: reason.slice(0, MAX_REASON), via: opts.actor.via, role: opts.actor.role }, meta_trusted: true }) });
  });
  void notifyAdmins({ subject: `[Recepcionista] Settings ${opts.frozen ? 'FROZEN' : 'unfrozen'}`, kind: 'freeze', lines: [`Console settings were ${opts.frozen ? 'frozen (all console writes refused)' : 'unfrozen'}.`, `by: ${opts.actor.user_id ?? opts.actor.kind} (${opts.actor.via})`, `reason: ${reason}`] }).catch(() => undefined);
  return freezeState();
}

// ---- values, redaction -----------------------------------------------------------------------------------------------------------------------------

/** A value as it may appear in an audit row / revision / export: BY KIND. Secrets never; URLs lose their credentials; long text is cut. */
export function auditValue(def: Pick<SettingDef, 'kind'>, value: unknown): unknown {
  if (def.kind === 'secret') return '[secret]';
  if (typeof value === 'string') {
    let v = value;
    if (def.kind === 'url') { try { const u = new URL(v); if (u.username || u.password) { u.username = ''; u.password = ''; v = u.toString(); } } catch { /* keep */ } }
    return v.length > 300 ? `${v.slice(0, 300)}…` : v;
  }
  if (Array.isArray(value) && value.length > 50) return [...value.slice(0, 50), `…(+${value.length - 50})`];
  return value;
}

const sameValue = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

// ---- planning --------------------------------------------------------------------------------------------------------------------------------------

export interface SettingChange {
  key: string;
  /** Typed value for a non-secret key (as the schema's `check` expects it). */
  value?: unknown;
  /** Plaintext of a `secret` key (write-only). */
  secret?: string;
  /** Delete the console value: the environment pin or the default applies again. */
  remove?: boolean;
}

export interface ChangePreview {
  key: string;
  label: string;
  kind: SettingDef['kind'];
  tier: Tier;
  op: 'set' | 'remove' | 'noop';
  /** Non-secret: the console value before / after (auditValue). Secret: '[secret]' or null (not set). */
  old: unknown;
  new: unknown;
  old_fingerprint: string | null;
  new_fingerprint: string | null;
  applies: SettingDef['applies'];
  follow_up: SettingDef['followUp'] | null;
  /** Where the effective value comes from today. */
  source_before: 'env' | 'console' | 'default';
}

export interface ApplyOptions {
  changes: SettingChange[];
  reason?: string;
  /** Critical tier: the exact phrase `confirmationPhrase()` returned in the preview. */
  confirm?: string;
  actor: StoreActor;
  /** Optimistic concurrency: the global version the preview was made at; a different current version is a 409 stale_preview. */
  expectedVersion?: number;
  /** Validate and return the preview without writing. */
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  /** Test seam for the SMTP DNS check. */
  resolve?: Resolver;
  /** Rollbacks: the change set being reverted (marked rolled_back in the same transaction). */
  rollbackOf?: string;
  /** Imports: extra writes (plans) in the same transaction. */
  within?: (tx: Prisma.TransactionClient, version: number) => Promise<void>;
  /** Test seam / Phase 4 hook: called with the candidate plaintext of every secret before it is saved (return false to refuse). */
  verifySecret?: (key: string, plaintext: string) => Promise<boolean>;
  /** Permission set the actor needs per key: console writes, rollbacks (recovery) or imports. */
  mode?: 'write' | 'rollback' | 'import';
  /**
   * "Move to console" (Agent A): store, for an environment-PINNED non-secret key, a console value that EQUALS the pinned value (it stays dormant: the pin still wins until the
   * variable is deleted). Any other value for a pinned key is still 409 `locked_by_env`. Secrets are never adopted.
   */
  adopt?: boolean;
}

export interface Preview {
  tier: Tier;
  version: number;
  changes: ChangePreview[];
  requires: { reason: boolean; confirm: string | null; step_up: boolean; notify_admins: boolean };
  warnings: string[];
}

export const confirmationPhrase = (keys: string[]): string => (keys.length === 1 ? keys[0] : `apply ${keys.length} critical settings`);

const TIER_RANK: Record<Tier, number> = { normal: 0, sensitive: 1, critical: 2 };
const SMTP_KEYS = new Set(['email.smtp_host', 'email.smtp_port', 'email.smtp_url']);

interface Planned {
  def: SettingDef;
  change: SettingChange;
  op: 'set' | 'remove' | 'noop';
  row: Awaited<ReturnType<typeof prisma.platformSetting.findMany>>[number] | null;
  newValue?: unknown;
  newSecret?: string;
}

const permFor = (def: SettingDef, mode: 'write' | 'rollback' | 'import'): Permission =>
  mode === 'rollback' ? (def.tier === 'critical' || def.kind === 'secret' ? 'settings.rollback.critical' : 'settings.rollback')
    : def.kind === 'secret' ? 'settings.secrets.write' : def.tier === 'critical' ? 'settings.write.critical' : 'settings.write';

async function plan(opts: ApplyOptions, db: Prisma.TransactionClient | typeof prisma, skipNet = false): Promise<{ planned: Planned[]; tier: Tier; problems: KeyProblem[]; warnings: string[]; keys: MasterKeys | null }> {
  const problems: KeyProblem[] = [];
  const warnings: string[] = [];
  const mode = opts.mode ?? 'write';
  if (!Array.isArray(opts.changes) || opts.changes.length === 0) throw new SettingsError(422, 'nothing_to_change', 'no changes given');
  if (opts.changes.length > 100) throw new SettingsError(422, 'too_many_changes', 'at most 100 keys per change set');
  const keysIn = opts.changes.map((c) => c?.key);
  const rows = await db.platformSetting.findMany({ where: { key: { in: keysIn.filter((k): k is string => typeof k === 'string') } } });
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const seen = new Set<string>();
  const planned: Planned[] = [];
  let keys: MasterKeys | null = null;
  const getKeys = () => (keys ??= masterKeys());
  if (mode === 'import' && !actorCan(opts.actor, 'settings.import', opts.env)) problems.push({ key: '*', code: 'forbidden', message: 'importing settings needs the settings.import permission' });
  for (const change of opts.changes) {
    const key = change?.key;
    if (typeof key !== 'string' || !key) { problems.push({ key: String(key), code: 'unknown_key', message: 'key is required' }); continue; }
    if (seen.has(key)) { problems.push({ key, code: 'duplicate_key', message: 'a key may appear once per change set' }); continue; }
    seen.add(key);
    const def = key === CANARY_KEY ? undefined : settingDef(key);
    if (!def) {
      const envOnly = ENV_ONLY.some((e) => e.name === key);
      problems.push({ key, code: envOnly ? 'env_only' : 'unknown_key', message: envOnly ? 'this name is environment-only and cannot be set from the console' : 'unknown setting' });
      continue;
    }
    if (def.envOnlyLoosen) { problems.push({ key, code: 'env_only', message: 'this key is an environment-only ratchet: only the environment may set it' }); continue; }
    if (!actorCan(opts.actor, permFor(def, mode), opts.env)) {
      problems.push({ key, code: 'forbidden', message: `your role cannot ${mode === 'rollback' ? 'roll back' : 'write'} ${def.kind === 'secret' ? 'secrets' : def.tier === 'critical' ? 'critical settings' : 'settings'}${opts.actor.via === 'bearer' ? ' with the break-glass token (set ADMIN_TOKEN_ALLOW_SETTINGS=true to allow it)' : ''}` });
      continue;
    }
    let adoptOf: unknown;
    if (def.env && pinnedByEnv(def.env, opts.env)) {
      const raw = (opts.env ?? configEnv())[def.env] ?? '';
      const parsedPin = opts.adopt === true && def.kind !== 'secret' && change.remove !== true ? def.schema.fromText(raw) : null;
      if (!parsedPin || !parsedPin.ok) { problems.push({ key, code: 'locked_by_env', message: `locked by the environment variable ${def.env}: change or remove it in the environment` }); continue; }
      adoptOf = parsedPin.value;
    }
    const row = byKey.get(key) ?? null;
    if (change.remove === true) {
      if (change.value !== undefined || change.secret !== undefined) { problems.push({ key, code: 'invalid_change', message: 'remove cannot carry a value' }); continue; }
      planned.push({ def, change, op: row ? 'remove' : 'noop', row });
      continue;
    }
    if (def.kind === 'secret') {
      if (change.value !== undefined) { problems.push({ key, code: 'use_secret_field', message: 'a secret is sent in the `secret` field' }); continue; }
      if (typeof change.secret !== 'string' || change.secret.length === 0) { problems.push({ key, code: 'invalid_value', message: 'secret must be a non-empty string' }); continue; }
      if (change.secret.length > MAX_SECRET_LENGTH || /[\u0000\r\n]/.test(change.secret)) { problems.push({ key, code: 'invalid_value', message: 'secret has an invalid length or contains control characters' }); continue; }
      const chk = def.schema.check(change.secret);
      if (!chk.ok) { problems.push({ key, code: 'invalid_value', message: 'secret is not in the expected format' }); continue; } // never echo the input
      let same = false;
      if (row?.secretEnvelope) { try { same = decryptSetting(row.secretEnvelope, key, getKeys()) === change.secret; } catch { same = false; } }
      planned.push({ def, change, op: same ? 'noop' : 'set', row, newSecret: change.secret });
      continue;
    }
    if (change.secret !== undefined) { problems.push({ key, code: 'invalid_value', message: 'only secret keys take a `secret`' }); continue; }
    if (change.value === undefined) { problems.push({ key, code: 'invalid_value', message: 'value is required (or remove: true)' }); continue; }
    const chk = def.schema.check(change.value);
    if (!chk.ok) { problems.push({ key, code: 'invalid_value', message: chk.error }); continue; }
    if (chk.value === null || chk.value === undefined) { problems.push({ key, code: 'invalid_value', message: 'null is not a value: use remove' }); continue; }
    if (adoptOf !== undefined && !sameValue(adoptOf, chk.value)) { problems.push({ key, code: 'locked_by_env', message: `locked by the environment variable ${def.env}: only the value the environment already holds can be copied to the console` }); continue; }
    planned.push({ def, change, op: row && sameValue(row.value, chk.value) ? 'noop' : 'set', row, newValue: chk.value });
  }
  // ratchets: compare the console value (or the default) with the target
  const ctx = defaultContext(configEnv().NODE_ENV);
  for (const p of planned) {
    if (p.op === 'noop' || !p.def.ratchet) continue;
    const from = p.row?.value ?? defaultOf(p.def, ctx);
    const to = p.op === 'remove' ? defaultOf(p.def, ctx) : p.newValue;
    if (!ratchetAllows(p.def, from, to)) problems.push({ key: p.def.key, code: 'ratchet_violation', message: 'this setting may only be made stricter from the console; loosening needs the environment variable' });
  }
  // credential pairs
  const inSet = new Set(planned.map((p) => p.def.key));
  for (const p of planned) {
    if (p.op === 'noop' || p.op === 'remove') continue;
    for (const partner of p.def.pairedWith ?? []) {
      if (inSet.has(partner)) continue;
      const pd = settingDef(partner);
      if (pd?.env && pinnedByEnv(pd.env, opts.env)) continue;
      problems.push({ key: p.def.key, code: 'pair_required', message: `must be changed together with ${partner} (send both, unchanged values included)` });
    }
  }
  // the SMTP relay (SSRF): the resulting host and port must be public and on an SMTP port
  if (!skipNet && planned.some((p) => SMTP_KEYS.has(p.def.key) && p.op === 'set')) {
    const eff = (k: 'email.smtp_host' | 'email.smtp_port') => {
      const p = planned.find((x) => x.def.key === k);
      return p ? (p.op === 'remove' ? null : p.newValue) : setting(k);
    };
    const urlP = planned.find((x) => x.def.key === 'email.smtp_url');
    const url = urlP?.op === 'set' ? urlP.newSecret : urlP?.op === 'remove' ? '' : (snapshotNow()?.secret('email.smtp_url') ?? '');
    try {
      if (url) { const t = smtpTargetOfUrl(url); if (!t) throw new SsrfError('invalid SMTP URL', 'bad_host'); await assertPublicSmtpTarget(t.host, t.port, opts.resolve); }
      const host = eff('email.smtp_host') as string | null;
      if (host) await assertPublicSmtpTarget(host, (eff('email.smtp_port') as number | null) ?? 587, opts.resolve);
    } catch (err) {
      if (!(err instanceof SsrfError)) throw err;
      problems.push({ key: planned.find((x) => SMTP_KEYS.has(x.def.key) && x.op === 'set')!.def.key, code: 'smtp_target_refused', message: err.message });
    }
  }
  if (opts.verifySecret && !skipNet) {
    for (const p of planned) if (p.op === 'set' && p.def.kind === 'secret' && p.newSecret && !(await opts.verifySecret(p.def.key, p.newSecret))) problems.push({ key: p.def.key, code: 'verification_failed', message: 'the new secret did not pass its connection test' });
  }
  let tier: Tier = 'normal';
  for (const p of planned) if (TIER_RANK[p.def.tier] > TIER_RANK[tier]) tier = p.def.tier;
  return { planned, tier, problems, warnings, keys };
}

function previewOf(planned: Planned[], env?: NodeJS.ProcessEnv): ChangePreview[] {
  void env;
  return planned.map((p) => {
    const secret = p.def.kind === 'secret';
    return {
      key: p.def.key, label: p.def.label, kind: p.def.kind, tier: p.def.tier, op: p.op,
      old: secret ? (p.row?.secretEnvelope ? '[secret]' : null) : p.row ? auditValue(p.def, p.row.value) : null,
      new: p.op === 'remove' ? null : secret ? '[secret]' : p.op === 'noop' ? (p.row ? auditValue(p.def, p.row.value) : null) : auditValue(p.def, p.newValue),
      old_fingerprint: p.row?.secretFingerprint ?? null,
      new_fingerprint: p.op === 'set' && p.newSecret ? fingerprintOf(p.newSecret) : p.op === 'noop' ? p.row?.secretFingerprint ?? null : null,
      applies: p.def.applies, follow_up: p.def.followUp ?? null,
      source_before: settingSource(p.def.key as never),
    };
  });
}

function statusOf(problems: KeyProblem[]): 403 | 409 | 422 {
  if (problems.some((p) => p.code === 'forbidden')) return 403;
  if (problems.some((p) => p.code === 'locked_by_env' || p.code === 'pair_required')) return 409;
  return 422;
}

async function currentVersion(db: Prisma.TransactionClient | typeof prisma): Promise<number> {
  const row = await db.settingsState.findUnique({ where: { id: 1 }, select: { globalVersion: true } });
  return Number(row?.globalVersion ?? 0);
}

/** Validate a change set and say what applying it would do and require. Writes nothing. */
export async function previewChanges(opts: ApplyOptions): Promise<Preview> {
  const { planned, tier, problems, warnings } = await plan(opts, prisma);
  if (problems.length) throw new SettingsError(statusOf(problems), problems[0].code, problems[0].message, problems);
  const live = planned.filter((p) => p.op !== 'noop');
  return {
    tier, version: await currentVersion(prisma), changes: previewOf(planned, opts.env), warnings,
    requires: {
      reason: TIER_RANK[tier] >= 1 || opts.mode === 'rollback', confirm: tier === 'critical' ? confirmationPhrase(live.map((p) => p.def.key)) : null,
      step_up: true, notify_admins: tier === 'critical',
    },
  };
}

export interface ApplyResult {
  change_set_id: string | null;
  version: number;
  tier: Tier;
  changes: ChangePreview[];
  /** True when nothing changed (every key already had that value): no change set was written. */
  noop: boolean;
  notified: { recipients: number; sent: number; failed: number } | null;
}

/** Apply a change set atomically. See the module comment for the rules; throws SettingsError. */
export async function applyChanges(opts: ApplyOptions): Promise<ApplyResult> {
  const env = opts.env;
  await assertSettingsWritable(prisma, env);
  const reason = (opts.reason ?? '').trim();
  const before = snapshotNow();
  const tierPre = await plan(opts, prisma);
  if (tierPre.problems.length) throw new SettingsError(statusOf(tierPre.problems), tierPre.problems[0].code, tierPre.problems[0].message, tierPre.problems);
  const live0 = tierPre.planned.filter((p) => p.op !== 'noop');
  if (live0.length === 0) return { change_set_id: null, version: await currentVersion(prisma), tier: tierPre.tier, changes: previewOf(tierPre.planned, env), noop: true, notified: null };
  const tier = live0.reduce<Tier>((t, p) => (TIER_RANK[p.def.tier] > TIER_RANK[t] ? p.def.tier : t), 'normal');
  if ((TIER_RANK[tier] >= 1 || opts.mode === 'rollback') && (reason.length < MIN_REASON || reason.length > MAX_REASON)) throw new SettingsError(422, 'reason_required', `a reason of ${MIN_REASON} to ${MAX_REASON} characters is required for this change`);
  if (tier === 'critical' && (opts.confirm ?? '').trim() !== confirmationPhrase(live0.map((p) => p.def.key))) throw new SettingsError(422, 'confirmation_required', `type the confirmation phrase exactly: ${confirmationPhrase(live0.map((p) => p.def.key))}`);
  if (opts.dryRun) return { change_set_id: null, version: await currentVersion(prisma), tier, changes: previewOf(tierPre.planned, env), noop: false, notified: null };

  const keys = masterKeys();
  const now = opts.now ?? new Date();
  const out = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO settings_state (id, global_version) VALUES (1, 0) ON CONFLICT (id) DO NOTHING`;
    const [{ global_version }] = await tx.$queryRaw<{ global_version: bigint }[]>`SELECT global_version FROM settings_state WHERE id = 1 FOR UPDATE`;
    await assertSettingsWritable(tx, env); // re-checked under the lock
    if (opts.expectedVersion !== undefined && Number(global_version) !== opts.expectedVersion) throw new SettingsError(409, 'stale_preview', 'settings changed since the preview was made: review again');
    const p2 = await plan(opts, tx, true); // re-planned against the rows as they are now, under the lock
    if (p2.problems.length) throw new SettingsError(statusOf(p2.problems), p2.problems[0].code, p2.problems[0].message, p2.problems);
    const live = p2.planned.filter((p) => p.op !== 'noop');
    if (live.length === 0) return null;
    const version = Number(global_version) + 1;
    const csId = crypto.randomUUID();
    await tx.settingsState.update({ where: { id: 1 }, data: { globalVersion: BigInt(version), updatedAt: now } });
    await tx.settingChangeSet.create({
      data: {
        id: csId, status: 'applied', createdBy: opts.actor.user_id, createdKind: opts.actor.kind, via: opts.actor.via, reason: reason || null, tier, version: BigInt(version),
        rollbackOf: opts.rollbackOf ?? null, summary: { keys: live.map((p) => p.def.key), set: live.filter((p) => p.op === 'set').length, removed: live.filter((p) => p.op === 'remove').length, role: opts.actor.role } as object, at: now,
      },
    });
    const auditKeys: Record<string, unknown>[] = [];
    for (const p of live) {
      const key = p.def.key;
      const secret = p.def.kind === 'secret';
      let newFp: string | null = null;
      if (p.op === 'remove') {
        await tx.platformSetting.deleteMany({ where: { key } });
      } else if (secret) {
        const envelope = encryptSetting(p.newSecret as string, key, keys);
        newFp = fingerprintOf(p.newSecret as string);
        const data = {
          value: Prisma.DbNull, secretEnvelope: envelope, secretFingerprint: newFp, secretLast4: last4Of(p.newSecret as string),
          previousEnvelope: p.row?.secretEnvelope ?? null, previousUntil: p.row?.secretEnvelope ? new Date(now.getTime() + DUAL_SECRET_WINDOW_MS) : null,
          version: BigInt(version), integrityMac: settingMac(key, macPayload({ secretEnvelope: envelope }), version, keys), updatedBy: opts.actor.user_id, updatedVia: opts.actor.via, updatedAt: now,
        };
        await tx.platformSetting.upsert({ where: { key }, create: { key, ...data }, update: data });
      } else {
        const data = {
          value: p.newValue as Prisma.InputJsonValue, secretEnvelope: null, secretFingerprint: null, secretLast4: null, previousEnvelope: null, previousUntil: null,
          version: BigInt(version), integrityMac: settingMac(key, macPayload({ value: p.newValue }), version, keys), updatedBy: opts.actor.user_id, updatedVia: opts.actor.via, updatedAt: now,
        };
        await tx.platformSetting.upsert({ where: { key }, create: { key, ...data }, update: data });
      }
      await tx.platformSettingRevision.create({
        data: {
          changeSetId: csId, key, op: p.op === 'remove' ? 'remove' : 'set', oldPresent: p.row !== null,
          oldValue: secret || !p.row ? Prisma.DbNull : (p.row.value as Prisma.InputJsonValue), // the REAL value: a rollback restores it (the audit row carries the redacted form)
          newValue: secret || p.op === 'remove' ? Prisma.DbNull : (p.newValue as Prisma.InputJsonValue),
          oldFingerprint: p.row?.secretFingerprint ?? null, newFingerprint: newFp, prevEnvelope: secret ? p.row?.secretEnvelope ?? null : null,
          actorUserId: opts.actor.user_id, actorKind: opts.actor.kind, reason: reason || null, ip: opts.actor.ip ?? null, at: now,
        },
      });
      auditKeys.push({
        key, kind: p.def.kind, tier: p.def.tier, op: p.op,
        ...(secret ? { old_fp: p.row?.secretFingerprint ?? null, new_fp: newFp } : { old: p.row ? auditValue(p.def, p.row.value) : null, new: p.op === 'remove' ? null : auditValue(p.def, p.newValue) }),
      });
    }
    if (secret_any(live)) await tx.platformSetting.createMany({ data: [{ key: CANARY_KEY, secretEnvelope: encryptSetting('rc-canary-v1', CANARY_KEY, keys), integrityMac: '-', updatedVia: 'system' }], skipDuplicates: true });
    if (opts.rollbackOf) await tx.settingChangeSet.update({ where: { id: opts.rollbackOf }, data: { status: 'rolled_back' } });
    if (opts.within) await opts.within(tx, version);
    await tx.auditEvent.create({
      data: auditRowData({
        actor_kind: opts.actor.kind, actor_user_id: opts.actor.user_id, action: opts.rollbackOf ? 'settings.rollback' : 'settings.change', target: `change_set:${csId}`, ip: opts.actor.ip, at: now,
        meta: { change_set_id: csId, version, tier, reason: reason || null, via: opts.actor.via, role: opts.actor.role, ...(opts.rollbackOf ? { rollback_of: opts.rollbackOf } : {}), keys: auditKeys },
        meta_trusted: true,
      }),
    });
    return { csId, version, live, planned: p2.planned, tier: live.reduce<Tier>((t, p) => (TIER_RANK[p.def.tier] > TIER_RANK[t] ? p.def.tier : t), 'normal') };
  }, { timeout: 20_000, maxWait: 10_000 });

  if (!out) return { change_set_id: null, version: await currentVersion(prisma), tier, changes: previewOf(tierPre.planned, env), noop: true, notified: null };
  if (loaderStarted()) await refreshNow(); // the writer applies its own change at once; other instances pick it up within 10 s
  let notified: ApplyResult['notified'] = null;
  if (out.tier === 'critical') {
    notified = await notifyAdmins({
      subject: `[Recepcionista] Critical settings change: ${out.live.map((p) => p.def.key).slice(0, 4).join(', ')}${out.live.length > 4 ? ', …' : ''}`,
      kind: 'critical_change', transportEnv: envFromSnapshot(before),
      lines: [
        `A critical-tier change set was applied (version ${out.version}).`, `by: ${opts.actor.user_id ?? opts.actor.kind} (${opts.actor.role}, via ${opts.actor.via})`,
        `keys: ${out.live.map((p) => `${p.def.key}${p.def.kind === 'secret' ? ' (secret)' : ''}`).join(', ')}`, `reason: ${reason}`, `change set: ${out.csId}`,
        'Secrets are never included in this message. Roll back from the console (change history) if this was not expected.',
      ],
    }).catch((err) => { log.error('notify_failed', { error: (err as Error).message }); return null; });
  }
  return { change_set_id: out.csId, version: out.version, tier: out.tier, changes: previewOf(out.planned, env), noop: false, notified };
}

const secret_any = (live: Planned[]): boolean => live.some((p) => p.def.kind === 'secret' && p.op === 'set');

// ---- secrets --------------------------------------------------------------------------------------------------------------------------------------

export interface SecretInfo {
  key: string;
  set: boolean;
  /** Where the effective secret comes from: the environment pin, the console, or nowhere. */
  source: 'env' | 'console' | 'none';
  fingerprint?: string | null;
  last4?: string | null;
  updated_at?: string | null;
  updated_by?: string | null;
  /** The previous value is still accepted by verifiers (dual-secret window). */
  previous_accepted_until?: string | null;
  can_rollback?: boolean;
}

/** Everything the console may show about a secret. NEVER the value. `revealMeta` false (read-only role) hides the fingerprint and who/when. */
export async function secretInfo(key: string, opts: { revealMeta?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<SecretInfo> {
  const def = settingDef(key);
  if (!def || def.kind !== 'secret') throw new SettingsError(404, 'unknown_key', 'not a secret setting');
  const reveal = opts.revealMeta !== false;
  if (def.env && pinnedByEnv(def.env, opts.env)) return { key, set: true, source: 'env' };
  const row = await prisma.platformSetting.findUnique({ where: { key } });
  if (!row?.secretEnvelope) return { key, set: false, source: 'none' };
  const out: SecretInfo = { key, set: true, source: 'console' };
  if (reveal) {
    out.fingerprint = row.secretFingerprint; out.last4 = row.secretLast4; out.updated_at = row.updatedAt.toISOString(); out.updated_by = row.updatedBy;
    out.previous_accepted_until = row.previousUntil && row.previousUntil.getTime() > Date.now() ? row.previousUntil.toISOString() : null;
  }
  return out;
}

/** Replace (or first set) a secret; `paired` carries its credential partners (id + secret in one change set). */
export function setSecret(opts: { key: string; value: string; paired?: Record<string, string>; reason: string; confirm?: string; actor: StoreActor; env?: NodeJS.ProcessEnv; verifySecret?: ApplyOptions['verifySecret']; resolve?: Resolver }): Promise<ApplyResult> {
  if (settingDef(opts.key)?.kind !== 'secret') throw new SettingsError(404, 'unknown_key', 'not a secret setting');
  const changes: SettingChange[] = [{ key: opts.key, secret: opts.value }];
  for (const [k, v] of Object.entries(opts.paired ?? {})) changes.push(settingDef(k)?.kind === 'secret' ? { key: k, secret: v } : { key: k, value: v });
  return applyChanges({ changes, reason: opts.reason, confirm: opts.confirm, actor: opts.actor, env: opts.env, verifySecret: opts.verifySecret, resolve: opts.resolve });
}
export function removeSecret(opts: { key: string; reason: string; confirm?: string; actor: StoreActor; env?: NodeJS.ProcessEnv }): Promise<ApplyResult> {
  if (settingDef(opts.key)?.kind !== 'secret') throw new SettingsError(404, 'unknown_key', 'not a secret setting');
  return applyChanges({ changes: [{ key: opts.key, remove: true }], reason: opts.reason, confirm: opts.confirm, actor: opts.actor, env: opts.env });
}

// ---- listing ---------------------------------------------------------------------------------------------------------------------------------------

export interface SettingView {
  key: string; env: string | null; group: string; label: string; help: string; kind: SettingDef['kind']; class: SettingDef['class']; tier: Tier; scope: SettingDef['scope'];
  applies: SettingDef['applies']; follow_up: SettingDef['followUp'] | null; ratchet: SettingDef['ratchet'] | null; tighten_is: SettingDef['tightenIs'] | null;
  paired_with: readonly string[]; unit: SettingDef['unit'] | null; schema: Record<string, unknown>; tenant: SettingDef['tenant'] | null;
  source: 'env' | 'console' | 'default'; locked: boolean; locked_reason: 'env' | 'env_only' | null; env_invalid: boolean;
  /** Effective non-secret value (null for secrets and unset). */
  value: unknown; default: unknown; console_value: unknown | null; version: number | null; updated_at: string | null; updated_by: string | null;
  secret: SecretInfo | null;
}

/** The registry with the effective value, its source and the lock state of every key (secrets: metadata only). */
export async function describeSettings(opts: { revealSecretMeta?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<{ version: number; frozen: FreezeState; settings: SettingView[] }> {
  const [rows, version, frozen] = await Promise.all([prisma.platformSetting.findMany(), currentVersion(prisma), freezeState(prisma, opts.env)]);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const ctx = defaultContext(configEnv().NODE_ENV);
  const settings = allSettings().map((def): SettingView => {
    const row = byKey.get(def.key) ?? null;
    const pinned = Boolean(def.env && pinnedByEnv(def.env, opts.env));
    const secret = def.kind === 'secret';
    const source = settingSource(def.key as never);
    const envPinInvalid = pinned && source !== 'env';
    return {
      key: def.key, env: def.env ?? null, group: def.group, label: def.label, help: def.help, kind: def.kind, class: def.class, tier: def.tier, scope: def.scope, applies: def.applies,
      follow_up: def.followUp ?? null, ratchet: def.ratchet ?? null, tighten_is: def.tightenIs ?? null, paired_with: def.pairedWith ?? [], unit: def.unit ?? null,
      schema: { type: def.schema.type, ...def.schema.info }, tenant: def.tenant ?? null,
      source, locked: pinned || Boolean(def.envOnlyLoosen), locked_reason: pinned ? 'env' : def.envOnlyLoosen ? 'env_only' : null, env_invalid: envPinInvalid,
      value: secret ? null : setting(def.key as never), default: secret ? null : defaultOf(def, ctx), console_value: secret ? null : row?.value ?? null,
      version: row ? Number(row.version) : null, updated_at: row?.updatedAt.toISOString() ?? null, updated_by: opts.revealSecretMeta === false && secret ? null : row?.updatedBy ?? null,
      secret: secret ? secretInfoFrom(def, row, pinned, opts.revealSecretMeta !== false) : null,
    };
  });
  return { version, frozen, settings };
}

function secretInfoFrom(def: SettingDef, row: { secretEnvelope: string | null; secretFingerprint: string | null; secretLast4: string | null; updatedAt: Date; updatedBy: string | null; previousUntil: Date | null } | null, pinned: boolean, reveal: boolean): SecretInfo {
  if (pinned) return { key: def.key, set: true, source: 'env' };
  if (!row?.secretEnvelope) return { key: def.key, set: false, source: 'none' };
  return reveal
    ? { key: def.key, set: true, source: 'console', fingerprint: row.secretFingerprint, last4: row.secretLast4, updated_at: row.updatedAt.toISOString(), updated_by: row.updatedBy, previous_accepted_until: row.previousUntil && row.previousUntil.getTime() > Date.now() ? row.previousUntil.toISOString() : null }
    : { key: def.key, set: true, source: 'console' };
}

// ---- history and rollback --------------------------------------------------------------------------------------------------------------------------

export interface ChangeSetView {
  id: string; at: string; status: string; tier: string; version: number; via: string; reason: string | null; created_by: string | null; created_kind: string; rollback_of: string | null;
  keys: string[];
  revisions?: { key: string; op: string; old_present: boolean; old: unknown; new: unknown; old_fingerprint: string | null; new_fingerprint: string | null; can_rollback_secret: boolean }[];
}

export async function listChangeSets(opts: { limit?: number; before?: string; key?: string } = {}): Promise<{ items: ChangeSetView[]; next_cursor: string | null }> {
  const take = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const cur = opts.before ? Number(opts.before) : null;
  const rows = await prisma.settingChangeSet.findMany({
    where: { ...(cur !== null && Number.isFinite(cur) ? { version: { lt: BigInt(cur) } } : {}), ...(opts.key ? { revisions: { some: { key: opts.key } } } : {}) },
    orderBy: { version: 'desc' }, take: take + 1,
  });
  const page = rows.slice(0, take);
  return {
    items: page.map((r) => ({
      id: r.id, at: r.at.toISOString(), status: r.status, tier: r.tier, version: Number(r.version), via: r.via, reason: r.reason, created_by: r.createdBy, created_kind: r.createdKind, rollback_of: r.rollbackOf,
      keys: ((r.summary as { keys?: string[] } | null)?.keys ?? []),
    })),
    next_cursor: rows.length > take ? String(Number(page[page.length - 1].version)) : null,
  };
}

export async function getChangeSet(id: string): Promise<ChangeSetView | null> {
  const r = await prisma.settingChangeSet.findUnique({ where: { id }, include: { revisions: { orderBy: { key: 'asc' } } } });
  if (!r) return null;
  const now = Date.now();
  return {
    id: r.id, at: r.at.toISOString(), status: r.status, tier: r.tier, version: Number(r.version), via: r.via, reason: r.reason, created_by: r.createdBy, created_kind: r.createdKind, rollback_of: r.rollbackOf,
    keys: r.revisions.map((x) => x.key),
    revisions: r.revisions.map((x) => ({
      key: x.key, op: x.op, old_present: x.oldPresent, old: x.oldValue, new: x.newValue, old_fingerprint: x.oldFingerprint, new_fingerprint: x.newFingerprint,
      can_rollback_secret: x.prevEnvelope !== null && now - x.at.getTime() < SECRET_ROLLBACK_WINDOW_MS,
    })),
  };
}

/**
 * Roll a change set back by applying its inverse as a NEW change set (history is never rewritten). Refused when a key was changed again afterwards
 * (409 superseded: roll that one back first), when a secret's previous envelope is older than 7 days (409 secret_rollback_expired), and for any key whose
 * inverse is a ratchet loosening or is locked by the environment.
 */
export async function rollbackChangeSet(opts: { id: string; reason: string; confirm?: string; actor: StoreActor; keys?: string[]; env?: NodeJS.ProcessEnv; verifySecret?: ApplyOptions['verifySecret'] }): Promise<ApplyResult> {
  if (!actorCan(opts.actor, 'settings.rollback', opts.env)) throw new SettingsError(403, 'forbidden', 'not allowed to roll back settings');
  const cs = await prisma.settingChangeSet.findUnique({ where: { id: opts.id }, include: { revisions: true } });
  if (!cs) throw new SettingsError(404, 'not_found', 'change set not found');
  if (cs.status !== 'applied') throw new SettingsError(409, 'not_rollbackable', `change set is ${cs.status}`);
  const revs = cs.revisions.filter((r) => !opts.keys || opts.keys.includes(r.key));
  if (revs.length === 0) throw new SettingsError(422, 'nothing_to_change', 'no matching keys in this change set');
  const rows = await prisma.platformSetting.findMany({ where: { key: { in: revs.map((r) => r.key) } } });
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const keys = masterKeys();
  const problems: KeyProblem[] = [];
  const changes: SettingChange[] = [];
  for (const r of revs) {
    const def = settingDef(r.key);
    if (!def) { problems.push({ key: r.key, code: 'unknown_key', message: 'setting no longer exists' }); continue; }
    const row = byKey.get(r.key) ?? null;
    const secret = def.kind === 'secret';
    // the current state must still be what this change set left behind
    const current = secret ? (row?.secretFingerprint ?? null) : row ? canonicalJson(row.value) : null;
    const expected = r.op === 'remove' ? null : secret ? r.newFingerprint : canonicalJson(r.newValue);
    if (current !== expected) { problems.push({ key: r.key, code: 'superseded', message: 'changed again since this change set: roll back the later change first' }); continue; }
    if (!r.oldPresent) { changes.push({ key: r.key, remove: true }); continue; }
    if (secret) {
      if (!r.prevEnvelope || Date.now() - r.at.getTime() >= SECRET_ROLLBACK_WINDOW_MS) { problems.push({ key: r.key, code: 'secret_rollback_expired', message: 'the previous secret is no longer retained (7 days)' }); continue; }
      try { changes.push({ key: r.key, secret: decryptSetting(r.prevEnvelope, r.key, keys) }); } catch { problems.push({ key: r.key, code: 'secret_rollback_expired', message: 'the previous secret can no longer be decrypted' }); }
      continue;
    }
    changes.push({ key: r.key, value: r.oldValue });
  }
  if (problems.length) throw new SettingsError(409, problems[0].code, problems[0].message, problems);
  const everything = !opts.keys || revs.length === cs.revisions.length;
  return applyChanges({ changes, reason: opts.reason, confirm: opts.confirm, actor: { ...opts.actor, via: opts.actor.via === 'bearer' ? 'bearer' : 'rollback' }, env: opts.env, mode: 'rollback', rollbackOf: everything ? cs.id : undefined, verifySecret: opts.verifySecret });
}

// ---- export / import (non-secret only) -------------------------------------------------------------------------------------------------------------

export const EXPORT_SCHEMA_VERSION = 1;

export interface ExportDoc {
  schema_version: number;
  exported_at: string;
  settings_version: number;
  /** Console-held non-secret values by registry key. */
  settings: Record<string, unknown>;
  /** Fingerprints of console-held secrets (so an import can warn "secret differs"); never values. */
  secret_fingerprints: Record<string, string>;
  plans: Record<string, unknown>[];
}

export async function exportSettings(): Promise<ExportDoc> {
  const [rows, version, plans] = await Promise.all([prisma.platformSetting.findMany({ orderBy: { key: 'asc' } }), currentVersion(prisma), prisma.plan.findMany({ orderBy: [{ sort: 'asc' }, { key: 'asc' }] })]);
  const settings: Record<string, unknown> = {};
  const secret_fingerprints: Record<string, string> = {};
  for (const r of rows) {
    const def = settingDef(r.key);
    if (!def || r.key === CANARY_KEY) continue;
    if (def.kind === 'secret') { if (r.secretFingerprint) secret_fingerprints[r.key] = r.secretFingerprint; continue; }
    settings[r.key] = r.value;
  }
  return {
    schema_version: EXPORT_SCHEMA_VERSION, exported_at: new Date().toISOString(), settings_version: version, settings, secret_fingerprints,
    plans: plans.map((p) => ({
      key: p.key, name: p.name, public: p.public, is_comped: p.isComped, stripe_price_id: p.stripePriceId, stripe_price_id_annual: p.stripePriceIdAnnual, trial_days: p.trialDays, sms_cap: p.smsCap,
      call_minutes_cap: p.callMinutesCap, voicemail_minutes_cap: p.voicemailMinutesCap, forward_minutes_cap: p.forwardMinutesCap, max_locations: p.maxLocations, features: p.features, sort: p.sort,
      archived_at: p.archivedAt?.toISOString() ?? null,
    })),
  };
}

export interface ImportPlan {
  changes: SettingChange[];
  /** Per key: what the import would do. */
  diff: { key: string; op: 'set' | 'remove' | 'noop' | 'skip'; reason?: string; old?: unknown; new?: unknown }[];
  warnings: string[];
  plans: { create: string[]; update: string[]; unchanged: string[] };
}

/** Turn an export document into a change list plus a human diff (a dry run); locked, secret, unknown and invalid keys are reported, never applied. */
export async function planImport(doc: unknown, opts: { env?: NodeJS.ProcessEnv } = {}): Promise<ImportPlan> {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new SettingsError(422, 'invalid_document', 'expected a JSON object');
  const d = doc as Partial<ExportDoc>;
  if (d.schema_version !== EXPORT_SCHEMA_VERSION) throw new SettingsError(422, 'unsupported_schema_version', `schema_version must be ${EXPORT_SCHEMA_VERSION}`);
  if (!d.settings || typeof d.settings !== 'object' || Array.isArray(d.settings)) throw new SettingsError(422, 'invalid_document', 'settings must be an object');
  const rows = await prisma.platformSetting.findMany();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const out: ImportPlan = { changes: [], diff: [], warnings: [], plans: { create: [], update: [], unchanged: [] } };
  for (const [key, raw] of Object.entries(d.settings)) {
    const def = settingDef(key);
    if (!def || key === CANARY_KEY) { out.diff.push({ key, op: 'skip', reason: 'unknown_key' }); continue; }
    if (def.kind === 'secret') { out.diff.push({ key, op: 'skip', reason: 'secret_not_importable' }); out.warnings.push(`${key}: secrets are never imported (set it through the secret endpoint)`); continue; }
    if (def.env && pinnedByEnv(def.env, opts.env)) { out.diff.push({ key, op: 'skip', reason: 'locked_by_env' }); continue; }
    const chk = def.schema.check(raw);
    if (!chk.ok || chk.value === null) { out.diff.push({ key, op: 'skip', reason: `invalid_value: ${chk.ok ? 'null' : chk.error}` }); continue; }
    const row = byKey.get(key);
    if (row && sameValue(row.value, chk.value)) { out.diff.push({ key, op: 'noop' }); continue; }
    out.diff.push({ key, op: 'set', old: row ? auditValue(def, row.value) : null, new: auditValue(def, chk.value) });
    out.changes.push({ key, value: chk.value });
  }
  for (const [key, fp] of Object.entries(d.secret_fingerprints ?? {})) {
    const row = byKey.get(key);
    if (row?.secretFingerprint && row.secretFingerprint !== fp) out.warnings.push(`${key}: the secret in this environment differs from the exported one (fingerprints differ)`);
    if (!row?.secretEnvelope) out.warnings.push(`${key}: the export had a secret that is not set here`);
  }
  const existing = new Map((await prisma.plan.findMany()).map((p) => [p.key, p]));
  for (const p of Array.isArray(d.plans) ? d.plans : []) {
    const k = (p as { key?: unknown })?.key;
    if (typeof k !== 'string') continue;
    const cur = existing.get(k);
    if (!cur) out.plans.create.push(k);
    else if (JSON.stringify([cur.name, cur.public, cur.isComped, cur.smsCap, cur.callMinutesCap, cur.voicemailMinutesCap, cur.forwardMinutesCap, cur.trialDays, cur.maxLocations, cur.stripePriceId, cur.stripePriceIdAnnual, cur.sort, cur.features])
      !== JSON.stringify([(p as Record<string, unknown>).name, (p as Record<string, unknown>).public, (p as Record<string, unknown>).is_comped, (p as Record<string, unknown>).sms_cap, (p as Record<string, unknown>).call_minutes_cap, (p as Record<string, unknown>).voicemail_minutes_cap, (p as Record<string, unknown>).forward_minutes_cap, (p as Record<string, unknown>).trial_days, (p as Record<string, unknown>).max_locations, (p as Record<string, unknown>).stripe_price_id, (p as Record<string, unknown>).stripe_price_id_annual, (p as Record<string, unknown>).sort, (p as Record<string, unknown>).features])) out.plans.update.push(k);
    else out.plans.unchanged.push(k);
  }
  return out;
}

/** Import: the dry-run diff, then ONE change set (settings) plus the plan upserts in the same transaction. `apply: false` = dry run only. */
export async function importSettings(opts: { doc: unknown; apply: boolean; reason?: string; confirm?: string; actor: StoreActor; env?: NodeJS.ProcessEnv }): Promise<{ plan: ImportPlan; result: ApplyResult | null }> {
  const plan0 = await planImport(opts.doc, { env: opts.env });
  if (!opts.apply) {
    const prev = plan0.changes.length ? await previewChanges({ changes: plan0.changes, actor: opts.actor, env: opts.env, mode: 'import', reason: opts.reason }).catch((e) => { if (e instanceof SettingsError) { plan0.warnings.push(`${e.code}: ${e.message}`); return null; } throw e; }) : null;
    void prev;
    return { plan: plan0, result: null };
  }
  const { upsertPlansInTx, applyPlansDoc } = await import('./plans');
  const plansDoc = Array.isArray((opts.doc as Partial<ExportDoc>).plans) ? ((opts.doc as ExportDoc).plans) : [];
  if (plansDoc.length && !actorCan(opts.actor, 'plans.write', opts.env)) throw new SettingsError(403, 'forbidden', 'importing plans needs plans.write');
  const plansChange = plan0.plans.create.length + plan0.plans.update.length > 0;
  if (plan0.changes.length === 0) {
    if (!plansChange) return { plan: plan0, result: { change_set_id: null, version: await currentVersion(prisma), tier: 'normal', changes: [], noop: true, notified: null } };
    await assertSettingsWritable(prisma, opts.env);
    const version = await applyPlansDoc(plansDoc, opts.actor, opts.reason);
    return { plan: plan0, result: { change_set_id: null, version, tier: 'normal', changes: [], noop: false, notified: null } };
  }
  const result = await applyChanges({
    changes: plan0.changes, reason: opts.reason, confirm: opts.confirm, actor: { ...opts.actor, via: 'import' }, env: opts.env, mode: 'import',
    within: plansChange ? async (tx, version) => { await upsertPlansInTx(tx, plansDoc, opts.actor, version); } : undefined,
  });
  return { plan: plan0, result };
}
