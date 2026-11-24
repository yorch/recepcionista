import { runTool } from '@/lib/voice/tools';
import type { ToolResult } from '@/lib/voice/tools';
import { verifyToolSecret } from '@/lib/voice/elevenlabs';
import { findActiveCall, getBusinessByAgentId, getCall } from '@/lib/db';
import { callGate, CAPACITY_EXEMPT_TOOLS, outOfServiceToolMessage } from '@/lib/voice/capacity';
import { canonicalOwnerTool, runOwnerTool } from '@/lib/voice/owner/tools';
import { logger } from '@/lib/log';

const log = logger('voice/tools');

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

/**
 * Resolve the tenant from the platform-supplied agent id (a system dynamic
 * variable the LLM cannot write) and overwrite anything the body claims.
 * Returns null when the tenant cannot be established.
 */
async function bindTenant(
  args: Record<string, unknown>,
  authSkipped: boolean,
): Promise<Record<string, unknown> | null> {
  const agentId = typeof args.agent_id === 'string' ? args.agent_id.trim() : '';
  const claimed = String(args.business_id ?? args.businessId ?? '');
  // Fails closed: null when no business has this agent OR several do (ambiguous).
  const business = agentId
    ? await getBusinessByAgentId(agentId)
    : null;

  const out: Record<string, unknown> = { ...args };
  delete out.businessId;
  if (business) {
    // The platform fills business_id from a per-agent dynamic variable. If it disagrees
    // with the agent mapping something is misconfigured or forged: refuse, never guess.
    if (claimed && claimed !== business.id) {
      log.error('tenant.mismatch', { claimed, resolved: business.id, agent: agentId });
      return null;
    }
    out.business_id = business.id;
  } else if (authSkipped && claimed) {
    // Local development only (ALLOW_INSECURE_DEV=true, no ELEVENLABS_TOOL_SECRET): demo simulators post business_id directly.
    out.business_id = claimed;
  } else {
    return null;
  }

  // A call id is only honoured if it belongs to the resolved business.
  const callId = typeof out.call_id === 'string' ? out.call_id : '';
  if (callId) {
    const call = await getCall(callId);
    if (!call || call.business_id !== out.business_id) delete out.call_id;
  }
  return out;
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ tool: string }> },
): Promise<Response> {
  const { tool } = await ctx.params;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const auth = verifyToolSecret(req);
  if (!auth.ok) return json({ ok: false, message: 'unauthorized' }, 401);

  let result: ToolResult;
  try {
    const args = await bindTenant(normalize(await readBody(req)), Boolean(auth.skipped));
    if (!args) {
      result = { ok: false, message: 'Let me get the owner for that.' };
    } else {
      const toolName = tool.trim().toLowerCase().replace(/[\s-]+/g, '_');
      // Owner-line tools (voice/owner) never reach runTool: they have their own gate (call row kind 'owner', set server-side) and are exempt from the minute cap.
      const ownerTool = canonicalOwnerTool(tool) !== null;
      const gate = ownerTool || CAPACITY_EXEMPT_TOOLS.has(toolName) || typeof args.business_id !== 'string'
        ? null
        : await callGate(args.business_id);
      // The other way round: an OWNER call may not use customer tools (booking, texting, payments), whatever the model asks.
      const onOwnerCall = !ownerTool && typeof args.business_id === 'string'
        && (await findActiveCall(args.business_id, { callSid: String(args.call_sid ?? '') || undefined, conversationId: String(args.conversation_id ?? '') || undefined }))?.kind === 'owner';
      result = ownerTool
        ? await runOwnerTool(tool, args)
        : onOwnerCall
        ? { ok: false, message: 'That is not available on the owner line.' }
        : gate && !gate.ok
        ? {
          ok: false,
          message: outOfServiceToolMessage(typeof args.language === 'string' && args.language.toLowerCase().startsWith('es') ? 'es' : 'en'),
          data: { reason: gate.reason ?? 'out_of_service' },
        }
        : await runTool(tool, args);
    }
  } catch {
    result = { ok: false, message: 'Let me get the owner for that.' };
  }

  // Rows in `data` can hold transcripts and phone numbers; only expose them to unauthenticated dev callers.
  return json({
    ok: result.ok,
    message: result.message,
    data: auth.skipped ? (result.data ?? null) : null,
  });
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
