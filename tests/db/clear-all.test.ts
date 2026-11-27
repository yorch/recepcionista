/**
 * clearAll (seed script + demo reset) must empty EVERY table with tenant data. The test fills every table of the schema, runs it, and
 * asserts every table is empty except the documented survivors. A table added later that is neither wiped nor listed here fails it.
 * Wipes the whole scratch database: it only runs against a database named test / scratch (see tests/helpers/preload.ts).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { TEST_URL, rid } from '../helpers/auth-harness';

const suite = TEST_URL ? describe : describe.skip;
/** Tables clearAll deliberately keeps (and why). */
const SURVIVORS: Record<string, string> = {
  _prisma_migrations: 'schema history',
  pending_recording_deletions: 'the provider-side deletion queue clearAll itself just filled',
  users: 'admin accounts only (checked below)',
  user_sessions: 'admin sessions only (checked below)',
  recovery_codes: 'admin accounts only (checked below)',
  passkey_credentials: 'admin accounts only (checked below)',
  // admin console: platform configuration and operational history, not tenant data (tenant_setting_overrides and support_grants cascade away with their business)
  platform_settings: 'console configuration',
  platform_setting_revisions: 'console change history',
  setting_change_sets: 'console change history',
  settings_state: 'the single settings-version row',
  instance_heartbeats: 'running instances',
  plans: 'the plan catalog (businesses reference it)',
  job_runs: 'job run history',
  legal_pages: 'legal pages',
  legal_page_versions: 'legal page versions',
};

suite('clearAll (postgres)', () => {
  let db: any;
  const run = rid();
  const hex = (n: number) => Buffer.from(`${run}${n}`).toString('hex').padEnd(32, '0').slice(0, 32);

  beforeAll(async () => { db = await import('../../src/lib/db'); });
  afterAll(async () => { await db.prisma.$disconnect(); });

  test('every table is emptied except the documented survivors; admin accounts keep working; the recording queue gets the recordings', async () => {
    const p = db.prisma;
    const biz = await p.business.create({ data: { id: `b_${run}`, name: 'Wipe me', status: 'live' } });
    const biz2 = await p.business.create({ data: { id: `b2_${run}`, name: 'Wipe me too', status: 'live' } });
    const owner = await p.user.create({ data: { id: `u_${run}`, email: `owner-${run}@x.test`, passwordHash: 'h', role: 'owner', businessId: biz.id } });
    await p.membership.upsert({ where: { userId_businessId: { userId: owner.id, businessId: biz2.id } }, update: {}, create: { userId: owner.id, businessId: biz2.id, role: 'staff' } });
    const admin = await p.user.create({ data: { id: `a_${run}`, email: `admin-${run}@x.test`, passwordHash: 'h', role: 'admin' } });
    await p.knowledgeBase.create({ data: { businessId: biz.id } });
    const call = await p.call.create({ data: { id: `c_${run}`, businessId: biz.id, conversationId: `conv_${run}`, recordingUrl: `https://api.twilio.com/2010-04-01/Accounts/AC${hex(1)}/Recordings/RE${hex(2)}` } });
    const booking = await p.booking.create({ data: { id: `k_${run}`, businessId: biz.id, callId: call.id, customerName: 'x', customerPhone: '+13055550101', service: 's', scheduledAt: new Date(Date.now() + 86_400_000) } });
    const briefing = await p.briefing.create({ data: { businessId: biz.id, date: '2030-01-01', transcript: 't' } });
    await p.briefingAudio.create({ data: { briefingId: briefing.id, contentType: 'audio/mpeg', bytes: Buffer.from([1, 2, 3]) } });
    await p.inboundMessage.create({ data: { businessId: biz.id, fromE164: '+13055550101', fromPhone: '(305) 555-0101', body: 'hi', twilioMessageSid: `SM${run}`, bookingId: booking.id } });
    await p.smsLog.create({ data: { businessId: biz.id, toPhone: '+13055550101', body: 'b', kind: 'other', bookingId: booking.id } });
    await p.smsOptOut.create({ data: { businessId: biz.id, phoneKey: '3055550101', source: 'stop_keyword' } });
    await p.rateLimitBucket.create({ data: { key: `k_${run}`, windowStart: new Date(), count: 1 } });
    await p.processedEvent.create({ data: { source: 'wipe', id: run } });
    await p.provisionLock.create({ data: { key: `l_${run}`, holder: 'h', expiresAt: new Date(Date.now() + 60_000) } });
    await p.userSession.create({ data: { userId: owner.id, tokenHash: `t1_${run}`, expiresAt: new Date(Date.now() + 60_000), activeBusinessId: biz.id } });
    await p.userSession.create({ data: { userId: admin.id, tokenHash: `t2_${run}`, expiresAt: new Date(Date.now() + 60_000) } });
    await p.userSession.create({ data: { kind: 'admin_token', userId: null, tokenHash: `t3_${run}`, expiresAt: new Date(Date.now() + 60_000) } });
    await p.recoveryCode.create({ data: { userId: owner.id, codeHash: 'c1' } });
    await p.recoveryCode.create({ data: { userId: admin.id, codeHash: 'c2' } });
    await p.emailToken.create({ data: { email: 'x@x.test', purpose: 'verify', tokenHash: `e_${run}`, businessId: biz.id, userId: owner.id, expiresAt: new Date(Date.now() + 60_000) } });
    await p.auditEvent.create({ data: { actorKind: 'system', businessId: biz.id, action: 'wipe.test' } });
    await p.usageCounter.create({ data: { businessId: biz.id, periodStart: new Date('2030-01-01') } });
    await p.forwardLease.create({ data: { businessId: biz.id, callSid: `CA${run}`, reservedSeconds: 60, expiresAt: new Date(Date.now() + 60_000) } });
    await p.pendingRecordingDeletion.create({ data: { accountSid: `AC${hex(3)}`, recordingSid: `RE${hex(4)}`, businessId: biz.id } });
    await p.trialFingerprint.create({ data: { kind: 'email', fingerprint: `fp_${run}`, businessId: biz.id } });
    const conn = await p.calendarConnection.create({ data: { businessId: biz.id, accountEmail: 'a@x.test', status: 'revoked' } });
    await p.calendarEventLink.create({ data: { bookingId: booking.id, connectionId: conn.id, googleEventId: 'g1' } });
    await p.calendarBusyBlock.create({ data: { connectionId: conn.id, businessId: biz.id, googleEventId: 'g2', startsAt: new Date(), endsAt: new Date(Date.now() + 3600_000) } });
    await p.ownerKbChange.create({ data: { businessId: biz.id, callId: call.id, source: 'owner_voice', summary: 's' } });
    await p.calendarOrphanedEvent.create({ data: { businessId: biz.id, bookingId: booking.id, googleEventId: 'g3', calendarId: 'primary', accountEmail: 'old@x.test', service: 'AC repair', startsAt: new Date() } });
    await p.ownerReply.create({ data: { businessId: biz.id, callId: call.id, leadKind: 'call', leadCallId: call.id, toE164: '+13055550142', body: 'hi', expiresAt: new Date(Date.now() + 60_000) } });
    await p.callTranscriptEvent.create({ data: { callId: call.id, seq: 0, role: 'caller', text: 'hi', at: new Date() } });
    await p.passkeyCredential.create({ data: { userId: owner.id, credentialId: `cred1_${run}`, publicKey: Buffer.from([1, 2, 3]) } });
    await p.passkeyCredential.create({ data: { userId: admin.id, credentialId: `cred2_${run}`, publicKey: Buffer.from([1, 2, 3]) } });
    await p.webauthnChallenge.create({ data: { purpose: 'login', challengeHash: `w1_${run}`, expiresAt: new Date(Date.now() + 60_000) } });
    await p.webauthnChallenge.create({ data: { purpose: 'register', userId: owner.id, challengeHash: `w2_${run}`, expiresAt: new Date(Date.now() + 60_000) } });

    // admin console tables (kept: configuration / history; the per-tenant ones cascade with the business)
    await p.platformSetting.create({ data: { key: `t.${run}`, value: 1, integrityMac: 'm' } });
    const cs = await p.settingChangeSet.create({ data: { id: `cs_${run}` } });
    await p.platformSettingRevision.create({ data: { changeSetId: cs.id, key: `t.${run}` } });
    await p.tenantSettingOverride.create({ data: { businessId: biz.id, key: 'jobs.briefing_hour', value: 19 } });
    await p.settingsState.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    await p.instanceHeartbeat.create({ data: { instanceId: `i_${run}` } });
    await p.plan.upsert({ where: { key: 'standard' }, create: { key: 'standard', name: 'Standard' }, update: {} });
    await p.jobRun.create({ data: { job: 'cleanup', startedAt: new Date() } });
    await p.legalPage.upsert({ where: { slug_locale: { slug: 'terms', locale: 'en' } }, create: { slug: 'terms', locale: 'en' }, update: {} });
    await p.legalPageVersion.create({ data: { slug: 'terms', locale: 'en', version: 900_000 + Math.floor(Math.random() * 90_000), body: 'wipe test' } });
    await p.supportGrant.create({ data: { userId: admin.id, businessId: biz.id, reason: 'wipe test grant', expiresAt: new Date(Date.now() + 60_000) } });

    // the fixture really has a row in every table of the schema
    const tables: string[] = (await p.$queryRawUnsafe(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`)).map((r: any) => r.table_name);
    const count = async (t: string): Promise<number> => Number(((await p.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${t}"`)) as any[])[0].n);
    for (const t of tables) expect({ table: t, rows: await count(t) > 0 }).toEqual({ table: t, rows: true });

    await db.clearAll();

    for (const t of tables) {
      if (t in SURVIVORS) continue;
      expect({ table: t, rows: await count(t) }).toEqual({ table: t, rows: 0 });
    }
    // survivors: exactly the admin account (+ its session, recovery code and passkey) and the deletion queue (now holding the call's recording too)
    expect((await p.user.findMany({ select: { role: true } })).every((u: any) => u.role === 'admin')).toBe(true);
    expect(await p.user.count({ where: { id: admin.id } })).toBe(1);
    expect(await p.user.count({ where: { id: owner.id } })).toBe(0);
    expect(await p.userSession.count({ where: { userId: admin.id } })).toBe(1);
    expect(await p.platformSetting.count({ where: { key: `t.${run}` } })).toBe(1); // console configuration survives a demo reset
    await p.platformSettingRevision.deleteMany({ where: { changeSetId: cs.id } });
    await p.settingChangeSet.deleteMany({ where: { id: cs.id } });
    await p.platformSetting.deleteMany({ where: { key: `t.${run}` } });
    await p.instanceHeartbeat.deleteMany({ where: { instanceId: `i_${run}` } });
    await p.legalPageVersion.deleteMany({ where: { body: 'wipe test' } });
    expect(await p.userSession.count({ where: { tokenHash: `t3_${run}` } })).toBe(1); // the break-glass admin session of whoever pressed reset
    expect(await p.userSession.count({ where: { tokenHash: `t1_${run}` } })).toBe(0);
    expect(await p.recoveryCode.count({ where: { userId: admin.id } })).toBe(1);
    expect(await p.passkeyCredential.count({ where: { userId: admin.id } })).toBe(1);
    expect(await p.passkeyCredential.count({ where: { credentialId: `cred1_${run}` } })).toBe(0);
    const queued = await p.pendingRecordingDeletion.findMany({ select: { recordingSid: true } });
    expect(queued.map((q: any) => q.recordingSid)).toContain(`RE${hex(2)}`);
    expect(queued.length).toBeGreaterThanOrEqual(2);
    // every table is either wiped or an explained survivor (a new table must be decided here)
    for (const t of tables) if (!(t in SURVIVORS)) expect(await count(t)).toBe(0);
    await p.userSession.deleteMany({ where: { tokenHash: `t3_${run}` } });
    await p.user.deleteMany({ where: { id: admin.id } });
    await p.pendingRecordingDeletion.deleteMany({ where: { recordingSid: { in: [`RE${hex(2)}`, `RE${hex(4)}`] } } });
  }, 60_000);
});
