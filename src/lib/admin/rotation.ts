/**
 * APP_SECRET_KEY rotation (24e T10). Node runtime only.
 *
 *   1. set the NEW key in APP_SECRET_KEY and move the old one to APP_SECRET_KEY_PREVIOUS; restart (decrypts everything, writes with the new key).
 *   2. run "re-encrypt all" (POST /api/admin/secrets/reencrypt, repeat while `done` is false): console secrets + their MACs, the retained previous envelopes, the canary, TOTP
 *      secrets and Google calendar tokens (both v1 envelopes under the raw key) are re-encrypted under the new key.
 *   3. when `remaining` is 0 everywhere, delete APP_SECRET_KEY_PREVIOUS.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { auditRowData } from '@/lib/db/audit';
import { decryptSecret, encryptSecret, isUnderCurrentKey } from '@/lib/totp';
import { CANARY_KEY, decryptSetting, encryptSetting, macPayload, masterKeys, needsReencrypt, settingMac, verifySettingMac } from './crypto';
import { loaderStarted, refreshNow } from './loader';
import { assertSettingsWritable, SettingsError, type StoreActor } from './settings-store';
import { roleCan } from './permissions';

export interface ReencryptProgress {
  settings: { done: number; failed: number; remaining: number };
  revisions: { done: number; failed: number; remaining: number };
  totp: { done: number; failed: number; remaining: number };
  calendar_tokens: { done: number; failed: number; remaining: number };
  /** Everything is under the current key: APP_SECRET_KEY_PREVIOUS may be removed. */
  done: boolean;
  next_cursor: string | null;
}

const BATCH = 200;

/** Count what is still under an older key (no writes). */
export async function reencryptStatus(): Promise<Pick<ReencryptProgress, 'settings' | 'revisions' | 'totp' | 'calendar_tokens' | 'done'>> {
  const keys = masterKeys();
  const rows = await prisma.platformSetting.findMany({ where: { secretEnvelope: { not: null } }, select: { secretEnvelope: true, previousEnvelope: true } });
  const sRem = rows.filter((r) => (r.secretEnvelope && needsReencrypt(r.secretEnvelope, keys)) || (r.previousEnvelope && needsReencrypt(r.previousEnvelope, keys))).length;
  const revs = await prisma.platformSettingRevision.findMany({ where: { prevEnvelope: { not: null } }, select: { prevEnvelope: true } });
  const rRem = revs.filter((r) => r.prevEnvelope && needsReencrypt(r.prevEnvelope, keys)).length;
  const users = await prisma.user.findMany({ where: { totpSecretEnc: { not: null } }, select: { id: true, totpSecretEnc: true } });
  const tRem = users.filter((u) => u.totpSecretEnc && !isUnderCurrentKey(u.totpSecretEnc, u.id)).length;
  const cals = await prisma.calendarConnection.findMany({ select: { id: true, accessTokenEnc: true, refreshTokenEnc: true } });
  const cRem = cals.filter((c) => (c.accessTokenEnc && !isUnderCurrentKey(c.accessTokenEnc, c.id)) || (c.refreshTokenEnc && !isUnderCurrentKey(c.refreshTokenEnc, c.id))).length;
  const z = (remaining: number) => ({ done: 0, failed: 0, remaining });
  return { settings: z(sRem), revisions: z(rRem), totp: z(tRem), calendar_tokens: z(cRem), done: sRem + rRem + tRem + cRem === 0 };
}

/**
 * Re-encrypt under the current key. Settings, revisions and the canary are done in ONE transaction on the first call (they are few); TOTP secrets and calendar tokens
 * are processed `BATCH` rows per call (`cursor` = last user id): call again until `done`. An undecryptable row is counted as failed and left untouched.
 */
export async function reencryptAll(opts: { actor: StoreActor; reason: string; cursor?: string | null }): Promise<ReencryptProgress> {
  if (opts.actor.role !== 'system' && !roleCan(opts.actor.role, 'settings.secrets.write')) throw new SettingsError(403, 'forbidden', 'not allowed to re-encrypt secrets');
  await assertSettingsWritable();
  const reason = (opts.reason ?? '').trim();
  if (reason.length < 8) throw new SettingsError(422, 'reason_required', 'a reason of at least 8 characters is required');
  const keys = masterKeys();
  const progress: ReencryptProgress = { settings: { done: 0, failed: 0, remaining: 0 }, revisions: { done: 0, failed: 0, remaining: 0 }, totp: { done: 0, failed: 0, remaining: 0 }, calendar_tokens: { done: 0, failed: 0, remaining: 0 }, done: false, next_cursor: null };

  if (!opts.cursor) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO settings_state (id, global_version) VALUES (1, 0) ON CONFLICT (id) DO NOTHING`;
      const [{ global_version }] = await tx.$queryRaw<{ global_version: bigint }[]>`SELECT global_version FROM settings_state WHERE id = 1 FOR UPDATE`;
      const version = Number(global_version) + 1;
      const rows = await tx.platformSetting.findMany({ where: { secretEnvelope: { not: null } } });
      for (const r of rows) {
        if (!r.secretEnvelope) continue;
        const stale = needsReencrypt(r.secretEnvelope, keys) || (r.previousEnvelope !== null && needsReencrypt(r.previousEnvelope, keys));
        if (!stale) continue;
        try {
          const plain = decryptSetting(r.secretEnvelope, r.key, keys);
          const envelope = encryptSetting(plain, r.key, keys);
          let previous: string | null = r.previousEnvelope;
          if (previous) { try { previous = encryptSetting(decryptSetting(previous, r.key, keys), r.key, keys); } catch { previous = null; } }
          // the canary keeps its placeholder MAC; every real secret gets a fresh MAC under the current key and the new version
          await tx.platformSetting.update({ where: { key: r.key }, data: { secretEnvelope: envelope, previousEnvelope: previous, version: BigInt(version), integrityMac: r.key === CANARY_KEY ? '-' : settingMac(r.key, macPayload({ secretEnvelope: envelope }), version, keys) } });
          progress.settings.done++;
        } catch { progress.settings.failed++; }
      }
      // non-secret rows: a MAC made under the previous master key is re-signed so the previous key can go
      const plain = await tx.platformSetting.findMany({ where: { secretEnvelope: null } });
      for (const r of plain) {
        if (settingMac(r.key, macPayload({ value: r.value }), r.version, keys) === r.integrityMac) continue; // already under the current key
        if (!verifySettingMac(r.key, macPayload({ value: r.value }), r.version, r.integrityMac, keys)) continue; // not valid under ANY key: tampered, never re-signed
        await tx.platformSetting.update({ where: { key: r.key }, data: { version: BigInt(version), integrityMac: settingMac(r.key, macPayload({ value: r.value }), version, keys) } });
      }
      const revs = await tx.platformSettingRevision.findMany({ where: { prevEnvelope: { not: null } }, select: { id: true, key: true, prevEnvelope: true } });
      for (const rv of revs) {
        if (!rv.prevEnvelope || !needsReencrypt(rv.prevEnvelope, keys)) continue;
        try { await tx.platformSettingRevision.update({ where: { id: rv.id }, data: { prevEnvelope: encryptSetting(decryptSetting(rv.prevEnvelope, rv.key, keys), rv.key, keys) } }); progress.revisions.done++; } catch { progress.revisions.failed++; }
      }
      await tx.settingsState.update({ where: { id: 1 }, data: { globalVersion: BigInt(version), updatedAt: new Date() } });
    }, { timeout: 30_000 });
  }

  // TOTP secrets (aad = user id) and calendar tokens (aad = connection id): v1 envelopes under the RAW key, re-encrypted one user / connection at a time
  const users = await prisma.user.findMany({ where: { totpSecretEnc: { not: null }, ...(opts.cursor ? { id: { gt: opts.cursor } } : {}) }, orderBy: { id: 'asc' }, take: BATCH, select: { id: true, totpSecretEnc: true } });
  for (const u of users) {
    if (!u.totpSecretEnc || isUnderCurrentKey(u.totpSecretEnc, u.id)) continue;
    try { await prisma.user.update({ where: { id: u.id }, data: { totpSecretEnc: encryptSecret(decryptSecret(u.totpSecretEnc, u.id), u.id) } }); progress.totp.done++; } catch { progress.totp.failed++; }
  }
  progress.next_cursor = users.length === BATCH ? users[users.length - 1].id : null;
  if (progress.next_cursor === null) {
    const cals = await prisma.calendarConnection.findMany({ select: { id: true, accessTokenEnc: true, refreshTokenEnc: true } });
    for (const c of cals) {
      const data: Prisma.CalendarConnectionUpdateInput = {};
      try {
        if (c.accessTokenEnc && !isUnderCurrentKey(c.accessTokenEnc, c.id)) data.accessTokenEnc = encryptSecret(decryptSecret(c.accessTokenEnc, c.id), c.id);
        if (c.refreshTokenEnc && !isUnderCurrentKey(c.refreshTokenEnc, c.id)) data.refreshTokenEnc = encryptSecret(decryptSecret(c.refreshTokenEnc, c.id), c.id);
        if (Object.keys(data).length) { await prisma.calendarConnection.update({ where: { id: c.id }, data }); progress.calendar_tokens.done++; }
      } catch { progress.calendar_tokens.failed++; }
    }
  }
  const rem = await reencryptStatus();
  progress.settings.remaining = rem.settings.remaining; progress.revisions.remaining = rem.revisions.remaining; progress.totp.remaining = rem.totp.remaining; progress.calendar_tokens.remaining = rem.calendar_tokens.remaining;
  progress.done = rem.done && progress.next_cursor === null;
  await prisma.auditEvent.create({
    data: auditRowData({
      actor_kind: opts.actor.kind, actor_user_id: opts.actor.user_id, action: 'settings.reencrypt', target: 'secrets', ip: opts.actor.ip,
      meta: { reason, key_id: keys.current.kid, previous_key: keys.previous !== null, settings: progress.settings, revisions: progress.revisions, totp: progress.totp, calendar_tokens: progress.calendar_tokens, done: progress.done, role: opts.actor.role },
      meta_trusted: true,
    }),
  });
  if (loaderStarted()) await refreshNow();
  return progress;
}

/** Key ids for the System page: which key new writes use and whether a previous key is configured. Never the keys. */
export function keyInfo(): { current_kid: string; previous_kid: string | null } {
  const k = masterKeys();
  return { current_kid: k.current.kid, previous_kid: k.previous?.kid ?? null };
}
