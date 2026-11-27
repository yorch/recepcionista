/**
 * The settings loader: reads the console tables into the synchronous in-memory snapshot that `runtimeConfig()` / `setting()` / `configEnv()` serve, and keeps
 * it fresh. Node runtime only (the proxy never imports this; it reads the snapshot through the dependency-free config module).
 *
 *  - Boot: `bootSettings()` (instrumentation.ts register()) awaits the first load, 10 s timeout, BEFORE the job runner and the startup banner.
 *  - Propagation (D9): every 10 s each instance reads ONE row (settings_state.global_version); a different version reloads the rows. The writer refreshes at once.
 *  - Last known good (T12): a failed reload never replaces a successful snapshot, and the process never falls back to env/defaults after a successful load.
 *  - Integrity (T6): every row carries an HMAC (key|value-or-envelope|version). A row with a bad MAC, an undecryptable secret, an invalid value, an unknown key or a
 *    ratchet violation is IGNORED (that key falls back to the env pin or the default), logged, audited and mailed once per process.
 *  - Canary (T10): one row encrypted at first boot; failing to decrypt it fails /api/health with a clear message instead of silently dropping every secret.
 *  - Heartbeat (T11): each instance upserts its applied version so the console shows "applied on N/N instances".
 */
import crypto from 'node:crypto';
import { ConfigSnapshot, configEnv, setSnapshotSource } from '@/lib/config';
import { defaultContext, defaultOf, ratchetAllows } from '@/lib/config/registry';
import { settingDef } from '@/lib/config/registry';
import { prisma } from '@/lib/db/client';
import { recordAudit } from '@/lib/db/audit';
import { logger } from '@/lib/log';
import { setConsoleActive } from './console-state';
import { CANARY_KEY, CANARY_PLAINTEXT, SettingsCryptoError, decryptSetting, encryptSetting, macPayload, masterKeys, needsReencrypt, verifySettingMac, type MasterKeys } from './crypto';
import { notifyAdmins } from './notify';
import { setPlanCatalog, type PlanRow } from './plan-catalog';

const log = logger('settings-loader');

export const POLL_MS = 10_000;
export const BOOT_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 30_000;
export const LOAD_TIMEOUT_MS = 30_000;

export type ProblemCode = 'bad_mac' | 'decrypt_failed' | 'invalid_value' | 'unknown_key' | 'kind_mismatch' | 'ratchet_violation' | 'env_only_key' | 'canary_failed';
export interface LoadProblem { key: string; code: ProblemCode; detail?: string }

interface LoaderState {
  snapshot: ConfigSnapshot | null;
  version: number;
  loaded: boolean;
  loadedAt: number;
  lastError: string | null;
  problems: LoadProblem[];
  canary: 'ok' | 'failed' | 'none';
  rows: number;
  needsReencrypt: number;
  timer: ReturnType<typeof setInterval> | null;
  instanceId: string;
  startedAt: Date;
  lastHeartbeat: { at: number; version: number } | null;
  alerted: Set<string>;
  inflight: Promise<LoadResult> | null;
  gen: number;
  appliedGen: number;
}

const KEY = Symbol.for('rc.admin.loader');
function st(): LoaderState {
  const g = globalThis as unknown as Record<symbol, LoaderState | undefined>;
  return (g[KEY] ??= {
    snapshot: null, version: -1, loaded: false, loadedAt: 0, lastError: null, problems: [], canary: 'none', rows: 0, needsReencrypt: 0, timer: null,
    instanceId: `${(configEnv().HOSTNAME ?? 'app').slice(0, 24)}-${crypto.randomBytes(4).toString('hex')}`, startedAt: new Date(), lastHeartbeat: null, alerted: new Set(), inflight: null, gen: 0, appliedGen: 0,
  });
}

export interface LoadResult { ok: boolean; version: number; rows: number; ignored: number; error?: string }

const planOf = (r: {
  key: string; name: string; public: boolean; isComped: boolean; stripePriceId: string | null; stripePriceIdAnnual: string | null; trialDays: number | null; smsCap: number | null;
  callMinutesCap: number | null; voicemailMinutesCap: number | null; forwardMinutesCap: number | null; maxLocations: number | null; features: unknown; sort: number; archivedAt: Date | null;
}): PlanRow => ({
  key: r.key, name: r.name, public: r.public, is_comped: r.isComped, stripe_price_id: r.stripePriceId, stripe_price_id_annual: r.stripePriceIdAnnual, trial_days: r.trialDays,
  sms_cap: r.smsCap, call_minutes_cap: r.callMinutesCap, voicemail_minutes_cap: r.voicemailMinutesCap, forward_minutes_cap: r.forwardMinutesCap, max_locations: r.maxLocations,
  features: Object.fromEntries(Object.entries((r.features ?? {}) as Record<string, unknown>).filter(([, v]) => typeof v === 'boolean')) as Record<string, boolean>, sort: r.sort,
  archived_at: r.archivedAt ? r.archivedAt.toISOString() : null,
});

async function alertProblem(p: LoadProblem, version: number): Promise<void> {
  const k = `${p.code}:${p.key}:${version}`;
  const s = st();
  if (s.alerted.has(k)) return;
  s.alerted.add(k);
  log.error('settings.integrity_failure', { key: p.key, code: p.code, version });
  await recordAudit({ actor_kind: 'system', action: 'settings.integrity_failure', target: `setting:${p.key}`, meta: { key: p.key, code: p.code, version, ...(p.detail ? { detail: p.detail.slice(0, 200) } : {}) } });
  void notifyAdmins({
    subject: `[Recepcionista] Setting ${p.key} was ignored (${p.code})`, kind: 'integrity_failure',
    lines: [`A console setting failed its integrity check and is being IGNORED (the environment value or the default applies instead).`, `key: ${p.key}`, `reason: ${p.code}`, `settings version: ${version}`, 'Investigate possible database tampering or a wrong APP_SECRET_KEY / APP_SECRET_KEY_PREVIOUS.'],
  }).catch(() => undefined);
}

/** Read every console table into a fresh snapshot. Never throws: a failure leaves the previous (last known good) snapshot in place. */
async function doLoad(): Promise<LoadResult> {
  const s = st();
  const gen = ++s.gen;
  try {
    const state = await prisma.settingsState.findUnique({ where: { id: 1 } });
    const version = Number(state?.globalVersion ?? 0);
    const [rows, plans] = await Promise.all([prisma.platformSetting.findMany(), prisma.plan.findMany()]);
    const real = rows.filter((r) => r.key !== CANARY_KEY);
    let keys: MasterKeys | null = null;
    try { keys = masterKeys(); } catch (err) { s.lastError = `master key: ${(err as Error).message}`; }
    const values: Record<string, unknown> = {};
    const secrets: Record<string, string> = {};
    const previousSecrets: Record<string, { value: string; until: number }> = {};
    const problems: LoadProblem[] = [];
    const nowMs = Date.now();
    let stale = 0;
    for (const row of real) {
      const def = settingDef(row.key);
      const bad = (code: ProblemCode, detail?: string) => problems.push({ key: row.key, code, ...(detail ? { detail } : {}) });
      if (!def) { bad('unknown_key'); continue; }
      if (def.envOnlyLoosen) { bad('env_only_key'); continue; }
      if (!keys || !verifySettingMac(row.key, macPayload({ value: row.value, secretEnvelope: row.secretEnvelope }), row.version, row.integrityMac, keys)) { bad('bad_mac'); continue; }
      if (def.kind === 'secret') {
        if (!row.secretEnvelope) { bad('kind_mismatch'); continue; }
        try {
          secrets[row.key] = decryptSetting(row.secretEnvelope, row.key, keys);
          if (needsReencrypt(row.secretEnvelope, keys)) stale++;
        } catch (err) { bad('decrypt_failed', err instanceof SettingsCryptoError ? err.code : 'error'); continue; }
        if (row.previousEnvelope && row.previousUntil && row.previousUntil.getTime() > nowMs) {
          try { previousSecrets[row.key] = { value: decryptSetting(row.previousEnvelope, row.key, keys), until: row.previousUntil.getTime() }; } catch { /* an undecryptable previous value is simply not accepted */ }
        }
        continue;
      }
      if (row.secretEnvelope || row.value === null || row.value === undefined) { bad('kind_mismatch'); continue; }
      const checked = def.schema.check(row.value);
      if (!checked.ok) { bad('invalid_value', checked.error); continue; }
      if (def.ratchet) {
        const base = defaultOf(def, defaultContext(configEnv().NODE_ENV));
        if (base !== null && !ratchetAllows(def, base, checked.value)) { bad('ratchet_violation'); continue; }
      }
      values[row.key] = checked.value;
    }
    // canary
    let canary: LoaderState['canary'] = 'none';
    const c = rows.find((r) => r.key === CANARY_KEY);
    if (c?.secretEnvelope) {
      try {
        canary = keys && decryptSetting(c.secretEnvelope, CANARY_KEY, keys) === CANARY_PLAINTEXT ? 'ok' : 'failed';
        if (keys && canary === 'ok' && needsReencrypt(c.secretEnvelope, keys)) stale++;
      } catch { canary = 'failed'; }
    }
    if (canary === 'failed') problems.push({ key: CANARY_KEY, code: 'canary_failed' });

    if (gen < s.appliedGen) return { ok: true, version: s.version, rows: s.rows, ignored: s.problems.length }; // a late (abandoned) load never replaces a snapshot from a newer load
    s.appliedGen = gen;
    s.snapshot = new ConfigSnapshot({ version, values, secrets, previousSecrets });
    s.version = version;
    s.loaded = true;
    s.loadedAt = Date.now();
    s.problems = problems;
    s.canary = canary;
    s.rows = real.length;
    s.needsReencrypt = stale;
    s.lastError = keys ? null : s.lastError;
    setPlanCatalog(plans.map(planOf));
    for (const p of problems) if (p.code !== 'unknown_key') await alertProblem(p, version);
    return { ok: true, version, rows: real.length, ignored: problems.length };
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    s.lastError = message.slice(0, 300);
    log.error('load_failed', { error: s.lastError, last_known_good_version: s.version });
    return { ok: false, version: s.version, rows: s.rows, ignored: s.problems.length, error: s.lastError };
  }
}

/** (Re)load now, coalescing concurrent calls. The writer calls it right after a commit; the poll calls it when the version moved. */
export function refreshNow(): Promise<LoadResult> {
  const s = st();
  if (!s.inflight) {
    // A load that never answers (a wedged connection) must not block every later refresh: it is abandoned after LOAD_TIMEOUT_MS (its late result is still applied if newer).
    const timeout = new Promise<LoadResult>((resolve) => { const t = setTimeout(() => resolve({ ok: false, version: s.version, rows: s.rows, ignored: s.problems.length, error: 'load timed out' }), LOAD_TIMEOUT_MS); t.unref?.(); });
    const p = Promise.race([doLoad(), timeout]).finally(() => { if (s.inflight === p) s.inflight = null; });
    s.inflight = p;
  }
  return s.inflight;
}

/** Create the canary row once (`INSERT .. ON CONFLICT DO NOTHING`): any instance may win the race. Never throws. */
export async function ensureCanary(): Promise<void> {
  try {
    const env = encryptSetting(CANARY_PLAINTEXT, CANARY_KEY);
    await prisma.platformSetting.createMany({ data: [{ key: CANARY_KEY, secretEnvelope: env, integrityMac: '-', updatedVia: 'system' }], skipDuplicates: true });
  } catch (err) {
    log.warn('canary_create_failed', { error: (err as Error).message });
  }
}

async function heartbeat(force = false): Promise<void> {
  const s = st();
  const now = Date.now();
  if (!force && s.lastHeartbeat && s.lastHeartbeat.version === s.version && now - s.lastHeartbeat.at < HEARTBEAT_MS) return;
  try {
    const data = { settingsVersion: BigInt(Math.max(0, s.version)), buildSha: (configEnv().BUILD_SHA ?? '').slice(0, 40) || null, canary: s.canary, ignoredRows: s.problems.length, seenAt: new Date() };
    await prisma.instanceHeartbeat.upsert({ where: { instanceId: s.instanceId }, create: { instanceId: s.instanceId, startedAt: s.startedAt, ...data }, update: data });
    s.lastHeartbeat = { at: now, version: s.version };
  } catch (err) {
    log.warn('heartbeat_failed', { error: (err as Error).message });
  }
}

/** One poll: read the single version row; reload when it differs from the applied one (or nothing has loaded yet); then the heartbeat. Exported for tests. */
export async function pollOnce(): Promise<void> {
  const s = st();
  try {
    const row = await prisma.settingsState.findUnique({ where: { id: 1 }, select: { globalVersion: true } });
    const v = Number(row?.globalVersion ?? 0);
    if (!s.loaded || v !== s.version) await refreshNow();
  } catch (err) {
    s.lastError = ((err as Error).message ?? '').slice(0, 300);
    log.warn('poll_failed', { error: s.lastError });
  }
  await heartbeat();
}

/** Install the snapshot source and start the 10 s poll (idempotent). */
export function startSettingsPoll(intervalMs: number = POLL_MS): void {
  const s = st();
  setSnapshotSource(() => st().snapshot);
  setConsoleActive(true);
  if (s.timer) return;
  s.timer = setInterval(() => { void pollOnce(); }, intervalMs);
  s.timer.unref?.();
}

/** Stop the poll and detach the snapshot (tests, shutdown). The environment alone is served afterwards. */
export function stopSettingsLoader(): void {
  const s = st();
  if (s.timer) clearInterval(s.timer);
  s.timer = null; s.inflight = null; s.snapshot = null; s.version = -1; s.loaded = false; s.problems = []; s.canary = 'none'; s.rows = 0; s.lastHeartbeat = null; s.alerted = new Set();
  setSnapshotSource(null);
  setConsoleActive(false);
  setPlanCatalog(null);
}

/**
 * Boot sequence step: create the canary, await the first load (timeout 10 s: the process then boots with the environment and /api/health stays 503 while
 * rows exist), install the source and start the poll. Returns the load result (or a timeout marker). Never throws.
 */
export async function bootSettings(timeoutMs: number = BOOT_TIMEOUT_MS): Promise<LoadResult | { ok: false; timeout: true }> {
  startSettingsPoll();
  await ensureCanary();
  const timeout = new Promise<{ ok: false; timeout: true }>((resolve) => { const t = setTimeout(() => resolve({ ok: false, timeout: true }), timeoutMs); t.unref?.(); });
  const res = await Promise.race([refreshNow(), timeout]);
  if (!res.ok) log.error('boot_load_incomplete', { reason: 'timeout' in res ? 'timeout' : (res as LoadResult).error });
  await heartbeat(true);
  return res;
}

export interface SettingsHealth {
  ok: boolean;
  loaded: boolean;
  version: number;
  canary: 'ok' | 'failed' | 'none';
  ignored_rows: number;
  needs_reencrypt: number;
  error?: 'settings_not_loaded' | 'secret_canary_failed';
  detail?: string;
  last_error: string | null;
}

/**
 * Readiness of the settings layer for /api/health. 503 when rows exist but the first load has not succeeded, or the canary cannot be decrypted. With no console
 * rows at all (a fresh or env-only deployment) the layer is simply ready. `rowsExist` is supplied by the caller (one cheap count) when nothing has loaded.
 */
export function settingsHealth(rowsExist: boolean): SettingsHealth {
  const s = st();
  const base = { loaded: s.loaded, version: Math.max(0, s.version), canary: s.canary, ignored_rows: s.problems.length, needs_reencrypt: s.needsReencrypt, last_error: s.lastError };
  if (!s.timer && !s.loaded) return { ok: true, ...base }; // the loader was never started in this process (build, tests, scripts)
  if (!s.loaded && rowsExist) return { ok: false, ...base, error: 'settings_not_loaded', detail: 'the console settings have not been loaded yet' };
  if (s.canary === 'failed') return { ok: false, ...base, error: 'secret_canary_failed', detail: 'the secret canary could not be decrypted: check APP_SECRET_KEY / APP_SECRET_KEY_PREVIOUS' };
  return { ok: true, ...base };
}

export interface LoaderStatus extends SettingsHealth {
  instance_id: string;
  loaded_at: string | null;
  problems: LoadProblem[];
}
export function loaderStatus(): LoaderStatus {
  const s = st();
  return { ...settingsHealth(s.rows > 0), instance_id: s.instanceId, loaded_at: s.loadedAt ? new Date(s.loadedAt).toISOString() : null, problems: [...s.problems] };
}

/** The applied settings version of this process (-1 before the first load). */
export const appliedVersion = (): number => st().version;
export const instanceIdOfThisProcess = (): string => st().instanceId;
export const loaderStarted = (): boolean => st().timer !== null;

/** The snapshot currently served (null before the first load): the store keeps the PRE-change one to pick the notification transport. */
export const snapshotNow = (): ConfigSnapshot | null => st().snapshot;
