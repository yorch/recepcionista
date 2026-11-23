/**
 * Data + signing helpers for the integration tests. Import AFTER ./env.
 * Every business created here is registered so `cleanup()` can remove it (rows cascade).
 */
import { createHmac } from 'node:crypto';
import { SECRETS } from './env';
import { addDaysToDateKey, dayOfWeek, localDateKey } from '../../src/lib/time';
import type { Hours } from '../../src/lib/types';

export const run = Math.random().toString(36).slice(2, 8);
let seq = 0;
export const uniq = (prefix: string) => `${prefix}-${run}-${++seq}`;

/** Unique, valid North-American mobile number (+1 305 555-01xx style, 7 random digits). */
export function phone(): string {
  const n = String(1_000_000 + Math.floor(Math.random() * 8_999_999));
  return `+1305${n}`;
}

export const ALL_WEEK: Hours = Object.fromEntries(
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
    .map((d) => [d, { open: '08:00', close: '18:00' }]),
) as unknown as Hours;

export async function loadDb() {
  return await import('@/lib/db');
}
export async function loadPrisma() {
  return (await import('@/lib/db/client')).prisma;
}

const createdBusinesses: string[] = [];
const eventPrefix = `evt_it_${run}`;
export const eventId = () => `${eventPrefix}_${++seq}`;

export interface TestBusinessOptions {
  timezone?: string;
  hours?: Hours;
  agent_id?: string | null;
  owner_phone?: string | null;
  name?: string;
}

export async function newBusiness(opts: TestBusinessOptions = {}) {
  const db = await loadDb();
  const prisma = await loadPrisma();
  const b = await db.createBusiness({
    name: opts.name ?? `IT Business ${run}`,
    timezone: opts.timezone ?? 'America/New_York',
    hours: opts.hours ?? ALL_WEEK,
    owner_phone: opts.owner_phone === undefined ? phone() : opts.owner_phone,
    phone: phone(),
  });
  createdBusinesses.push(b.id);
  if (opts.agent_id !== null) {
    const agent = opts.agent_id ?? uniq('agent');
    await prisma.business.update({ where: { id: b.id }, data: { agentId: agent } });
    return { ...(await db.getBusiness(b.id))!, agent_id: agent };
  }
  return b;
}

export async function cleanup() {
  const prisma = await loadPrisma();
  await prisma.business.deleteMany({ where: { id: { in: createdBusinesses } } });
  await prisma.processedEvent.deleteMany({ where: { id: { startsWith: eventPrefix } } });
  await prisma.$disconnect();
}

// ------------------------------------------------------------------ dates

/** A local date key (in `tz`) that falls on `weekday` (0=Sunday) and is at least `minDays` ahead. */
export function futureDateKey(weekday: number, tz = 'America/New_York', minDays = 3): string {
  let key = addDaysToDateKey(localDateKey(new Date(), tz), minDays);
  while (dayOfWeek(key) !== weekday) key = addDaysToDateKey(key, 1);
  return key;
}

/** Offset-less local wall clock string for the voice tools, e.g. `2027-03-02T10:00:00`. */
export const wall = (dateKey: string, hhmm: string) => `${dateKey}T${hhmm}:00`;

/** nth (1-based) Sunday of a month (month is 1-12) as a date key. */
export function nthSunday(year: number, month: number, n: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const day = 1 + ((7 - first) % 7) + (n - 1) * 7;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The next DST transition date (US) strictly after today + 2 days. */
export function nextUsDstDay(kind: 'spring' | 'fall'): string {
  const floor = addDaysToDateKey(localDateKey(new Date(), 'America/New_York'), 2);
  const year = Number(floor.slice(0, 4));
  for (const y of [year, year + 1]) {
    const key = kind === 'spring' ? nthSunday(y, 3, 2) : nthSunday(y, 11, 1);
    if (key >= floor) return key;
  }
  throw new Error('unreachable');
}

// ---------------------------------------------------------------- signing

export function stripeSignature(payload: string, opts: { secret?: string; t?: number } = {}): string {
  const t = opts.t ?? Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', opts.secret ?? SECRETS.stripeWebhook).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

export function elevenLabsSignature(payload: string, opts: { secret?: string; t?: number } = {}): string {
  const t = opts.t ?? Math.floor(Date.now() / 1000);
  const v0 = createHmac('sha256', opts.secret ?? SECRETS.elevenlabsWebhook).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v0=${v0}`;
}

/** Twilio: base64(HMAC-SHA1(token, url + sorted(key+value))). */
export function twilioSignature(url: string, params: Record<string, string>, token: string = SECRETS.twilioToken): string {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], '');
  return createHmac('sha1', token).update(url + data, 'utf8').digest('base64');
}

export function toolRequest(tool: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request(`http://localhost:3000/api/voice/tools/${tool}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-recepcionista-tool-secret': SECRETS.toolSecret, ...headers },
    body: JSON.stringify(body),
  });
}
