/**
 * Fixes for the adversarial review 23 (docs/review/23-adv-final-verification.md), against a real Postgres. Fake providers only (every outbound request is a
 * fake that replaces `fetch` for the length of one call and always restores it; nothing leaves the machine). Time-of-day independent (awake zones, business-local slots).
 * A1/A2 (sender recording, recorded-sender routing, Messaging Service), A4 (release rotation), A6 (briefing cap), A7 (deposit row locks), A8 (legacy forward erasure).
 * A5 and A9 live in tenant-line.test.ts (they need its provider fakes).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { integration, outboundCalls, SECRETS, withEnv } from '../helpers/env';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { awakeTimezone, cleanup, loadDb, loadPrisma, newBusiness, phone, twilioSignature, uniq } from '../helpers/fixtures';

const PLATFORM = '+15005550006';
const SERVICE = `MG${'a1'.repeat(16)}`;
const TW = { TWILIO_ACCOUNT_SID: 'ACtest0000000000000000000000000000', TWILIO_PHONE_NUMBER: PLATFORM, APP_URL: 'https://app.example.test', TWILIO_MESSAGING_SERVICE_SID: undefined, TWILIO_MESSAGING_SERVICE_PIN_SENDER: undefined } as Record<string, string | undefined>;

integration('review 23 fixes (postgres)', () => {
  let db: Awaited<ReturnType<typeof loadDb>>;
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let inbound: (req: Request) => Promise<Response>;
  let status: (req: Request) => Promise<Response>;
  const bizIds: string[] = [];

  beforeAll(async () => {
    db = await loadDb(); prisma = await loadPrisma();
    inbound = (await import('@/app/api/sms/inbound/route')).POST;
    status = (await import('@/app/api/sms/status/route')).POST;
  });
  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { businessId: { in: bizIds } } });
    await cleanup();
    expect(outboundCalls).toEqual([]);
  });
  beforeEach(async () => {
    await prisma.rateLimitBucket.deleteMany({ where: { OR: [{ key: { startsWith: 'inbox' } }, { key: { startsWith: 'sms-cancel' } }, { key: { startsWith: 'briefing-audio' } }] } });
  });

  const realNumber = (): string => { for (;;) { const n = `+1786${2_000_000 + Math.floor(Math.random() * 7_000_000)}`; if (!/555\d{4}$/.test(n)) return n; } };
  const mockNumber = (): string => `+1305555${String(1000 + Math.floor(Math.random() * 8999))}`;
  async function biz(phoneNumber: string) {
    const b = await newBusiness({ timezone: awakeTimezone() });
    bizIds.push(b.id);
    await db.updateBusiness(b.id, { phone: phoneNumber });
    return (await db.getBusiness(b.id))!;
  }
  const signed = async (route: (r: Request) => Promise<Response>, path: string, params: Record<string, string>) => {
    const url = `${SECRETS.publicBase}${path}`;
    return route(new Request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(url, params) }, body: new URLSearchParams(params).toString() }));
  };
  const text = async (to: string, from: string, body: string) => signed(inbound, '/api/sms/inbound', { From: from, To: to, Body: body, MessageSid: uniq('SM') });
  const callback = (sid: string, fromNumber: string, st = 'sent', extra: Record<string, string> = {}) => signed(status, '/api/sms/status', { MessageSid: sid, MessageStatus: st, From: fromNumber, To: '+13050000000', ...extra });
  const inbox = (id: string) => prisma.inboundMessage.findMany({ where: { businessId: id } });
  const logRows = (id: string, kind: string) => prisma.smsLog.findMany({ where: { businessId: id, kind }, orderBy: { createdAt: 'asc' } });

  type Send = { to: string; from: string | null; service: string | null; callback: string | null; body: string };
  /** A fake Twilio Messages API. `answer` decides each send (default 201 with a fresh sid and no `from`, like a Messaging Service accept). */
  async function withTwilio<T>(env: Record<string, string | undefined>, fn: (sends: Send[]) => Promise<T>, answer?: (s: Send) => Response): Promise<T> {
    const sends: Send[] = [];
    const prev = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      if (!url.includes('api.twilio.com') || !url.endsWith('/Messages.json')) throw new Error(`unexpected fetch ${url}`);
      const p = new URLSearchParams(String(init?.body));
      const s: Send = { to: p.get('To') as string, from: p.get('From'), service: p.get('MessagingServiceSid'), callback: p.get('StatusCallback'), body: p.get('Body') as string };
      sends.push(s);
      return answer ? answer(s) : Response.json({ sid: `SM${uniq('x')}` }, { status: 201 });
    }) as typeof fetch;
    try { return await withEnv({ ...TW, ...env }, () => fn(sends)); } finally { globalThis.fetch = prev; }
  }

  // ================================================================== A1: the reproduction of the review
  test('23 A1: a reply to the shared sender goes ONLY to the business that really texted from it (not to the business that texted the customer last from its own number); STOP stops only that one', async () => {
    const a = await biz(realNumber());
    const b = await biz(realNumber());
    const customer = phone();
    await withTwilio({}, async (sends) => {
      // B's own number is refused by Twilio (21606): B's acknowledgement falls back to the shared sender
      await text(b.phone!, customer, 'Hello B, I need an estimate');
      // then the customer texts A: A's acknowledgement goes out from A's own number (most recent outbound text to this customer)
      await text(a.phone!, customer, 'Hello A, are you open');
      expect(sends.filter((s) => s.to === customer).map((s) => s.from)).toEqual([b.phone, PLATFORM, a.phone]); // B's own number refused (21606), then the shared sender; A's own number worked
      const rowB = (await logRows(b.id, 'inbox_autoreply'))[0];
      expect(rowB).toMatchObject({ status: 'sent', fromE164: PLATFORM, senderKind: 'shared' });
      expect((await logRows(a.id, 'inbox_autoreply'))[0]).toMatchObject({ fromE164: a.phone, senderKind: 'tenant' });
      // the customer answers the text they received from the SHARED number
      const reply = await text(PLATFORM, customer, 'My budget for the remodel is 40k, my address is 12 Elm St');
      expect(reply.status).toBe(200);
      expect((await inbox(b.id)).map((m) => m.body)).toContain('My budget for the remodel is 40k, my address is 12 Elm St');
      expect((await inbox(a.id)).map((m) => m.body)).not.toContain('My budget for the remodel is 40k, my address is 12 Elm St'); // the leak of the review
      // STOP to the shared sender: only B texted from it
      expect(await (await text(PLATFORM, customer, 'STOP')).text()).toContain('unsubscribed');
      expect(await db.isOptedOut(b.id, customer)).toBe(true);
      expect(await db.isOptedOut(a.id, customer)).toBe(false);
    }, (s) => (s.from && s.from !== PLATFORM && s.to !== '' && s.from === b.phone ? Response.json({ code: 21606, message: 'not SMS capable' }, { status: 400 }) : Response.json({ sid: `SM${uniq('x')}` }, { status: 201 })));
  });

  test('23 A1: when more than one business texted the customer from the shared sender nothing business-specific runs: no "C" cancel, no inbox row, STOP stops each, owners are flagged without the customer\'s words', async () => {
    const a = await biz(mockNumber());
    const c = await biz(mockNumber());
    const customer = phone();
    await prisma.booking.create({ data: { businessId: a.id, customerName: 'Cust', customerPhone: customer, phoneE164: customer, service: 'AC repair', scheduledAt: new Date(Date.now() + 3 * 86_400_000), status: 'confirmed' } });
    await withTwilio({}, async () => {
      await text(a.phone!, customer, 'Hello from a customer of A');
      await text(c.phone!, customer, 'Hello to C as well');
      const before = (await inbox(a.id)).length + (await inbox(c.id)).length;
      const cancel = await text(PLATFORM, customer, 'C');
      expect(await cancel.text()).toContain('Thanks, we got your message');
      expect((await prisma.booking.findFirst({ where: { businessId: a.id } }))!.status).toBe('confirmed'); // A's booking was NOT cancelled by a text that may have been about C
      const rating = await text(PLATFORM, customer, '4');
      expect(await rating.text()).toContain('Thanks, we got your message');
      expect((await inbox(a.id)).length + (await inbox(c.id)).length).toBe(before); // stored nowhere, never guessed
      for (const id of [a.id, c.id]) {
        expect(await prisma.auditEvent.count({ where: { businessId: id, action: 'sms.inbound_ambiguous' } })).toBeGreaterThanOrEqual(2);
        const flag = (await logRows(id, 'owner_alert')).filter((r) => r.body.includes('Ambiguous customer text'));
        expect(flag).toHaveLength(1); // one flag per customer per window, and its log row holds no words
        expect(flag[0].body).not.toMatch(/budget|Hello/);
      }
      expect(await (await text(PLATFORM, customer, 'STOP')).text()).toContain('unsubscribed');
      expect(await db.isOptedOut(a.id, customer)).toBe(true);
      expect(await db.isOptedOut(c.id, customer)).toBe(true);
    });
  });

  // ================================================================== A2: the Messaging Service
  test('23 A2: with TWILIO_MESSAGING_SERVICE_SID customer texts are sent with MessagingServiceSid (no From) and a StatusCallback; the sender is learned from the callback; replies route by it', async () => {
    const a = await biz(realNumber());
    const b = await biz(realNumber());
    const customer = phone();
    await withTwilio({ TWILIO_MESSAGING_SERVICE_SID: SERVICE }, async (sends) => {
      await text(b.phone!, customer, 'Hello B, how much for a tune-up');
      const toCustomer = sends.filter((s) => s.to === customer);
      expect(toCustomer).toHaveLength(1);
      expect(toCustomer[0]).toMatchObject({ from: null, service: SERVICE, callback: 'https://app.example.test/api/sms/status' });
      const row = (await logRows(b.id, 'inbox_autoreply'))[0];
      expect(row).toMatchObject({ senderKind: 'service', fromE164: null }); // Twilio has not said which pool number sent it yet
      // the customer answers on A's number (the pool sent B's text from somewhere we cannot see yet): never guessed
      const early = await text(a.phone!, customer, 'Can you also come Friday?');
      expect(await early.text()).toContain('Thanks, we got your message');
      expect((await inbox(a.id)).length).toBe(0);
      // Twilio's status callback names the sender: B's own number
      expect((await callback(row.providerId!, b.phone!)).status).toBe(200);
      expect((await prisma.smsLog.findUnique({ where: { id: row.id } }))!.fromE164).toBe(b.phone);
      // a reply to B's number is B's; a reply to A's number is A's again (no text of B came from A's number)
      await text(b.phone!, customer, 'Thursday works');
      expect((await inbox(b.id)).map((m) => m.body)).toContain('Thursday works');
      await text(a.phone!, customer, 'Can you also come Friday?');
      expect((await inbox(a.id)).map((m) => m.body)).toContain('Can you also come Friday?');
      // a callback can never overwrite a sender that is already known, nor learn one for a row that was not a service text
      await callback(row.providerId!, '+13059999999');
      expect((await prisma.smsLog.findUnique({ where: { id: row.id } }))!.fromE164).toBe(b.phone);
    });
  });

  test('23 A2: the pool picked ANOTHER tenant\'s number for a text: a reply to that number is ambiguous, never delivered to the number\'s owner as if it were theirs', async () => {
    const a = await biz(realNumber());
    const b = await biz(realNumber());
    const customer = phone();
    await withTwilio({ TWILIO_MESSAGING_SERVICE_SID: SERVICE }, async () => {
      await text(b.phone!, customer, 'Hello B');
      const row = (await logRows(b.id, 'inbox_autoreply'))[0];
      await callback(row.providerId!, a.phone!); // the pool sent B's text from A's number
      const reply = await text(a.phone!, customer, 'Is Saturday OK for the quote?');
      expect(await reply.text()).toContain('Thanks, we got your message');
      expect((await inbox(a.id)).length).toBe(0);
      expect((await inbox(b.id)).length).toBe(1); // only the original "Hello B": the reply was not stored by anyone
    });
  });

  test('23 A2: TWILIO_MESSAGING_SERVICE_PIN_SENDER=on also passes the tenant number as From (the sender is known at once); an unusable Messaging Service falls back to the tenant number', async () => {
    const b = await biz(realNumber());
    const c = await biz(realNumber());
    const customer = phone();
    await withTwilio({ TWILIO_MESSAGING_SERVICE_SID: SERVICE, TWILIO_MESSAGING_SERVICE_PIN_SENDER: 'on' }, async (sends) => {
      await text(b.phone!, customer, 'Hello B');
      expect(sends.find((s) => s.to === customer)).toMatchObject({ from: b.phone, service: SERVICE });
      expect((await logRows(b.id, 'inbox_autoreply'))[0]).toMatchObject({ senderKind: 'service', fromE164: b.phone });
    });
    await withTwilio({ TWILIO_MESSAGING_SERVICE_SID: SERVICE }, async (sends) => {
      await text(c.phone!, customer, 'Hello C');
      const mine = sends.filter((s) => s.to === customer);
      expect(mine.map((s) => [s.service, s.from])).toEqual([[SERVICE, null], [null, c.phone]]); // refused (404): the same text again from the tenant number
      expect((await logRows(c.id, 'inbox_autoreply'))[0]).toMatchObject({ status: 'sent', senderKind: 'tenant', fromE164: c.phone });
    }, (s) => (s.service && s.to === customer ? Response.json({ code: 20404, message: 'not found' }, { status: 404 }) : Response.json({ sid: `SM${uniq('x')}` }, { status: 201 })));
  });

  test('23 A2: the status callback surfaces a delivery failure (an unregistered A2P number) as an audit event without the text; a bad signature is refused', async () => {
    const a = await biz(realNumber());
    const customer = phone();
    await withTwilio({}, async () => {
      await text(a.phone!, customer, 'Hello A');
      const row = (await logRows(a.id, 'inbox_autoreply'))[0];
      expect((await callback(row.providerId!, a.phone!, 'undelivered', { ErrorCode: '30007' })).status).toBe(200);
      const ev = await prisma.auditEvent.findFirst({ where: { businessId: a.id, action: 'sms.delivery_failed' } });
      expect(ev?.meta).toMatchObject({ status: 'undelivered', error_code: '30007', kind: 'inbox_autoreply' });
      expect(JSON.stringify(ev?.meta)).not.toContain('Hello');
      const bad = await status(new Request(`${SECRETS.publicBase}/api/sms/status`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'nope' }, body: new URLSearchParams({ MessageSid: row.providerId!, MessageStatus: 'failed' }).toString() }));
      expect(bad.status).toBe(403);
    });
  });

  // ================================================================== A4: a stuck release cannot starve the others
  test('23 A4: a tenant whose release fails every time (5 failed attempts) is flagged ONCE and skipped; healthy tenants are released in the same run; attempts rotate least-recent first', async () => {
    const release = await import('@/lib/billing/release');
    const { runTenantReleaseJob } = await import('@/lib/jobs/tenants');
    const sharedLine = `phnum_shared_${uniq('s')}`;
    async function canceled(extra: Record<string, unknown>) {
      const b = await newBusiness({ agent_id: `agent_rel_${uniq('a')}` });
      bizIds.push(b.id);
      const num = realNumber();
      await prisma.business.update({ where: { id: b.id }, data: { billingStatus: 'canceled', plan: 'standard', currentPeriodEnd: new Date(Date.now() - 90 * 86_400_000), phone: num, phoneE164: num, phoneKey: num.slice(-10), status: 'live', ...extra } });
      await prisma.auditEvent.create({ data: { actorKind: 'system', businessId: b.id, action: 'billing.release_notice', target: `business:${b.id}`, meta: { notified_at: new Date(Date.now() - 40 * 86_400_000).toISOString() }, at: new Date(Date.now() - 40 * 86_400_000) } });
      return b.id;
    }
    // created FIRST (oldest): the one the old ordering always processed first
    const poison = await canceled({ elevenlabsPhoneNumberId: sharedLine });
    const healthy = await canceled({ elevenlabsPhoneNumberId: `phnum_${uniq('h')}` });
    for (let i = 0; i < release.STUCK_AFTER_FAILED_ATTEMPTS; i++) {
      await prisma.auditEvent.create({ data: { actorKind: 'system', businessId: poison, action: release.RELEASED_ACTION, target: `business:${poison}`, meta: { errors: ['line: that is the shared ELEVENLABS_PHONE_NUMBER_ID fallback line'] }, at: new Date(Date.now() - (6 - i) * 3_600_000) } });
    }
    const healthyAgent = (await db.getBusiness(healthy))!.agent_id;
    const poisonAgent = (await db.getBusiness(poison))!.agent_id;
    const states = await release.listReleaseCandidateStates();
    const mine = states.filter((s) => s.id === poison || s.id === healthy);
    expect(mine.map((s) => s.id)).toEqual([healthy, poison]); // never attempted first; the failing one goes to the back
    expect(mine.find((s) => s.id === poison)).toMatchObject({ failed_attempts: release.STUCK_AFTER_FAILED_ATTEMPTS, stuck: true });
    // a week later it is tried again
    expect((await release.listReleaseCandidateStates(new Date(Date.now() + 8 * 86_400_000))).find((s) => s.id === poison)!.stuck).toBe(false);

    const prev = globalThis.fetch;
    const agentDeletes: string[] = [];
    globalThis.fetch = (async (u: unknown, init?: { method?: string }) => {
      const url = String(u);
      const method = init?.method ?? 'GET';
      if (method === 'DELETE' && /convai\/agents\//.test(url)) agentDeletes.push(url);
      return Response.json({});
    }) as typeof fetch;
    try {
      const runOnce = () => withEnv({ TENANT_RELEASE_JOB: 'on', ELEVENLABS_API_KEY: 'xi-test', ELEVENLABS_PHONE_NUMBER_ID: sharedLine, ...TW }, () => runTenantReleaseJob({ dryRun: false, now: new Date() }));
      const first = await runOnce();
      expect(first.items.find((i) => i.business_id === poison)).toMatchObject({ outcome: 'needs_operator' });
      expect(first.items.find((i) => i.business_id === healthy)?.outcome).toBe('released');
      expect(agentDeletes.some((u) => u.includes((healthyAgent as string)))).toBe(true); // the healthy tenant's agent was really deleted
      expect(agentDeletes.some((u) => u.includes((poisonAgent as string)))).toBe(false);
      expect(await prisma.auditEvent.count({ where: { businessId: poison, action: release.STUCK_ACTION } })).toBe(1);
      await runOnce();
      expect(await prisma.auditEvent.count({ where: { businessId: poison, action: release.STUCK_ACTION } })).toBe(1); // flagged once per episode, not once per run
      expect((await db.getBusiness(poison))!.elevenlabs_phone_number_id).toBe(sharedLine); // never touched: the shared line is never deleted
    } finally { globalThis.fetch = prev; }
  });

  // ================================================================== A6: the briefing audio cap counts what is really synthesized
  test('23 A6: the daily cap counts a re-synthesis even when the clip is hashed (another voice, an unusable stored voice); a clip that really is reused never counts', async () => {
    const { canReuseBriefingAudio, transcriptHash } = await import('@/lib/briefing');
    const t = 'Good morning, three calls today.';
    const h = transcriptHash(t);
    const { briefingVoiceId } = await import('@/lib/briefing/tts');
    const voice = briefingVoiceId({ voice_id: null });
    expect(canReuseBriefingAudio({ text_hash: h, voice_id: voice }, t, { voice_id: null })).toBe(true);
    expect(canReuseBriefingAudio({ text_hash: h, voice_id: voice }, t, { voice_id: 'Another_Voice_1' })).toBe(false); // the owner changed the voice: it IS synthesized again
    expect(canReuseBriefingAudio({ text_hash: h, voice_id: 'Another_Voice_1' }, t, { voice_id: 'Another_Voice_1' })).toBe(true);
    expect(canReuseBriefingAudio({ text_hash: h, voice_id: voice }, t, { voice_id: 'not a plain token!' })).toBe(true); // an unusable choice resolves to the default voice, exactly as synthesis does
    expect(canReuseBriefingAudio({ text_hash: h, voice_id: null }, t, { voice_id: null })).toBe(false); // unknown stored voice
    expect(canReuseBriefingAudio({ text_hash: null, voice_id: voice }, t, { voice_id: null })).toBe(false);
    expect(canReuseBriefingAudio({ text_hash: h, voice_id: voice }, 'a different text', { voice_id: null })).toBe(false);
    expect(canReuseBriefingAudio(null, t, { voice_id: null })).toBe(false);
  });

  test('23 A6 (route): at the daily limit a voice change is refused (429) while the same text and voice is still answered from the stored clip', async () => {
    const route = await import('@/app/api/briefings/[id]/audio/route');
    const BRIEFING_AUDIO_DAILY_LIMIT = route.BRIEFING_AUDIO_DAILY_LIMIT;
    const b = await newBusiness({ timezone: awakeTimezone() });
    bizIds.push(b.id);
    const briefing = await prisma.briefing.create({ data: { businessId: b.id, date: '2030-01-01', transcript: 'Good morning, one call today.', stats: {} } });
    const { transcriptHash } = await import('@/lib/briefing');
    const { briefingVoiceId } = await import('@/lib/briefing/tts');
    await prisma.$executeRaw`INSERT INTO "briefing_audio" ("id","briefing_id","content_type","bytes","voice_id","text_hash") VALUES (${uniq('ba')}, ${briefing.id}, 'audio/mpeg', ${Buffer.from([1, 2, 3])}, ${briefingVoiceId({ voice_id: null })}, ${transcriptHash(briefing.transcript)})`;
    for (let i = 0; i < BRIEFING_AUDIO_DAILY_LIMIT; i++) {
      await prisma.auditEvent.create({ data: { actorKind: 'system', businessId: b.id, action: 'briefing.audio_regenerated', target: `briefing:${briefing.id}`, meta: { synthesized: true, status: 'ready' } } });
    }
    const post = () => route.POST(new Request(`https://app.example.test/api/briefings/${briefing.id}/audio`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRETS.adminToken}`, 'sec-fetch-site': 'same-origin', origin: 'https://app.example.test' } }), { params: Promise.resolve({ id: briefing.id }) });
    const reused = await post();
    expect(reused.status).toBe(200); // same text, same voice: nothing is synthesized, the limit does not apply
    await db.updateBusiness(b.id, { voice_id: 'Another_Voice_1' } as any);
    const changed = await post();
    expect(changed.status).toBe(429);
    expect(((await changed.json()) as any).code).toBe('audio_daily_limit');
  });

  // ================================================================== A7: row locks between the manual mark, the card payment and the unmark
  test('23 A7: a manual mark racing a card payment converts exactly once and reports the double payment; an unmark racing a card payment never erases the card payment', async () => {
    const { markDepositPaid } = db;
    for (let round = 0; round < 6; round++) {
      const b = await newBusiness({ timezone: awakeTimezone() });
      bizIds.push(b.id);
      const bk = await prisma.booking.create({ data: { businessId: b.id, customerName: 'Dana', customerPhone: phone(), service: 'AC', scheduledAt: new Date(Date.now() + 4 * 86_400_000 + round * 3_600_000), status: 'pending', depositAmount: 4000 } });
      await db.markDepositPaidManually(b.id, bk.id, { kind: 'admin_token' }, { amount_cents: 4000 });
      // card payment and unmark at the same instant
      const [card, unmark] = await Promise.all([markDepositPaid(bk.id, 5000), db.unmarkManualDeposit(b.id, bk.id, { kind: 'admin_token' })]);
      const row = await prisma.booking.findUniqueOrThrow({ where: { id: bk.id } });
      if (unmark.ok) {
        // the unmark won the lock: the card payment then landed on an unpaid booking (nothing manual to report) and the row is paid by card
        expect(card.replaced_manual).toBeNull();
      } else {
        expect(card.replaced_manual).not.toBeNull(); // the card payment won: it saw the manual mark, so the owner is told they paid twice
      }
      expect(row).toMatchObject({ depositPaid: true, depositSource: 'stripe', depositAmount: 5000 }); // in BOTH orders the card payment survives
    }
    // manual mark racing a card payment on an UNPAID deposit
    for (let round = 0; round < 6; round++) {
      const b = await newBusiness({ timezone: awakeTimezone() });
      bizIds.push(b.id);
      const bk = await prisma.booking.create({ data: { businessId: b.id, customerName: 'Dana', customerPhone: phone(), service: 'AC', scheduledAt: new Date(Date.now() + 4 * 86_400_000), status: 'pending', depositAmount: 4000 } });
      const [manual, card] = await Promise.all([db.markDepositPaidManually(b.id, bk.id, { kind: 'admin_token' }, { amount_cents: 4000 }), markDepositPaid(bk.id, 4000)]);
      const row = await prisma.booking.findUniqueOrThrow({ where: { id: bk.id } });
      expect(row.depositPaid).toBe(true);
      if (manual.ok) expect(card.replaced_manual).not.toBeNull(); // the manual mark committed first: the card payment replaces it and reports it (the lost report of the review)
      else expect(manual).toMatchObject({ ok: false, reason: 'already_paid' }); // the card payment committed first: a manual mark never overrides it
      expect(row.depositSource).toBe('stripe');
    }
  });

  // ================================================================== A8: legacy owner-forward erasure
  test('23 A8: erasure finds legacy owner-forward rows whose quoted words started with a link, an emoji or non-Latin letters, and ones with the "Possible opt-out" prefix, but never another customer\'s', async () => {
    const b = await newBusiness({ timezone: awakeTimezone() });
    bizIds.push(b.id);
    const customer = phone();
    const other = phone().slice(0, -4) + customer.slice(-4); // another customer with the SAME last 4 digits
    const { safeForward } = await import('@/lib/messaging/inbox-copy');
    const { clampAlertBody } = await import('@/lib/voice/owner-alert');
    const words = ['https://pay.example.com/x please call me about the Elm Street estimate', '😀😀 quiero una cotización para el jardín de la casa', 'Привет, мне нужна смета на ремонт кухни', 'Hello, what time do you open on Saturdays'];
    const legacy = async (body: string, prefix = '') => (await prisma.smsLog.create({ data: { businessId: b.id, toPhone: '+13055550100', body: clampAlertBody(`${prefix}Customer text (...${customer.slice(-4)}): "${safeForward(body, 140)}". Reply from Messages in the dashboard.`), kind: 'owner_alert', status: 'sent' } })).id;
    const ids: string[] = [];
    for (const w of words) {
      await prisma.inboundMessage.create({ data: { businessId: b.id, fromE164: customer, fromPhone: customer, body: w, twilioMessageSid: uniq('SM') } });
      ids.push(await legacy(w, w === words[3] ? 'Possible opt-out: ' : ''));
    }
    const otherRow = await legacy('Totally different message from somebody else entirely');
    await prisma.inboundMessage.create({ data: { businessId: b.id, fromE164: other, fromPhone: other, body: 'Totally different message from somebody else entirely', twilioMessageSid: uniq('SM') } });
    const found = await db.prisma.$transaction(async (tx) => (await import('@/lib/db/compliance')).locateCustomerRecords(tx as any, b.id, (await import('@/lib/db/compliance')).phoneIdent(customer)));
    for (const id of ids) expect(found.smsIds).toContain(id);
    expect(found.smsIds).not.toContain(otherRow);
  });
});
