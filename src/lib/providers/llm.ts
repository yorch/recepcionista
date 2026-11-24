/**
 * LLM adapter. Uses OpenAI if OPENAI_API_KEY is set, Anthropic if only that is,
 * otherwise returns deterministic mock content so the app still runs end-to-end.
 */
import { logger } from '@/lib/log';

const log = logger('llm');
const LLM_TIMEOUT_MS = 30_000;
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export interface LlmJsonOptions<T> {
  messages: ChatMessage[];
  /** Used when no key is configured, or the model returns unparseable JSON. */
  fallback: T;
  temperature?: number;
}

export const hasLlm = () =>
  Boolean(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY);

/** The first balanced JSON value in `text` starting at `from`, parsed, or null. Respects strings and escapes. */
function balancedJsonAt(text: string, from: number): unknown | null {
  const open = text[from];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) {
      try { return JSON.parse(text.slice(from, i + 1)); } catch { return null; }
    }
  }
  return null;
}

/**
 * The JSON value in a model reply: plain, fenced (```json), or surrounded by prose ("Here you go: {...} Hope that helps [1]").
 * Tries every `{` / `[` as a start and returns the first balanced value that parses, so brackets in the prose before or
 * after it cannot break extraction. Throws when there is none.
 */
export function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : raw).trim();
  try { return JSON.parse(candidate); } catch { /* look for an embedded value */ }
  for (let i = 0; i < candidate.length; i++) {
    if (candidate[i] !== '{' && candidate[i] !== '[') continue;
    const v = balancedJsonAt(candidate, i);
    if (v !== null && typeof v === 'object') return v;
  }
  throw new Error('no json in response');
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRY_DELAY_MS = 600;

/** One bounded retry for a rate-limited / overloaded provider or a dropped connection (never for a 4xx that is our fault). */
async function fetchOnce(url: string, init: RequestInit & { signal?: AbortSignal }, makeSignal: () => AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: makeSignal() });
      if (attempt === 0 && RETRYABLE_STATUS.has(res.status)) {
        log.warn('provider.retry', { status: res.status });
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      return res;
    } catch (err) {
      if (attempt === 0) {
        log.warn('provider.retry', { err });
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      throw err;
    }
  }
}

/** Provider error bodies can echo the prompt: keep only the start of them in an exception (and so in the logs). */
const errBody = (text: string): string => text.replace(/\s+/g, ' ').slice(0, 200);

/**
 * Some models (reasoning-only ones) reject any temperature other than the
 * default, and reject max_tokens in favour of max_completion_tokens. Rather
 * than pin a model-specific body, send the optional params and retry without
 * whichever one the API names as unsupported — otherwise every call fails and
 * silently degrades to templates.
 */
const unsupportedParams = new Set<string>();

async function callOpenAi(messages: ChatMessage[], temperature: number): Promise<string> {
  const send = async (body: Record<string, unknown>) => {
    const res = await fetchOnce('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
    }, () => AbortSignal.timeout(LLM_TIMEOUT_MS));
    if (res.ok) {
      const json = await res.json();
      return json.choices?.[0]?.message?.content ?? '';
    }
    const text = await res.text();
    const param = /"param":\s*"([^"]+)"/.exec(text)?.[1];
    if (res.status === 400 && param && !unsupportedParams.has(param)) {
      unsupportedParams.add(param);
      log.warn('openai.param_unsupported', { param, retrying: true });
      return null;
    }
    throw new Error(`openai ${res.status}: ${errBody(text)}`);
  };

  let attempt = 0;
  while (attempt++ < 4) {
    const body: Record<string, unknown> = {
      model: process.env.LLM_MODEL || 'gpt-4o-mini',
      messages,
    };
    if (!unsupportedParams.has('temperature')) body.temperature = temperature;
    const out = await send(body);
    if (out !== null) return out;
  }
  throw new Error('openai: gave up after repeated unsupported-parameter retries');
}

async function callAnthropic(messages: ChatMessage[], temperature: number): Promise<string> {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const rest = messages.filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));
  const res = await fetchOnce('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY as string,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
      max_tokens: 2000,
      temperature,
      system,
      messages: rest,
    }),
  }, () => AbortSignal.timeout(LLM_TIMEOUT_MS));
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${errBody(await res.text())}`);
  const json = await res.json();
  return json.content?.map((c: { text?: string }) => c.text ?? '').join('') ?? '';
}

export async function generateText(
  messages: ChatMessage[],
  temperature = 0.4,
): Promise<string> {
  const provider = process.env.OPENAI_API_KEY
    ? 'openai'
    : process.env.ANTHROPIC_API_KEY
      ? 'anthropic'
      : null;
  if (!provider) {
    log.debug('call.skipped', { reason: 'no key', messages: messages.length });
    throw new Error('no llm key configured');
  }
  return log.time(
    'call',
    () => (provider === 'openai' ? callOpenAi(messages, temperature) : callAnthropic(messages, temperature)),
    {
      provider,
      model: (provider === 'openai' ? process.env.LLM_MODEL : process.env.ANTHROPIC_MODEL) || 'default',
      messages: messages.length,
      chars: messages.reduce((n, m) => n + m.content.length, 0),
    },
  );
}

/** Returns parsed JSON, or the provided fallback on any failure. Never throws. */
export async function generateJson<T>(opts: LlmJsonOptions<T>): Promise<{ value: T; mocked: boolean }> {
  if (!hasLlm()) {
    log.debug('json.template', { reason: 'no key' });
    return { value: opts.fallback, mocked: true };
  }
  try {
    const raw = await generateText(opts.messages, opts.temperature ?? 0.2);
    const value = extractJson(raw) as T;
    log.debug('json.ok', { chars: raw.length });
    return { value, mocked: false };
  } catch (err) {
    log.warn('json.fallback', { reason: 'call or parse failed', err });
    return { value: opts.fallback, mocked: true };
  }
}

export async function generateTextSafe(
  messages: ChatMessage[],
  fallback: string,
  temperature = 0.5,
): Promise<{ value: string; mocked: boolean }> {
  if (!hasLlm()) {
    log.debug('text.template', { reason: 'no key' });
    return { value: fallback, mocked: true };
  }
  try {
    return { value: await generateText(messages, temperature), mocked: false };
  } catch (err) {
    log.warn('text.fallback', { err });
    return { value: fallback, mocked: true };
  }
}
