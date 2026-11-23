import { ok, fail } from '@/lib/http';
import { getBusinessByPhone, listBusinesses, createCall } from '@/lib/db';
import { createOrUpdateAgent, getSignedUrl, firstMessageFor, bindPhoneNumber } from '@/lib/voice/elevenlabs';
import { verifyTwilioSignature } from '@/lib/providers/twilio';
import { logger } from '@/lib/log';
import type { Business } from '@/lib/types';

const log = logger('voice/incoming');

export const runtime = 'nodejs';

interface IncomingPayload {
  To?: string;
  From?: string;
  CallSid?: string;
  to?: string;
  from?: string;
}

/** Twilio posts form-encoded (signed); the demo UI posts JSON (unsigned, dev only). Accept both. */
async function readPayload(req: Request): Promise<{ payload: IncomingPayload; form: Record<string, string> }> {
  const contentType = req.headers.get('content-type') ?? '';
  try {
    if (contentType.includes('application/json')) {
      return { payload: (await req.json()) as IncomingPayload, form: {} };
    }
    const form = await req.formData();
    const out: Record<string, string> = {};
    form.forEach((value, key) => {
      if (typeof value === 'string') out[key] = value;
    });
    return { payload: out as IncomingPayload, form: out };
  } catch {
    return { payload: {}, form: {} };
  }
}

export async function POST(req: Request) {
  try {
    const { payload, form } = await readPayload(req);
    const verdict = verifyTwilioSignature(req, form);
    if (!verdict.ok) {
      log.warn('signature.rejected', { error: verdict.error });
      return fail('forbidden', 403);
    }
    const to = payload.To || payload.to || '';
    const from = payload.From || payload.from || '';

    // Never dead-end the demo: fall back to the primary business.
    const matched = to ? await getBusinessByPhone(to) : null;
    const business: Business | null = matched ?? (await listBusinesses())[0] ?? null;
    if (!business) {
      log.error('no_business', { to: to || null, from: from || null });
      return fail('no business configured — run scripts/seed.ts', 404);
    }
    log.info('routed', {
      to: to || null,
      from: from || null,
      business: business.id,
      matched: matched ? 'phone' : 'fallback-first-business',
    });

    const call = await createCall({
      business_id: business.id,
      caller_phone: from || null,
      status: 'in_progress',
    });

    // Best-effort: a failed agent refresh must not drop the call.
    let agentId = '';
    let agentMock = true;
    try {
      const agent = await createOrUpdateAgent({ business, kb: null });
      agentId = agent.agent_id;
      agentMock = agent.mock;
      if (agentId && !agentMock) {
        try { await bindPhoneNumber(agentId); } catch { /* best-effort */ }
      }
    } catch (err) {
      log.error('agent_setup_failed', { business: business.id, err });
    }

    let wsUrl: string | null = null;
    if (agentId) {
      const signed = await getSignedUrl(agentId);
      wsUrl = signed.signed_url;
      if (!wsUrl) log.warn('no_signed_url', { business: business.id, agent: agentId });
    }
    log.info('call_started', {
      business: business.id,
      call: call.id,
      agent: agentId || null,
      live: Boolean(agentId && wsUrl),
    });

    return ok({
      agent_id: agentId,
      business_id: business.id,
      call_id: call.id,
      business_name: business.name,
      caller_phone: from || null,
      ws_url: wsUrl,
      mock: agentMock || !wsUrl,
      fallback_script: firstMessageFor(business),
    });
  } catch (err) {
    return fail(err, 500);
  }
}

/** Twilio health-check / browser probe. */
export async function GET() {
  return ok({ ready: true, businesses: (await listBusinesses()).length });
}
