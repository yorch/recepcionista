import { runTool } from '@/lib/voice/tools';
import type { ToolResult } from '@/lib/voice/tools';

export const runtime = 'nodejs';

/**
 * ElevenLabs tool calls arrive in a few shapes:
 *   { business_id, ...args }
 *   { arguments: { ...args } }
 *   { arguments: '{"..."}' }
 *   { parameters: { ...args } }
 * Always answer 200 with a speakable message — an error status would leave
 * the agent with nothing to say.
 */
function normalize(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {};
  const body = raw as Record<string, unknown>;

  for (const key of ['arguments', 'parameters', 'args']) {
    const nested = body[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      return { ...body, ...(nested as Record<string, unknown>) };
    }
    if (typeof nested === 'string' && nested.trim()) {
      try {
        const parsed = JSON.parse(nested);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return { ...body, ...(parsed as Record<string, unknown>) };
        }
      } catch {
        // Not JSON — ignore and fall back to the raw body.
      }
    }
  }
  return body;
}

async function readBody(req: Request): Promise<unknown> {
  try {
    const text = await req.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return Object.fromEntries(new URLSearchParams(text));
    }
  } catch {
    return {};
  }
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ tool: string }> },
): Promise<Response> {
  const { tool } = await ctx.params;
  let result: ToolResult;

  try {
    const args = normalize(await readBody(req));
    result = await runTool(tool, args);
  } catch {
    result = { ok: false, message: 'Let me get the owner for that.' };
  }

  return new Response(
    JSON.stringify({
      ok: result.ok,
      message: result.message,
      data: result.data ?? null,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ tool: string }> },
) {
  const { tool } = await ctx.params;
  return new Response(
    JSON.stringify({
      ok: true,
      tool,
      hint: 'POST JSON args here. Returns {ok, message, data}.',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}
