/**
 * Adversarial review 16 (owner voice reply channel), regression tests: H1 (a spoofed caller cannot walk through every lead), M1 (a failure after the
 * provider accepted the text is not "failed" and cannot produce a second copy), M2 (the daily cap is atomic), L2 (the spoof warning has a working
 * cancel path), L3 (stuck 'sending' rows, keyed erasable lead markers). Scanner shapes (L1) are in tests/owner-reply-pure.test.ts.
 */
import { integration, outboundCalls, SECRETS, withEnv } from '../helpers/env';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { awakeTimezone, cleanup, loadDb, loadPrisma, newBusiness, phone, toolRequest, twilioSignature, uniq } from '../helpers/fixtures';

integration('owner voice reply: review 16 fixes (postgres)', () => {
  let db: Awaited<ReturnType<typeof loadDb>>;
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let initiation: { POST: (req: Request) => Promise<Response> };
  let tools: (req: Request, ctx: { params: Promise<{ tool: string }> }) => Promise<Response>;
  let smsInbound: (req: Request) => Promise<Response>;

  beforeAll(async () => {
    db = await loadDb();
    prisma = await loadPrisma();
    initiation = await import('@/app/api/voice/initiation/route');
    tools = (await import('@/app/api/voice/tools/[tool]/route')).POST;
    smsInbound = (await import('@/app/api/sms/inbound/route')).POST;
  });
  afterAll(async () => { expect(outboundCalls).toEqual([]); await cleanup(); });

  const DEMO = { DEMO_MODE: 'true' };
  type Biz = Awaited<ReturnType<typeof newBusiness>>;
  const shop = async (opts: Parameters<typeof newBusiness>[0] = {}): Promise<Biz> => {
    const b = await newBusiness({ timezone: awakeTimezone(), ...opts });
    await db.upsertKnowledgeBase(b.id, { services: [{ name: 'AC Diagnostic', base_price: 89, duration_minutes: 60 }], faqs: [], pricing_notes: 'Starting prices.', system_prompt: 'old prompt', call_script: '' });
    return b;
  };
  async function dial(biz: Biz, callerId: string, verified = false) {
    const body = { caller_id: callerId, agent_id: biz.agent_id, called_number: biz.phone, call_sid: uniq('CA'), conversation_id: uniq('conv') };
    await initiation.POST(new Request('http://localhost/api/voice/initiation', { method: 'POST', headers: { 'content-type': 'application/json', 'x-recepcionista-tool-secret': SECRETS.toolSecret }, body: JSON.stringify(body) }));
    const call = (await prisma.call.findFirst({ where: { businessId: biz.id, callSid: body.call_sid } }))!;
    if (verified) await prisma.call.update({ where: { id: call.id }, data: { callerVerified: true } });
    return { body, call };
  }
  const owner = (biz: Biz, verified = false) => dial(biz, biz.owner_phone_e164!, verified);
  async function tool(biz: Biz, session: { body: { call_sid: string; conversation_id: string; caller_id: string } }, name: string, args: Record<string, unknown> = {}) {
    const res = await tools(toolRequest(name, { agent_id: biz.agent_id, business_id: biz.id, call_sid: session.body.call_sid, conversation_id: session.body.conversation_id, caller_phone: session.body.caller_id, ...args }), { params: Promise.resolve({ tool: name }) });
    return await res.json() as { ok: boolean; message: string };
  }
  async function lead(biz: Biz, o: { name?: string; e164?: string; minutesAgo?: number } = {}) {
    const e164 = o.e164 ?? phone();
    const call = await prisma.call.create({ data: { businessId: biz.id, callerPhone: e164, callerE164: e164, callerName: o.name ?? 'Maria Lopez', kind: 'customer', status: 'completed', urgency: 'routine', startedAt: new Date(Date.now() - (o.minutesAgo ?? 5) * 60_000) } });
    return { call, e164 };
  }
  const lastOwnerText = async (biz: Biz) => (await prisma.smsLog.findFirst({ where: { businessId: biz.id, kind: 'owner_alert' }, orderBy: { createdAt: 'desc' } }))?.body ?? '';
  const inbound = async (biz: Biz, from: string, body: string) => {
    const url = `${SECRETS.publicBase}/api/sms/inbound`;
    const params = { From: from, To: biz.phone!, Body: body, MessageSid: uniq('SM') };
    return (await smsInbound(new Request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(url, params) }, body: new URLSearchParams(params).toString() }))).text();
  };
  const toCustomer = (biz: Biz, e164: string) => prisma.smsLog.findMany({ where: { businessId: biz.id, kind: 'manual', toE164: e164 } });
  async function proposed(biz: Biz, l: { call: { id: string }; e164: string }, body: string, extra: Record<string, unknown> = {}) {
    const row = await prisma.ownerReply.create({ data: { businessId: biz.id, leadKind: 'call', leadCallId: l.call.id, toE164: l.e164, toName: 'Maria', body, expiresAt: new Date(Date.now() + 20 * 60_000), ...extra } });
    const { replyCode } = await import('@/lib/voice/owner/reply-sms');
    return { row, code: replyCode(biz.id, row.id) };
  }
  const last4s = (msg: string) => [...msg.matchAll(/ending (\d{4})/g)].map((m) => m[1]);

  // ------------------------------------------------------------------ H1

  test('H1: a spoofed (unverified) caller can disclose only a capped number of distinct leads a day, cannot hide more than the handled budget, and cannot hide leads from a verified owner call', async () => {
    const { OWNER_REPLY_DISCLOSED_PER_DAY, OWNER_REPLY_HANDLED_PER_DAY } = await import('@/lib/voice/owner/reply-config');
    const biz = await shop();
    for (let i = 0; i < 25; i++) await lead(biz, { name: 'Maria', minutesAgo: 1 + i });
    const seen = new Set<string>();
    await withEnv(DEMO, async () => {
      // five spoofed calls: list, then (with read-back) mark the first three handled, exactly what the review's repro did
      for (let c = 0; c < 5; c++) {
        const s = await owner(biz); // no STIR verdict: what a spoofer presents
        const list = await tool(biz, s, 'list_recent_leads');
        expect(list.ok).toBe(true);
        for (const d of last4s(list.message)) seen.add(d);
        for (let n = 1; n <= 3; n++) {
          const readBack = await tool(biz, s, 'mark_lead_handled', { lead_ref: String(n) });
          expect(readBack.ok).toBe(true);
          expect(readBack.message).toContain('Is that right?');
          await tool(biz, s, 'mark_lead_handled', { lead_ref: String(n), confirmed: true });
        }
      }
    });
    expect(seen.size).toBeLessThanOrEqual(OWNER_REPLY_DISCLOSED_PER_DAY.unverified);
    expect(seen.size).toBeGreaterThan(0);
    expect(seen.size).toBeLessThanOrEqual(OWNER_REPLY_HANDLED_PER_DAY.unverified + 5); // hiding is what lets a caller see further: five at a time, five hidden
    expect(await prisma.processedEvent.count({ where: { source: 'owner-lead-disc', id: { startsWith: `${biz.id}:u:` } } })).toBeLessThanOrEqual(OWNER_REPLY_DISCLOSED_PER_DAY.unverified);
    expect(await prisma.processedEvent.count({ where: { source: 'owner-lead-handled-log', id: { startsWith: `${biz.id}:u:` } } })).toBeLessThanOrEqual(OWNER_REPLY_HANDLED_PER_DAY.unverified);
    expect(await prisma.processedEvent.count({ where: { source: 'owner-lead-handled' } })).toBeGreaterThan(0);
    // the REAL owner (a carrier-verified call) still hears the newest customers: unverified marks never hide anything from a verified listing
    await withEnv(DEMO, async () => {
      const real = await owner(biz, true);
      const list = await tool(biz, real, 'list_recent_leads');
      expect(list.ok).toBe(true);
      expect(list.message).toContain('Number 1:');
      expect(list.message).not.toMatch(/no recent customers/);
      expect(last4s(list.message)).toHaveLength(5);
    });
  });

  test('H1: mark_lead_handled needs the read-back, a per-call cap and the per-day budget; only listed numbers work', async () => {
    const biz = await shop();
    for (let i = 0; i < 6; i++) await lead(biz, { minutesAgo: 1 + i });
    await withEnv(DEMO, async () => {
      const s = await owner(biz, true);
      expect((await tool(biz, s, 'mark_lead_handled', { lead_ref: '1' })).ok).toBe(false); // nothing listed on this call yet: no number is valid
      await tool(biz, s, 'list_recent_leads');
      expect((await tool(biz, s, 'mark_lead_handled', { lead_ref: '1', confirmed: true })).ok).toBe(false); // no read-back first
      expect((await tool(biz, s, 'mark_lead_handled', { lead_ref: '1' })).ok).toBe(true);
      expect((await tool(biz, s, 'list_recent_leads')).message).toContain('Number 1:'); // nothing hidden yet
      await tool(biz, s, 'list_recent_leads');
      let done = 0;
      for (let n = 1; n <= 4; n++) {
        await tool(biz, s, 'mark_lead_handled', { lead_ref: String(n) });
        if ((await tool(biz, s, 'mark_lead_handled', { lead_ref: String(n), confirmed: true })).ok) done++;
      }
      expect(done).toBe(3); // OWNER_REPLY_HANDLED_PER_CALL
      expect((await tool(biz, s, 'mark_lead_handled', { lead_ref: '9', confirmed: true })).ok).toBe(false);
    });
  });

  test('H1: when the day\'s disclosure budget of an identity class is spent, a list reveals nothing new (already-disclosed leads stay listable)', async () => {
    const { OWNER_REPLY_DISCLOSED_PER_DAY } = await import('@/lib/voice/owner/reply-config');
    const biz = await shop();
    for (let i = 0; i < 12; i++) await lead(biz, { minutesAgo: 1 + i });
    await prisma.processedEvent.createMany({ data: Array.from({ length: OWNER_REPLY_DISCLOSED_PER_DAY.unverified }, (_, i) => ({ source: 'owner-lead-disc', id: `${biz.id}:u:call:old-${i}`, status: 'done' })) });
    await withEnv(DEMO, async () => {
      const spoofed = await owner(biz);
      const r = await tool(biz, spoofed, 'list_recent_leads');
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/most customers this line may hear about today/);
      expect(last4s(r.message)).toHaveLength(0);
      const real = await owner(biz, true); // the verified class has its own budget
      expect(last4s((await tool(biz, real, 'list_recent_leads')).message)).toHaveLength(5);
    });
  });

  // ------------------------------------------------------------------ M1

  test('M1: the provider took the text but the sms_log write failed: the reply is SENT (not failed), the owner is told so, and the same words cannot go out again', async () => {
    const biz = await shop();
    const l = await lead(biz);
    const a = await proposed(biz, l, 'See you at 9');
    const b = await proposed(biz, l, 'See you at 9');
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION rv16_fail_log() RETURNS trigger AS $$ BEGIN IF NEW.business_id = '${biz.id}' AND NEW.kind = 'manual' THEN RAISE EXCEPTION 'rv16 forced sms_log failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER rv16_fail_log BEFORE INSERT ON sms_log FOR EACH ROW EXECUTE FUNCTION rv16_fail_log()');
    try {
      await withEnv(DEMO, async () => {
        const answer = await inbound(biz, biz.owner_phone!, `YES ${a.code}`);
        expect(answer).toContain('Sent to Maria');
        expect(answer).not.toContain('could not be sent');
      });
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS rv16_fail_log ON sms_log');
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS rv16_fail_log()');
    }
    expect(await prisma.ownerReply.findUnique({ where: { id: a.row.id } })).toMatchObject({ status: 'sent' });
    expect((await prisma.ownerReply.findUnique({ where: { id: a.row.id } }))!.sentAt).not.toBeNull();
    // the owner believes it went out, drafts the same words again: the duplicate guard refuses the second copy
    await withEnv(DEMO, async () => {
      expect(await inbound(biz, biz.owner_phone!, `YES ${b.code}`)).toContain('same text went to this customer in the last hour');
    });
    expect(await prisma.ownerReply.findUnique({ where: { id: b.row.id } })).toMatchObject({ status: 'refused', refuseReason: 'duplicate' });
  });

  test('M1: a provider timeout is UNCERTAIN (never "failed", never retried) and the duplicate guard covers it', async () => {
    const biz = await shop();
    const l = await lead(biz);
    const a = await proposed(biz, l, 'On our way now');
    const b = await proposed(biz, l, 'On our way now');
    const saved = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error('The operation timed out'); }) as typeof fetch;
    try {
      await withEnv({ ...DEMO, TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_PHONE_NUMBER: '+15005550006' }, async () => {
        const answer = await inbound(biz, biz.owner_phone!, `YES ${a.code}`);
        expect(answer).toContain('may or may not have gone out');
        expect(answer).toContain('Check the dashboard');
        expect(await inbound(biz, biz.owner_phone!, `YES ${a.code}`)).toContain('may or may not have gone out'); // a replay says the same, sends nothing
      });
    } finally { globalThis.fetch = saved; }
    expect(await prisma.ownerReply.findUnique({ where: { id: a.row.id } })).toMatchObject({ status: 'uncertain', refuseReason: 'provider_unknown' });
    await withEnv(DEMO, async () => {
      expect(await inbound(biz, biz.owner_phone!, `YES ${b.code}`)).toContain('same text went to this customer');
    });
  });

  // ------------------------------------------------------------------ M2

  test('M2: eight racing YES texts with a daily limit of 3 send exactly 3 (sending rows count, count + claim are atomic)', async () => {
    const biz = await shop();
    const rows: Awaited<ReturnType<typeof proposed>>[] = [];
    for (let i = 0; i < 8; i++) rows.push(await proposed(biz, await lead(biz, { name: `Cust${String.fromCharCode(65 + i)}` }), `Message ${String.fromCharCode(65 + i)} for you`));
    const answers = await withEnv({ ...DEMO, OWNER_REPLY_DAILY_LIMIT: '3' }, () => Promise.all(rows.map((r) => inbound(biz, biz.owner_phone!, `YES ${r.code}`))));
    expect(answers.filter((a) => a.includes('Sent to')).length).toBe(3);
    expect(answers.filter((a) => a.includes("today&apos;s limit")).length).toBe(5);
    const statuses = (await prisma.ownerReply.findMany({ where: { businessId: biz.id } })).map((r) => r.status);
    expect(statuses.filter((s) => s === 'sent')).toHaveLength(3);
    expect(statuses.filter((s) => s === 'refused')).toHaveLength(5);
    expect(await prisma.smsLog.count({ where: { businessId: biz.id, kind: 'manual' } })).toBe(3);
  });

  // ------------------------------------------------------------------ L2

  test('L2: the spoof warning carries the code, a bare NO from the owner phone cancels every waiting draft, a bare YES only asks for the code, strangers get nothing', async () => {
    const biz = await shop();
    const l = await lead(biz);
    const s = await owner(biz);
    await withEnv(DEMO, async () => {
      await tool(biz, s, 'list_recent_leads');
      await tool(biz, s, 'draft_reply', { lead_ref: '1', message: 'Please call us', confirmed: false });
      expect((await tool(biz, s, 'draft_reply', { lead_ref: '1', message: 'Please call us', confirmed: true })).ok).toBe(true);
      const text = await lastOwnerText(biz);
      const code = /YES ([A-Z2-9]{6})/.exec(text)![1];
      expect(text).toContain(`Not you? Reply NO ${code}.`);
      expect(await inbound(biz, phone(), 'NO')).not.toContain('Cancelled'); // a stranger
      expect(await inbound(biz, biz.owner_phone!, 'YES')).toContain('with the 6-character code');
      expect((await prisma.ownerReply.findFirst({ where: { businessId: biz.id } }))!.status).toBe('proposed');
      expect(await inbound(biz, biz.owner_phone!, 'no')).toContain('Cancelled 1 waiting text');
      expect((await prisma.ownerReply.findFirst({ where: { businessId: biz.id } }))!.status).toBe('cancelled');
      expect(await toCustomer(biz, l.e164)).toHaveLength(0);
      expect(await inbound(biz, biz.owner_phone!, 'NO')).not.toContain('Cancelled'); // nothing waiting any more
    });
  });

  // ------------------------------------------------------------------ L3

  test('L3: a row stuck in "sending" is swept to "uncertain" (never retried), the dashboard says so, and a YES for it is answered honestly', async () => {
    const { sweepStaleOwnerReplies } = await import('@/lib/messaging/owner-reply');
    const { publicOwnerReply } = await import('@/lib/voice/owner/reply-view');
    const biz = await shop();
    const l = await lead(biz);
    const stuck = await proposed(biz, l, 'Stuck one', { status: 'sending', decidedAt: new Date(Date.now() - 11 * 60_000) });
    const fresh = await proposed(biz, l, 'Fresh one', { status: 'sending', decidedAt: new Date() });
    const row = (await prisma.ownerReply.findUnique({ where: { id: stuck.row.id } }))!;
    expect(publicOwnerReply(row).status).toBe('uncertain'); // even before the sweep runs
    expect(await sweepStaleOwnerReplies()).toBeGreaterThanOrEqual(1);
    expect(await prisma.ownerReply.findUnique({ where: { id: stuck.row.id } })).toMatchObject({ status: 'uncertain', refuseReason: 'stalled' });
    expect(await prisma.ownerReply.findUnique({ where: { id: fresh.row.id } })).toMatchObject({ status: 'sending' }); // still inside its grace period
    await withEnv(DEMO, async () => {
      expect(await inbound(biz, biz.owner_phone!, `YES ${stuck.code}`)).toContain('may or may not have gone out');
    });
    expect(await toCustomer(biz, l.e164)).toHaveLength(0);
    // the reconcile job runs the sweep
    await prisma.ownerReply.update({ where: { id: fresh.row.id }, data: { decidedAt: new Date(Date.now() - 20 * 60_000) } });
    const { runReconcileJob } = await import('@/lib/jobs/reconcile');
    const rep = await runReconcileJob({ now: new Date() });
    expect(rep.counts?.owner_replies_swept).toBeGreaterThanOrEqual(1);
    expect((await prisma.ownerReply.findUnique({ where: { id: fresh.row.id } }))!.status).toBe('uncertain');
  });

  test('L3: the lead-handled marker is a keyed hash (not the old unkeyed SHA-256) and erasing the customer removes it', async () => {
    const crypto = await import('node:crypto');
    const { markHandled } = await import('@/lib/voice/owner/reply-leads');
    const biz = await shop();
    const l = await lead(biz);
    await markHandled(biz.id, l.e164, 'verified');
    await markHandled(biz.id, l.e164, 'unverified');
    const old = crypto.createHash('sha256').update(`owner-lead|${biz.id}|${l.e164}`).digest('hex').slice(0, 24);
    const markers = await prisma.processedEvent.findMany({ where: { source: 'owner-lead-handled', id: { not: old } } });
    expect(markers.length).toBeGreaterThanOrEqual(2);
    expect(markers.every((m) => /^[0-9a-f]{32}$/.test(m.id))).toBe(true);
    const { handledMarkerId } = await import('@/lib/voice/owner/reply-marker');
    const ids = (['v', 'u'] as const).map((c) => handledMarkerId(biz.id, l.e164, c));
    expect(await prisma.processedEvent.count({ where: { source: 'owner-lead-handled', id: { in: ids } } })).toBe(2);
    await db.eraseCustomerData(biz.id, l.e164);
    expect(await prisma.processedEvent.count({ where: { source: 'owner-lead-handled', id: { in: ids } } })).toBe(0);
  });
});
