/**
 * WS3 — ElevenLabs ConvAI client. Everything here degrades to `{mock:true}`:
 * a missing key or a failed API call must never break the phone line.
 */
import { appUrl } from '@/lib/providers/stripe';
import { buildSystemPrompt } from '@/lib/kb';
import { updateBusiness } from '@/lib/db';
import type { Business, KnowledgeBase } from '@/lib/types';
import { TOOL_NAMES, type ToolName } from '@/lib/voice/tools';
import { logger } from '@/lib/log';

const log = logger('elevenlabs');

const API = 'https://api.elevenlabs.io/v1';
const DEFAULT_VOICE_ID = 'cgSgspJ2msm6clMCkdW9'; // ElevenLabs "Jessica" — warm front-desk read

export const hasElevenLabs = () => Boolean(process.env.ELEVENLABS_API_KEY);

function apiKey(): string {
  return process.env.ELEVENLABS_API_KEY as string;
}

function headers(): Record<string, string> {
  return { 'content-type': 'application/json', 'xi-api-key': apiKey() };
}

/**
 * The agent id is stored on the business row. It used to live in process
 * memory, which meant every dev-server restart created a fresh ElevenLabs
 * agent and orphaned the previous one.
 */
export function agentIdFor(business: Business): string {
  return business.agent_id || process.env.ELEVENLABS_AGENT_ID || '';
}

export async function rememberAgent(businessId: string, agentId: string): Promise<void> {
  if (!agentId) return;
  try {
    await updateBusiness(businessId, { agent_id: agentId });
  } catch (err) {
    log.warn('agent.persist_failed', { business: businessId, agent: agentId, err });
  }
}

export function firstMessageFor(business: Business): string {
  return `Thanks for calling ${business.name}, this is Maria. How can I help you? — `
    + `Gracias por llamar a ${business.name}, le habla Maria. ¿En qué le puedo ayudar?`;
}

/** Tool descriptions: they are the agent's only instruction on when to call each. */
const TOOL_SPECS: Record<ToolName, { description: string; properties: Record<string, unknown>; required: string[] }> = {
  check_availability: {
    description: 'Look up open appointment slots. Call this before offering any time to the caller. Omit date for the next available slots.',
    properties: {
      date: { type: 'string', description: 'Day to check, YYYY-MM-DD. Omit for the next available slots.' },
      duration_minutes: { type: 'number', description: 'Appointment length in minutes. Default 60.' },
    },
    required: [],
  },
  create_booking: {
    description: 'Book the appointment once the caller has agreed to a time. Confirm every detail back before calling.',
    properties: {
      customer_name: { type: 'string', description: "Caller's full name." },
      customer_phone: { type: 'string', description: 'Callback number.' },
      service: { type: 'string', description: 'Service being booked.' },
      scheduled_at: { type: 'string', description: 'ISO 8601 start time, e.g. 2026-11-15T15:00:00-05:00.' },
      address: { type: 'string', description: 'Service address.' },
      price_estimate: { type: 'number', description: 'Starting price quoted, in dollars.' },
    },
    required: ['customer_name', 'customer_phone', 'service', 'scheduled_at'],
  },
  send_sms: {
    description: 'Send a text message to the caller or the owner.',
    properties: {
      to: { type: 'string', description: 'Destination phone number in E.164.' },
      body: { type: 'string', description: 'Message text. Keep it short.' },
    },
    required: ['to', 'body'],
  },
  create_payment_link: {
    description: 'Create a secure deposit payment link and text it to the caller. Deposits are capped at $500.',
    properties: {
      amount_cents: { type: 'number', description: 'Deposit amount in cents, e.g. 18900 for $189.' },
      description: { type: 'string', description: 'What the deposit is for.' },
      booking_id: { type: 'string', description: 'Related booking id, if any.' },
    },
    required: ['amount_cents', 'description'],
  },
  flag_emergency: {
    description: 'Mark the call as an emergency and alert the owner immediately. Use for leaks, burning smells, no cooling with a vulnerable occupant, or total failure in extreme heat.',
    properties: {
      reason: { type: 'string', description: 'One sentence on why it is an emergency.' },
      customer_name: { type: 'string', description: "Caller's name." },
      customer_phone: { type: 'string', description: 'Callback number.' },
      address: { type: 'string', description: 'Where the tech should go.' },
    },
    required: ['reason'],
  },
  get_pricing: {
    description: 'Look up the starting price for a service. Never quote a price from memory — always call this first.',
    properties: {
      service_name: { type: 'string', description: 'Service the caller asked about.' },
    },
    required: ['service_name'],
  },
  handoff_to_human: {
    description: 'Transfer the caller to the owner. Use when the caller insists, is upset, or asks about something outside the knowledge base.',
    properties: {
      reason: { type: 'string', description: 'Why the caller needs the owner.' },
    },
    required: ['reason'],
  },
};

/**
 * ElevenLabs will not accept an inline webhook tool definition on the agent —
 * each tool is created once via /convai/tools and then referenced by id. The
 * inline form returns 422 for every property, which is what silently pushed
 * every agent into mock mode.
 */
/** Reuse a workspace tool with the same name instead of piling up duplicates. */
async function findToolByName(wireName: string): Promise<string | null> {
  const res = await fetch(`${API}/convai/tools`, { headers: headers(), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;
  const json = await res.json() as { tools?: { id?: string; tool_config?: { name?: string; type?: string } }[] };
  const hit = (json.tools ?? []).find(
    (t) => t.tool_config?.type === 'webhook' && t.tool_config?.name === wireName,
  );
  return hit?.id ?? null;
}

async function upsertTool(name: ToolName): Promise<string | null> {
  const spec = TOOL_SPECS[name];
  const wireName = name.replace(/_/g, '-').slice(0, 64);
  const existingId = await findToolByName(wireName);
  if (existingId) return existingId;
  const res = await fetch(`${API}/convai/tools`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      tool_config: {
        type: 'webhook',
        name: wireName,
        description: spec.description,
        response_timeout_secs: 20,
        api_schema: {
          url: `${appUrl()}/api/voice/tools/${name}`,
          method: 'POST',
          content_type: 'application/json',
          request_headers: { 'content-type': 'application/json' },
          request_body_schema: {
            type: 'object',
            description: `Arguments for ${name}`,
            required: spec.required,
            properties: {
              business_id: { type: 'string', description: 'Current business id.' },
              call_id: { type: 'string', description: 'Current call id.' },
              language: { type: 'string', description: "Caller's language: en or es." },
              ...spec.properties,
            },
          },
          response_body_schema: {
            type: 'object',
            description: 'Tool result',
            properties: {
              ok: { type: 'boolean', description: 'Whether the action succeeded.' },
              message: { type: 'string', description: 'The sentence to say to the caller.' },
            },
          },
        },
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    log.warn('tool.register_failed', {
      tool: name,
      status: res.status,
      detail: (await res.text().catch(() => '')).slice(0, 160),
    });
    return null;
  }
  const json = await res.json() as { id?: string };
  log.debug('tool.registered', { tool: name, id: json.id ?? null });
  return json.id ?? null;
}

/** Created once per process; seven round-trips on every call would be wasteful. */
const toolIdCache = new Map<ToolName, string>();

async function ensureToolIds(): Promise<string[]> {
  const ids = await Promise.all(TOOL_NAMES.map(async (name) => {
    const cached = toolIdCache.get(name);
    if (cached) return cached;
    const id = await upsertTool(name);
    if (id) toolIdCache.set(name, id);
    return id;
  }));
  return ids.filter((id): id is string => Boolean(id));
}

async function agentBody(business: Business, kb: KnowledgeBase | null) {
  const prompt = kb?.system_prompt?.trim()
    || buildSystemPrompt(business, {
      services: kb?.services ?? [],
      faqs: kb?.faqs ?? [],
      pricing_notes: kb?.pricing_notes ?? '',
    });

  return {
    name: `${business.name} — AI receptionist`,
    tags: ['recepcionista', business.id],
    conversation_config: {
      agent: {
        first_message: firstMessageFor(business),
        language: 'en',
        prompt: {
          prompt,
          llm: 'gpt-4o-mini',
          temperature: 0.4,
          timezone: 'America/New_York',
          tool_ids: await ensureToolIds(),
        },
      },
      tts: {
        voice_id: process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID,
        // Turbo v2 (not v2_5): ConvAI rejects v2_5 for English agents at 8kHz telephony.
        model_id: 'eleven_turbo_v2',
        agent_output_audio_format: 'ulaw_8000',
      },
      asr: {
        user_input_audio_format: 'ulaw_8000',
      },
      turn: {
        turn_timeout: 10,
      },
      conversation: {
        max_duration_seconds: 900,
      },
    },
  };
}

export interface AgentResult {
  agent_id: string;
  mock: boolean;
  created?: boolean;
  error?: string;
}

/**
 * Create the agent, or push the current KB to the existing one.
 * Stores the id on the business so the next call reuses it.
 */
export async function createOrUpdateAgent(
  input: { business: Business; kb: KnowledgeBase | null; agent_id?: string },
): Promise<AgentResult> {
  const { business, kb } = input;
  const existing = (input.agent_id || agentIdFor(business)).trim();
  if (!hasElevenLabs()) {
    log.warn('agent.mock', { business: business.id, name: business.name, reason: 'no API key' });
    return { agent_id: existing || `mock_agent_${business.id}`, mock: true };
  }

  const started = Date.now();
  const body = JSON.stringify(await agentBody(business, kb));
  try {
    if (existing && !existing.startsWith('mock_')) {
      const res = await fetch(`${API}/convai/agents/${existing}`, {
        method: 'PATCH',
        headers: headers(),
        body,
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        await rememberAgent(business.id, existing);
        // Success was silent before, so the account drifted away from the DB with
        // no local record of which agent was created, updated or by whom.
        log.info('agent.updated', {
          agent: existing,
          business: business.id,
          name: business.name,
          ms: Date.now() - started,
        });
        return { agent_id: existing, mock: false, created: false };
      }
      log.warn('agent.update_failed', { agent: existing, status: res.status, recreating: true });
    }

    const res = await fetch(`${API}/convai/agents/create`, {
      method: 'POST',
      headers: headers(),
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      log.error('agent.create_failed', {
        business: business.id,
        status: res.status,
        detail: detail.slice(0, 200),
      });
      return { agent_id: existing || `mock_agent_${business.id}`, mock: true, error: `create ${res.status}` };
    }
    const json = await res.json() as { agent_id?: string };
    const agentId = json.agent_id || '';
    if (!agentId) return { agent_id: existing, mock: true, error: 'no agent_id returned' };
    await rememberAgent(business.id, agentId);
    log.info('agent.created', {
      agent: agentId,
      business: business.id,
      name: business.name,
      ms: Date.now() - started,
    });
    return { agent_id: agentId, mock: false, created: true };
  } catch (err) {
    return {
      agent_id: existing || `mock_agent_${business.id}`,
      mock: true,
      error: (err as Error).message,
    };
  }
}

export interface SignedUrlResult {
  signed_url: string | null;
  agent_id: string;
  mock: boolean;
  error?: string;
}

/** Signed WebSocket URL for a browser/mobile conversation. */
export async function getSignedUrl(agentId: string): Promise<SignedUrlResult> {
  if (!agentId) {
    log.warn('signed_url.no_agent');
    return { signed_url: null, agent_id: agentId, mock: true, error: 'no agent id' };
  }
  if (!hasElevenLabs()) {
    log.warn('signed_url.mock', { agent: agentId, reason: 'no API key' });
    return { signed_url: null, agent_id: agentId, mock: true };
  }
  try {
    const res = await fetch(
      `${API}/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
      { headers: { 'xi-api-key': apiKey() }, signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) {
      log.warn('signed_url.failed', { agent: agentId, status: res.status });
      return { signed_url: null, agent_id: agentId, mock: true, error: `signed-url ${res.status}` };
    }
    const json = await res.json() as { signed_url?: string };
    log.debug('signed_url.ok', { agent: agentId });
    return { signed_url: json.signed_url ?? null, agent_id: agentId, mock: !json.signed_url };
  } catch (err) {
    return { signed_url: null, agent_id: agentId, mock: true, error: (err as Error).message };
  }
}

/** Bind the single shared ElevenLabs phone number to an agent. */
export async function bindPhoneNumber(agentId: string): Promise<void> {
  // Must be the phone_number_id UUID from GET /convai/phone-numbers,
  // NOT the phone number digits. Example: "abc123def..." not "+12028972767".
  const phoneNumberId = process.env.ELEVENLABS_PHONE_NUMBER_ID;
  if (!phoneNumberId || !hasElevenLabs()) {
    log.warn('phone.bind_skipped', {
      reason: !phoneNumberId ? 'no ELEVENLABS_PHONE_NUMBER_ID' : 'no API key',
    });
    return;
  }
  try {
    const res = await fetch(`${API}/convai/phone-numbers/${encodeURIComponent(phoneNumberId)}`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({ agent_id: agentId }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      log.warn('phone.bind_failed', {
        phone_number_id: phoneNumberId,
        agent: agentId,
        status: res.status,
        detail: detail.slice(0, 200),
      });
    } else {
      log.info('phone.bound', { phone_number_id: phoneNumberId, agent: agentId });
    }
  } catch (err) {
    log.error('phone.bind_error', { phone_number_id: phoneNumberId, agent: agentId, err });
  }
}
