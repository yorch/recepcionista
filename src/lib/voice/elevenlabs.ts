/**
 * WS3 — ElevenLabs ConvAI client. Everything here degrades to `{mock:true}`:
 * a missing key or a failed API call must never break the phone line.
 */
import { appUrl } from '@/lib/providers/stripe';
import { buildSystemPrompt } from '@/lib/kb';
import type { Business, KnowledgeBase } from '@/lib/types';
import { TOOL_NAMES, type ToolName } from '@/lib/voice/tools';

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
 * The Business type has no agent column, so provisioned agents are cached in
 * process memory for the demo run instead of writing to the shared DB.
 */
const agentCache = new Map<string, string>();

export function agentIdFor(business: Business): string {
  return agentCache.get(business.id) || process.env.ELEVENLABS_AGENT_ID || '';
}

export function rememberAgent(businessId: string, agentId: string): void {
  if (agentId) agentCache.set(businessId, agentId);
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

function toolPayload(name: ToolName) {
  const spec = TOOL_SPECS[name];
  return {
    type: 'webhook' as const,
    name,
    description: spec.description,
    api_schema: {
      url: `${appUrl()}/api/voice/tools/${name}`,
      method: 'POST' as const,
      content_type: 'application/json' as const,
      request_headers: { 'content-type': 'application/json' },
      request_body_schema: {
        type: 'object',
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
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string', description: 'The sentence to say to the caller.' },
        },
      },
    },
  };
}

function agentBody(business: Business, kb: KnowledgeBase | null) {
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
          tools: TOOL_NAMES.map((t) => toolPayload(t)),
        },
      },
      tts: {
        voice_id: process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID,
        model_id: 'eleven_turbo_v2_5',
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
    console.log(`[elevenlabs:mock] agent for ${business.name} (${business.id}) — no API key`);
    return { agent_id: existing || `mock_agent_${business.id}`, mock: true };
  }

  const body = JSON.stringify(agentBody(business, kb));
  try {
    if (existing && !existing.startsWith('mock_')) {
      const res = await fetch(`${API}/convai/agents/${existing}`, {
        method: 'PATCH',
        headers: headers(),
        body,
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        rememberAgent(business.id, existing);
        return { agent_id: existing, mock: false, created: false };
      }
      console.warn(`[elevenlabs] PATCH ${existing} -> ${res.status}; creating a new agent`);
    }

    const res = await fetch(`${API}/convai/agents/create`, {
      method: 'POST',
      headers: headers(),
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.warn(`[elevenlabs] create -> ${res.status} ${detail.slice(0, 200)}`);
      return { agent_id: existing || `mock_agent_${business.id}`, mock: true, error: `create ${res.status}` };
    }
    const json = await res.json() as { agent_id?: string };
    const agentId = json.agent_id || '';
    if (!agentId) return { agent_id: existing, mock: true, error: 'no agent_id returned' };
    rememberAgent(business.id, agentId);
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
  if (!agentId) return { signed_url: null, agent_id: agentId, mock: true, error: 'no agent id' };
  if (!hasElevenLabs()) {
    return { signed_url: null, agent_id: agentId, mock: true };
  }
  try {
    const res = await fetch(
      `${API}/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
      { headers: { 'xi-api-key': apiKey() }, signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) {
      return { signed_url: null, agent_id: agentId, mock: true, error: `signed-url ${res.status}` };
    }
    const json = await res.json() as { signed_url?: string };
    return { signed_url: json.signed_url ?? null, agent_id: agentId, mock: !json.signed_url };
  } catch (err) {
    return { signed_url: null, agent_id: agentId, mock: true, error: (err as Error).message };
  }
}
