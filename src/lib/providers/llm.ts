/**
 * LLM adapter. Uses OpenAI if OPENAI_API_KEY is set, Anthropic if only that is,
 * otherwise returns deterministic mock content so the app still runs end-to-end.
 */
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export interface LlmJsonOptions<T> {
  messages: ChatMessage[];
  /** Used when no key is configured, or the model returns unparseable JSON. */
  fallback: T;
  temperature?: number;
}

export const hasLlm = () =>
  Boolean(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY);

function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : raw).trim();
  const start = candidate.search(/[[{]/);
  if (start < 0) throw new Error('no json in response');
  const opener = candidate[start];
  const closer = opener === '{' ? '}' : ']';
  const end = candidate.lastIndexOf(closer);
  if (end < start) throw new Error('unterminated json');
  return JSON.parse(candidate.slice(start, end + 1));
}

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
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const json = await res.json();
      return json.choices?.[0]?.message?.content ?? '';
    }
    const text = await res.text();
    const param = /"param":\s*"([^"]+)"/.exec(text)?.[1];
    if (res.status === 400 && param && !unsupportedParams.has(param)) {
      unsupportedParams.add(param);
      return null;
    }
    throw new Error(`openai ${res.status}: ${text}`);
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
  const res = await fetch('https://api.anthropic.com/v1/messages', {
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
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.content?.map((c: { text?: string }) => c.text ?? '').join('') ?? '';
}

export async function generateText(
  messages: ChatMessage[],
  temperature = 0.4,
): Promise<string> {
  if (process.env.OPENAI_API_KEY) return callOpenAi(messages, temperature);
  if (process.env.ANTHROPIC_API_KEY) return callAnthropic(messages, temperature);
  throw new Error('no llm key configured');
}

/** Returns parsed JSON, or the provided fallback on any failure. Never throws. */
export async function generateJson<T>(opts: LlmJsonOptions<T>): Promise<{ value: T; mocked: boolean }> {
  if (!hasLlm()) return { value: opts.fallback, mocked: true };
  try {
    const raw = await generateText(opts.messages, opts.temperature ?? 0.2);
    return { value: extractJson(raw) as T, mocked: false };
  } catch (err) {
    console.warn('[llm] falling back:', (err as Error).message);
    return { value: opts.fallback, mocked: true };
  }
}

export async function generateTextSafe(
  messages: ChatMessage[],
  fallback: string,
  temperature = 0.5,
): Promise<{ value: string; mocked: boolean }> {
  if (!hasLlm()) return { value: fallback, mocked: true };
  try {
    return { value: await generateText(messages, temperature), mocked: false };
  } catch (err) {
    console.warn('[llm] text fallback:', (err as Error).message);
    return { value: fallback, mocked: true };
  }
}
