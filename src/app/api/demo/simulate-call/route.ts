/**
 * Demo orchestrator. Replays a full call by driving the same HTTP contracts the
 * voice agent's tools use — so the demo exercises the real pipeline, not a
 * separate code path. Degrades gracefully if a downstream route is missing.
 */
import { NextResponse } from 'next/server';
import {
  createCall, getBusiness, getKnowledgeBase, listSms, updateCall,
} from '@/lib/db';
import { appUrl } from '@/lib/providers/stripe';
import { generateTextSafe } from '@/lib/providers/llm';
import { ok, fail, readJson } from '@/lib/http';
import { logger } from '@/lib/log';
import type { Booking, Call, PaymentLink, SmsLog } from '@/lib/types';

export const dynamic = 'force-dynamic';

const log = logger('demo/simulate');

type Script = 'routine' | 'emergency' | 'spanish';

interface Body {
  business_id?: string;
  caller_name?: string;
  caller_phone?: string;
  script?: Script;
}

interface SimResult {
  call: Call;
  booking?: Booking | null;
  payment_link?: (PaymentLink & { mock?: boolean }) | null;
  sms: SmsLog[];
  simulated: boolean;
}

const SCRIPTS: Record<Script, {
  language: 'en' | 'es' | 'mixed';
  urgency: 'routine' | 'emergency';
  service: string;
  problem: string;
  transcript: string;
  price: number;
  emergency: boolean;
}> = {
  routine: {
    language: 'en',
    urgency: 'routine',
    service: 'AC repair',
    problem: 'AC blowing warm air, no leak, no vulnerable occupants',
    transcript:
      'Maria: Thanks for calling Miami Cool Air, this is Maria. How can I help? ' +
      'Caller: My AC is blowing warm air since last night. ' +
      'Maria: Is it leaking any water? Caller: No, just warm air. ' +
      'Maria: Is anyone elderly or a baby at home? Caller: No. ' +
      'Maria: I can get a tech out tomorrow. I have 10 AM or 2 PM. ' +
      'Caller: 2 PM works. Maria: Perfect — I am sending your confirmation text now.',
    price: 150,
    emergency: false,
  },
  emergency: {
    language: 'en',
    urgency: 'emergency',
    service: 'Emergency after-hours service',
    problem: 'Water leaking from ceiling unit, breaker cut',
    transcript:
      'Maria: Thanks for calling Miami Cool Air. How can I help? ' +
      'Caller: Water is pouring out of my ceiling unit right now. ' +
      'Maria: That is an emergency. Is the unit still running? Caller: I cut the breaker. ' +
      'Maria: Good. Is anyone elderly, a baby, or unwell in the home? Caller: Just me. ' +
      'Maria: I need a $189 deposit to hold tonight\'s tech. Sending the secure link now.',
    price: 189,
    emergency: true,
  },
  spanish: {
    language: 'es',
    urgency: 'routine',
    service: 'Seasonal maintenance',
    problem: 'Mantenimiento rutinario del AC',
    transcript:
      'Maria: Gracias por llamar a Miami Cool Air, le habla Maria. ¿En qué le puedo ayudar? ' +
      'Cliente: Buenas, quiero mantenimiento para el AC, nada más rutina. ' +
      'Maria: Claro que sí. ¿Le queda bien el sábado a las nueve de la mañana? ' +
      'Cliente: Perfecto. Maria: Listo, le mando la confirmación por texto ahora.',
    price: 129,
    emergency: false,
  },
};

async function post<T>(path: string, body: unknown): Promise<T | null> {
  try {
    const res = await fetch(`${appUrl()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json?.ok) return null;
    return json.data as T;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  try {
    const body = await readJson<Body>(req);
    const scriptId: Script = body.script ?? 'routine';
    const script = SCRIPTS[scriptId] ?? SCRIPTS.routine;

    const business = body.business_id ? await getBusiness(body.business_id) : null;
    if (!business) {
      log.warn('business_not_found', { business: body.business_id ?? null });
      return fail('business not found', 404);
    }
    const started = Date.now();
    log.info('start', { business: business.id, script: scriptId, caller: body.caller_phone ?? null });
    const kb = await getKnowledgeBase(business.id);
    void kb;

    const call = await createCall({
      business_id: business.id,
      caller_phone: body.caller_phone ?? '+13055550123',
      caller_name: body.caller_name ?? 'Demo Caller',
      language: script.language,
      urgency: script.urgency,
      status: 'completed',
      transcript: script.transcript,
      ended_at: new Date().toISOString(),
      duration_sec: 168,
    });

    const summary = await generateTextSafe(
      [
        {
          role: 'system',
          content:
            'Summarize this HVAC service call in one sentence for the owner. Name the problem, the urgency, and what was booked. No preamble.',
        },
        { role: 'user', content: script.transcript },
      ],
      `${script.problem} → ${script.urgency}, ${script.service} at $${script.price}.`,
    );

    await updateCall(call.id, {
      summary: summary.value,
      flagged_reason: script.emergency
        ? 'Emergency: water leak, needs same-night tech'
        : null,
    });

    // Next open slot from the business's own calendar.
    const { nextAvailable } = await import('@/lib/scheduler');
    const slots = await nextAvailable(business, 1, 60);
    const scheduledAt = slots[0]?.start ?? new Date(Date.now() + 86400000).toISOString();

    const bookingPayload = await post<{ booking: Booking; sms_sent: boolean }>(
      '/api/voice/tools/createBooking',
      {
        business_id: business.id,
        call_id: call.id,
        customer_name: body.caller_name ?? 'Demo Caller',
        customer_phone: body.caller_phone ?? '+13055550123',
        service: script.service,
        scheduled_at: scheduledAt,
        address: '1200 Brickell Ave, Miami, FL 33131',
        price_estimate: script.price,
        language: script.language === 'es' ? 'es' : 'en',
      },
    );
    const booking = bookingPayload?.booking ?? null;

    let paymentLink: (PaymentLink & { mock?: boolean }) | null = null;
    if (script.emergency) {
      const linkPayload = await post<{ link: PaymentLink & { mock?: boolean } }>(
        '/api/voice/tools/createPaymentLink',
        {
          business_id: business.id,
          amount_cents: script.price * 100,
          description: `${business.name} — emergency deposit`,
          booking_id: booking?.id,
          language: script.language === 'es' ? 'es' : 'en',
        },
      );
      paymentLink = linkPayload?.link ?? null;
    }

    // Whatever the tools logged for this caller in the last minute.
    const sms = (await listSms(business.id)).filter(
      (s) =>
        s.to_phone === (body.caller_phone ?? '+13055550123') &&
        Date.now() - new Date(s.created_at).getTime() < 90_000,
    );

    const finalCall = (await updateCall(call.id, {})) ?? call;

    const result: SimResult = {
      call: finalCall,
      booking: booking ?? null,
      payment_link: paymentLink,
      sms,
      simulated: !booking,
    };
    log.info('done', {
      business: business.id,
      script: scriptId,
      call: finalCall.id,
      booking: booking?.id ?? null,
      payment_link: paymentLink?.id ?? null,
      sms: sms.length,
      simulated: !booking,
      ms: Date.now() - started,
    });
    return ok(result);
  } catch (err) {
    return fail(err, 500);
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, data: { scripts: Object.keys(SCRIPTS) } });
}
