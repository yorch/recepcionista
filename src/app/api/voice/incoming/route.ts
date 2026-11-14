import { ok, fail } from '@/lib/http';
import { getBusinessByPhone, listBusinesses, createCall } from '@/lib/db';
import { createOrUpdateAgent, getSignedUrl, firstMessageFor } from '@/lib/voice/elevenlabs';
import type { Business } from '@/lib/types';

export const runtime = 'nodejs';

interface IncomingPayload {
  To?: string;
  From?: string;
  CallSid?: string;
  to?: string;
  from?: string;
}

/** Twilio posts form-encoded; the demo UI posts JSON. Accept both. */
async function readPayload(req: Request): Promise<IncomingPayload> {
  const contentType = req.headers.get('content-type') ?? '';
  try {
    if (contentType.includes('application/json')) {
      return (await req.json()) as IncomingPayload;
    }
    const form = await req.formData();
    const out: Record<string, string> = {};
    form.forEach((value, key) => {
      if (typeof value === 'string') out[key] = value;
    });
    return out as IncomingPayload;
  } catch {
    return {};
  }
}

export async function POST(req: Request) {
  try {
    const payload = await readPayload(req);
    const to = payload.To || payload.to || '';
    const from = payload.From || payload.from || '';

    // Never dead-end the demo: fall back to the primary business.
    const business: Business | null = (to ? await getBusinessByPhone(to) : null)
      ?? (await listBusinesses())[0]
      ?? null;
    if (!business) {
      return fail('no business configured — run scripts/seed.ts', 404);
    }

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
    } catch (err) {
      console.warn('[voice/incoming] agent setup failed:', (err as Error).message);
    }

    let wsUrl: string | null = null;
    if (agentId) {
      const signed = await getSignedUrl(agentId);
      wsUrl = signed.signed_url;
    }

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
