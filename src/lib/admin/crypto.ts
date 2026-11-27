/**
 * Encryption and integrity of console-held settings. Node runtime only.
 *
 *  - Envelope v2: `v2.<kid>.<iv>.<tag>.<ct>` (base64url parts). AES-256-GCM, key = HKDF-SHA256(APP_SECRET_KEY, salt none, info `rc/settings/v1`), AAD = `setting:<key>`
 *    (a ciphertext cannot be swapped between keys). `kid` = base64url(sha256(derivedKey))[0..8] names the key, so a rotation can decrypt old rows with
 *    APP_SECRET_KEY_PREVIOUS (decrypt only) while new writes use the current key. Domain separation: TOTP keeps its own v1 envelope under the raw key.
 *  - MAC: HMAC-SHA256 with a SECOND derived key (`rc/settings-mac/v1`) over `key|payload|version`. A row that fails it (SQL tampering, a rolled-back version) is ignored.
 *  - Fingerprint: sha256(plaintext) hex [0..8] (+ the last 4 characters of a long secret): all the console ever shows about a secret.
 */
import crypto from 'node:crypto';
import { configEnv } from '@/lib/config';
import { appSecretKey } from '@/lib/totp';

export const ENVELOPE_V2 = 'v2';
const INFO_ENC = 'rc/settings/v1';
const INFO_MAC = 'rc/settings-mac/v1';
export const CANARY_KEY = '_canary';
export const CANARY_PLAINTEXT = 'rc-canary-v1';

export class SettingsCryptoError extends Error {
  constructor(message: string, readonly code: 'unknown_kid' | 'bad_envelope' | 'auth_failed' | 'no_previous_key') {
    super(message);
    this.name = 'SettingsCryptoError';
  }
}

const hkdf = (master: Buffer, info: string): Buffer => Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), Buffer.from(info), 32));
export const kidOf = (key: Buffer): string => crypto.createHash('sha256').update(key).digest('base64url').slice(0, 8);

export interface MasterKeys {
  /** Derived encryption key + its id (new writes). */
  current: { enc: Buffer; mac: Buffer; kid: string };
  /** Previous master key during a rotation (decrypt / verify only). */
  previous: { enc: Buffer; mac: Buffer; kid: string } | null;
}

function derive(master: Buffer): { enc: Buffer; mac: Buffer; kid: string } {
  const enc = hkdf(master, INFO_ENC);
  return { enc, mac: hkdf(master, INFO_MAC), kid: kidOf(enc) };
}

/** The current and (when set) previous derived keys. Throws SecretKeyError in production without a valid APP_SECRET_KEY. */
export function masterKeys(env: NodeJS.ProcessEnv = configEnv()): MasterKeys {
  const current = derive(appSecretKey(env));
  const raw = (env.APP_SECRET_KEY_PREVIOUS ?? '').trim();
  let previous: MasterKeys['previous'] = null;
  if (raw) {
    const buf = Buffer.from(raw, /[-_]/.test(raw) ? 'base64url' : 'base64');
    if (buf.length === 32) previous = derive(buf);
  }
  return { current, previous: previous && previous.kid !== current.kid ? previous : null };
}

/** `v2.<kid>.<iv>.<tag>.<ct>` for `plain`, bound to the setting key. */
export function encryptSetting(plain: string, settingKey: string, keys: MasterKeys = masterKeys()): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keys.current.enc, iv);
  c.setAAD(Buffer.from(`setting:${settingKey}`));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [ENVELOPE_V2, keys.current.kid, iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function envelopeKid(envelope: string): string | null {
  const p = String(envelope ?? '').split('.');
  return p.length === 5 && p[0] === ENVELOPE_V2 ? p[1] : null;
}

/** Decrypt with the key the envelope names (current or previous). Throws SettingsCryptoError; never returns partial data. */
export function decryptSetting(envelope: string, settingKey: string, keys: MasterKeys = masterKeys()): string {
  const p = String(envelope ?? '').split('.');
  if (p.length !== 5 || p[0] !== ENVELOPE_V2) throw new SettingsCryptoError('invalid secret envelope', 'bad_envelope');
  const k = p[1] === keys.current.kid ? keys.current : keys.previous && p[1] === keys.previous.kid ? keys.previous : null;
  if (!k) throw new SettingsCryptoError('secret was encrypted with a key that is not configured (set APP_SECRET_KEY_PREVIOUS)', 'unknown_kid');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', k.enc, Buffer.from(p[2], 'base64url'));
    d.setAuthTag(Buffer.from(p[3], 'base64url'));
    d.setAAD(Buffer.from(`setting:${settingKey}`));
    return Buffer.concat([d.update(Buffer.from(p[4], 'base64url')), d.final()]).toString('utf8');
  } catch {
    throw new SettingsCryptoError('secret failed authentication (wrong key, tampered or moved)', 'auth_failed');
  }
}

/** Does this envelope need re-encrypting (it is not under the current key)? */
export const needsReencrypt = (envelope: string, keys: MasterKeys = masterKeys()): boolean => envelopeKid(envelope) !== keys.current.kid;

export const fingerprintOf = (plain: string): string => crypto.createHash('sha256').update(plain).digest('hex').slice(0, 8);
/** Last 4 characters, only for secrets long enough that they reveal little (>= 16 characters). */
export const last4Of = (plain: string): string | null => (plain.length >= 16 ? plain.slice(-4) : null);

/** Deterministic JSON (sorted keys) so a MAC does not depend on key order after a jsonb round trip. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

export function settingMac(settingKey: string, payload: string, version: number | bigint, keys: MasterKeys = masterKeys()): string {
  return crypto.createHmac('sha256', keys.current.mac).update(`${settingKey}|${payload}|${String(version)}`).digest('hex');
}

/** Verify a stored MAC against the current or previous key (constant time). */
export function verifySettingMac(settingKey: string, payload: string, version: number | bigint, mac: string, keys: MasterKeys = masterKeys()): boolean {
  const msg = `${settingKey}|${payload}|${String(version)}`;
  for (const k of [keys.current, keys.previous]) {
    if (!k) continue;
    const want = crypto.createHmac('sha256', k.mac).update(msg).digest();
    const got = Buffer.from(String(mac ?? ''), 'hex');
    if (got.length === want.length && crypto.timingSafeEqual(got, want)) return true;
  }
  return false;
}

/** The text a row's MAC covers: the canonical value, or the envelope for a secret. */
export const macPayload = (row: { value?: unknown; secretEnvelope?: string | null }): string => (row.secretEnvelope ? `enc:${row.secretEnvelope}` : `val:${canonicalJson(row.value)}`);
