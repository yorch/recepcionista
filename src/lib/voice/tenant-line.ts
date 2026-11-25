/**
 * A tenant's OWN AI line: its purchased Twilio number imported into ElevenLabs and bound to ITS agent (backlog #6). Orchestrates
 * voice/elevenlabs-phone.ts (the only module that knows the provider's shapes) with the database (setBusinessLine: UNIQUE ids, never
 * stolen from another business). Idempotent: running it again adopts what exists. Never throws.
 */
import { getBusiness, getBusinessByAgentId, getBusinessIdByElevenLabsPhoneNumberId, setBusinessLine, recordAudit, withLease } from '@/lib/db';
import { toE164 } from '@/lib/phone';
import { configureNumberWebhooks, isMockPoolNumber, isPlatformNumber } from '@/lib/providers/twilio';
import { deleteRemoteNumber, getRemoteNumber, importTwilioNumber, listRemoteNumbers, setNumberAgent, type PhoneDeps } from '@/lib/voice/elevenlabs-phone';
import { logger } from '@/lib/log';
import type { Business } from '@/lib/types';

const log = logger('voice/tenant-line');

export type TenantLineResult =
  | { ok: true; phone_number_id: string; adopted: boolean; imported: boolean; webhooks?: string; /** What was (or, in a dry run, would be) done. */ action: 'ok' | 'import' | 'bind' }
  | { ok: false; code: 'not_applicable' | 'import_failed' | 'bind_failed' | 'conflict'; error: string; retryable: boolean };

export interface TenantLineDeps extends PhoneDeps {
  /** Dry run: report what would be done; no provider write, no database write. */
  dryRun?: boolean;
}

/** Can this business have an imported line at all (a real Twilio number, not a mock-pool or platform number, and a real agent)? */
export function lineApplicable(business: Pick<Business, 'phone' | 'agent_id'>, env: NodeJS.ProcessEnv = process.env): { ok: true; e164: string } | { ok: false; why: string } {
  const e164 = business.phone ? toE164(business.phone) : null;
  if (!e164) return { ok: false, why: 'the business has no phone number' };
  if (isMockPoolNumber(e164)) return { ok: false, why: 'mock-pool number: nothing exists at Twilio' };
  if (isPlatformNumber(e164, env)) return { ok: false, why: 'platform SMS sender number: never imported' };
  if (!business.agent_id || business.agent_id.startsWith('mock_')) return { ok: false, why: 'the business has no real voice agent yet' };
  return { ok: true, e164 };
}

const LINE_LEASE_MS = 90_000;

/**
 * Make this business's number a bound, imported ElevenLabs line. Serialized per business (lease `line:<id>`): provision, repair-numbers and the agent
 * re-sync drain may all call it, and two concurrent imports of one number would leave an orphan import bound to the tenant's agent holding the platform's
 * Twilio token. A caller that loses the race gets a retryable `import_failed` and tries again.
 */
export async function ensureTenantLine(business: Business, deps: TenantLineDeps = {}): Promise<TenantLineResult> {
  if (deps.dryRun === true) return ensureTenantLineUnlocked(business, deps);
  const run = await withLease(`line:${business.id}`, LINE_LEASE_MS, () => ensureTenantLineUnlocked(business, deps));
  if (!run.acquired) return { ok: false, code: 'import_failed', error: 'another import of this line is already running; try again in a moment', retryable: true };
  return run.value;
}

async function ensureTenantLineUnlocked(business: Business, deps: TenantLineDeps): Promise<TenantLineResult> {
  const env = deps.env ?? process.env;
  const app = lineApplicable(business, env);
  if (!app.ok) return { ok: false, code: 'not_applicable', error: app.why, retryable: false };
  const agentId = business.agent_id as string;
  const dry = deps.dryRun === true;
  let phoneNumberId = business.elevenlabs_phone_number_id ?? null;
  let adopted = false;
  let imported = false;
  let alreadyBound = false;

  if (phoneNumberId) {
    // Our own id: it must still exist at the provider (a deleted import is re-imported below), then it is (re)bound to the agent.
    const cur = await getRemoteNumber(phoneNumberId, deps);
    if (!cur.ok) return { ok: false, code: 'import_failed', error: cur.error, retryable: cur.retryable };
    if (!cur.number) phoneNumberId = null;
    else alreadyBound = cur.number.agent_id === agentId;
  }
  if (!phoneNumberId) {
    if (dry) return { ok: true, phone_number_id: '(would import)', adopted: false, imported: true, action: 'import' };
    const res = await importTwilioNumber({
      phone: app.e164, label: business.name,
      isOwnedElsewhere: async (id) => {
        const owner = await getBusinessIdByElevenLabsPhoneNumberId(id);
        return owner !== null && owner !== business.id;
      },
      agentId,
      agentBelongsElsewhere: async (aid) => {
        const other = await getBusinessByAgentId(aid);
        return other !== null && other.id !== business.id;
      },
    }, deps);
    if (!res.ok) return { ok: false, code: res.status === 409 ? 'conflict' : 'import_failed', error: res.error, retryable: res.retryable };
    phoneNumberId = res.phone_number_id;
    adopted = res.adopted;
    imported = !res.adopted;
    if (imported) await removeDuplicateImports(app.e164, phoneNumberId, deps);
    const saved = await setBusinessLine(business.id, { elevenlabs_phone_number_id: phoneNumberId });
    if (!saved.ok) {
      return { ok: false, code: saved.reason === 'in_use' ? 'conflict' : 'import_failed', error: saved.reason === 'in_use' ? 'that line already belongs to another business' : `could not store the line (${saved.reason})`, retryable: false };
    }
  }
  if (dry) return { ok: true, phone_number_id: phoneNumberId, adopted: false, imported: false, action: alreadyBound ? 'ok' : 'bind' };
  const bound = alreadyBound && !imported && !adopted ? { ok: true as const } : await setNumberAgent(phoneNumberId, agentId, deps);
  if (!bound.ok) return { ok: false, code: 'bind_failed', error: bound.error, retryable: bound.retryable };
  // The import hands the Voice URL to ElevenLabs; the SMS URL (STOP, C-cancel, ratings, owner YES codes) must stay ours.
  let webhooks: string | undefined;
  try {
    const w = await configureNumberWebhooks(app.e164, { env, skipVoiceUrl: true, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
    webhooks = w.outcome;
    if (w.sid) await setBusinessLine(business.id, { twilio_phone_sid: w.sid }).catch(() => undefined);
  } catch { webhooks = 'failed'; }
  log.info('line.ready', { business: business.id, adopted, imported, webhooks });
  return { ok: true, phone_number_id: phoneNumberId, adopted, imported, action: imported || adopted ? 'import' : alreadyBound ? 'ok' : 'bind', ...(webhooks ? { webhooks } : {}) };
}

/**
 * After a FRESH import: another import of the same E.164 that no business owns (and that is not the shared fallback line) is a leftover of a lost race or of a
 * lost answer; it holds the platform's Twilio token and is bound to nothing useful, so it is deleted. Best effort, never throws, never touches an owned id.
 */
async function removeDuplicateImports(e164: string, keepId: string, deps: PhoneDeps): Promise<void> {
  try {
    const list = await listRemoteNumbers(deps);
    if (!list.ok) return;
    const shared = ((deps.env ?? process.env).ELEVENLABS_PHONE_NUMBER_ID ?? '').trim();
    for (const n of list.numbers) {
      if (n.phone_number !== e164 || n.phone_number_id === keepId || (shared && n.phone_number_id === shared)) continue;
      if ((await getBusinessIdByElevenLabsPhoneNumberId(n.phone_number_id)) !== null) continue;
      const del = await deleteRemoteNumber(n.phone_number_id, deps);
      log.warn('line.duplicate_import_removed', { kept: keepId, removed: n.phone_number_id, deleted: del.ok });
    }
  } catch (err) { log.warn('line.duplicate_check_failed', { err }); }
}

export type ReleaseLineResult = { ok: true; had_line: boolean; already_deleted?: boolean } | { ok: false; error: string };

/** Detach and delete this business's OWN imported number (never the shared env fallback, never a number another business uses) and clear the id. */
export async function releaseTenantLine(businessId: string, deps: PhoneDeps = {}): Promise<ReleaseLineResult> {
  const business = await getBusiness(businessId);
  const id = business?.elevenlabs_phone_number_id ?? null;
  if (!business || !id) return { ok: true, had_line: false };
  const owner = await getBusinessIdByElevenLabsPhoneNumberId(id);
  if (owner !== null && owner !== businessId) return { ok: false, error: 'that line belongs to another business; kept' };
  const env = deps.env ?? process.env;
  // The shared single-line fallback has no owner row: a business that somehow points at it must never delete it (every tenant without a line of its own uses it).
  if ((env.ELEVENLABS_PHONE_NUMBER_ID ?? '').trim() === id) return { ok: false, error: 'that is the shared ELEVENLABS_PHONE_NUMBER_ID fallback line: it was NOT deleted and the reference is kept' };
  if (!(env.ELEVENLABS_API_KEY ?? '').trim()) return { ok: false, error: 'ELEVENLABS_API_KEY is not set: the imported number was NOT deleted and the reference is kept' };
  const del = await deleteRemoteNumber(id, deps);
  if (!del.ok) return { ok: false, error: del.error };
  await setBusinessLine(businessId, { elevenlabs_phone_number_id: null });
  await recordAudit({ actor_kind: 'system', business_id: businessId, action: 'line.released', target: `business:${businessId}`, meta: { already_deleted: del.already_deleted } }).catch(() => undefined);
  return { ok: true, had_line: true, already_deleted: del.already_deleted };
}
