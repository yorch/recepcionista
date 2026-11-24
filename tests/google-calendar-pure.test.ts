import { expect, test } from 'bun:test';

process.env.APP_SECRET_KEY ??= Buffer.alloc(32, 9).toString('base64');

test('state is signed, expiring and tamper-evident; PKCE verifier is sealed to its nonce', async () => {
  const { signState, verifyState, newPkce, sealVerifier, openVerifier, STATE_TTL_MS } = await import('../src/lib/integrations/google/state');
  const { state, nonce } = signState({ u: 'u1', b: 'b1', s: 's1' }, 1000);
  expect(verifyState(state, 1000)).toMatchObject({ u: 'u1', b: 'b1', s: 's1', n: nonce });
  expect(verifyState(state, 1000 + STATE_TTL_MS + 1)).toBeNull();
  const [body, sig] = state.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), b: 'other' })).toString('base64url');
  expect(verifyState(`${forged}.${sig}`, 1000)).toBeNull();
  expect(verifyState('garbage', 1000)).toBeNull();
  expect(verifyState(null)).toBeNull();
  const { verifier } = newPkce();
  const sealed = sealVerifier(verifier, nonce);
  expect(openVerifier(sealed, nonce)).toBe(verifier);
  expect(openVerifier(sealed, 'another-nonce')).toBeNull();
});

test('mapEvent: timed instants, all-day local days across DST, cancelled/declined/working-location dropped, windowing', async () => {
  const { mapEvent } = await import('../src/lib/integrations/google/sync');
  const now = new Date('2027-03-01T12:00:00Z');
  const tz = 'America/New_York';
  const timed = mapEvent({ id: 'a', start: { dateTime: '2027-03-05T10:00:00-05:00' }, end: { dateTime: '2027-03-05T11:00:00-05:00' } }, tz, now);
  expect(timed).toMatchObject({ kind: 'block', block: { all_day: false, transparency: 'opaque' } });
  const dst = mapEvent({ id: 'b', start: { date: '2027-03-14' }, end: { date: '2027-03-15' } }, tz, now);
  expect(dst.kind).toBe('block');
  if (dst.kind === 'block') expect((new Date(dst.block.ends_at).getTime() - new Date(dst.block.starts_at).getTime()) / 3600_000).toBe(23);
  const fall = mapEvent({ id: 'c', start: { date: '2027-11-07' }, end: { date: '2027-11-08' } }, tz, new Date('2027-11-01T00:00:00Z'));
  if (fall.kind === 'block') expect((new Date(fall.block.ends_at).getTime() - new Date(fall.block.starts_at).getTime()) / 3600_000).toBe(25);
  expect(mapEvent({ id: 'd', status: 'cancelled', start: { date: '2027-03-05' } }, tz, now).kind).toBe('drop');
  expect(mapEvent({ id: 'e', eventType: 'workingLocation', start: { date: '2027-03-05' }, end: { date: '2027-03-06' } }, tz, now).kind).toBe('drop');
  expect(mapEvent({ id: 'f', start: { dateTime: '2027-03-05T10:00:00Z' }, end: { dateTime: '2027-03-05T11:00:00Z' }, attendees: [{ self: true, responseStatus: 'declined' }] }, tz, now).kind).toBe('drop');
  expect(mapEvent({ id: 'g', start: { dateTime: '2020-03-05T10:00:00Z' }, end: { dateTime: '2020-03-05T11:00:00Z' } }, tz, now).kind).toBe('drop'); // long past
  expect(mapEvent({ id: 'h', start: { dateTime: '2030-03-05T10:00:00Z' }, end: { dateTime: '2030-03-05T11:00:00Z' } }, tz, now).kind).toBe('drop'); // beyond horizon
  expect(mapEvent({ id: 'i', transparency: 'transparent', start: { dateTime: '2027-03-05T10:00:00Z' }, end: { dateTime: '2027-03-05T11:00:00Z' } }, tz, now)).toMatchObject({ block: { transparency: 'transparent' } });
});

test('sync token encoding and event ids', async () => {
  const { encodeToken, decodeToken } = await import('../src/lib/integrations/google/sync');
  expect(decodeToken(encodeToken('abc:def', 5))).toEqual({ token: 'abc:def', fullAt: 5 });
  expect(decodeToken('legacy')).toBeNull();
  const { eventIdFor, buildEvent } = await import('../src/lib/integrations/google/push');
  expect(eventIdFor('b1')).toMatch(/^[0-9a-v]{5,1024}$/);
  expect(eventIdFor('b1')).toBe(eventIdFor('b1'));
  const ev = buildEvent({ id: 'b1', business_id: 'x', customer_name: 'Maria Lopez', customer_phone: '+13055550100', service: 'AC repair', scheduled_at: '2027-03-05T15:00:00Z', duration_minutes: 90, status: 'confirmed', deposit_paid: false, created_at: '' }, 'America/New_York', null);
  expect(ev.summary).toBe('AC repair — Maria');
  expect(ev.end.dateTime).toBe('2027-03-05T16:30:00.000Z');
});

test('channel tokens are per channel and verified', async () => {
  const { channelToken, verifyChannelToken } = await import('../src/lib/integrations/google/watch');
  const t = channelToken('c1', 'ch1');
  expect(verifyChannelToken('c1', 'ch1', t)).toBe(true);
  expect(verifyChannelToken('c2', 'ch1', t)).toBe(false);
  expect(verifyChannelToken('c1', 'ch1', null)).toBe(false);
  expect(verifyChannelToken('c1', 'ch1', t.slice(0, -1))).toBe(false);
});
