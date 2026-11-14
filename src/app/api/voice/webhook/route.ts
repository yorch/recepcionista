import { ok, fail } from '@/lib/http';
import {
  createCall, getCall, updateCall, getBusiness, listBusinesses, listCalls, nowIso,
} from '@/lib/db';
import { generateTextSafe } from '@/lib/providers/llm';
import type { Call, Urgency } from '@/lib/types';

export const runtime = 'nodejs';

interface Turn { role?: string; message?: string | null; text?: string; content?: string }

interface WebhookBody {
  call_id?: string;
  business_id?: string;
  conversation_id?: string;
  transcript?: string | Turn[];
  duration_sec?: number;
  duration_seconds?: number;
  language?: string;
  recording_url?: string;
  audio_url?: string;
  analysis?: { transcript_summary?: string; call_summary?: string };
  metadata?: { call_duration_secs?: number };
}

/** ElevenLabs sends turns as objects; the demo simulator sends a string. */
function transcriptText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((turn) => {
        if (typeof turn === 'string') return turn;
        const t = turn as Turn;
        const who = t.role ? `${t.role}: ` : '';
        return `${who}${t.message ?? t.text ?? t.content ?? ''}`.trim();
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

const EMERGENCY_WORDS = [
  'leaking', 'leak', 'water', 'flooding', 'flood', 'no cooling', 'not cooling',
  'burning', 'smoke', 'sparks', 'gas smell', 'emergency', 'dead unit',
  'agua', 'goteando', 'gotea', 'fuga', 'inundación', 'inundacion', 'humo',
  'quemado', 'olor a quemado', 'no enfría', 'no enfria', 'calor', 'emergencia',
];

const VULNERABLE_WORDS = ['baby', 'bebé', 'bebe', 'elderly', 'anciano', 'anciana', 'unwell', 'enfermo', 'enferma'];

function inferUrgency(transcript: string): Urgency {
  const text = transcript.toLowerCase();
  if (!text.trim()) return 'unsure';
  const hits = EMERGENCY_WORDS.filter((w) => text.includes(w));
  if (hits.length === 0) return 'routine';
  // Water/heat alone is a strong signal; vulnerable-occupant mentions confirm it.
  const strong = hits.some((w) => ['leaking', 'leak', 'flood', 'burning', 'smoke', 'sparks', 'fuga', 'humo', 'quemado', 'inundacion', 'inundación'].includes(w));
  if (strong || VULNERABLE_WORDS.some((w) => text.includes(w))) return 'emergency';
  return 'unsure';
}

function normalizeLanguage(raw: unknown, transcript: string): 'en' | 'es' | 'mixed' | null {
  if (typeof raw === 'string') {
    const v = raw.toLowerCase();
    if (v.startsWith('es')) return 'es';
    if (v.startsWith('en')) return 'en';
    if (v.includes('mix')) return 'mixed';
  }
  if (/\b(hola|gracias|buenas|señor|senor|ac|aire|el|la|por favor)\b/i.test(transcript)
    && /\b(the|my|please|thank|how)\b/i.test(transcript)) return 'mixed';
  return null;
}

/**
 * No-LLM summary. Reads like a dispatcher's note rather than a transcript dump:
 * what the problem was, how urgent, what was done about it.
 */
function summaryFallback(transcript: string, urgency: Urgency, lang: string | null): string {
  const text = transcript.trim();
  if (!text) return 'No transcript captured for this call.';

  const tag = urgency === 'emergency' ? 'Emergency' : urgency === 'routine' ? 'Routine' : 'Unclear priority';
  const langNote = lang === 'es' ? ' (Spanish)' : lang === 'mixed' ? ' (Spanglish)' : '';

  // Customer turns carry the complaint; agent turns carry the resolution.
  const lines = text.split(/(?<=[.!?])\s+/).map((l) => l.trim()).filter(Boolean);
  const spoken = lines.map((l) => l.replace(/^[^:]{1,24}:\s*/, '')).filter(Boolean);
  const problem = spoken[0] ?? '';
  const resolution = [...spoken].reverse().find((l) => /tech|booked|scheduled|tonight|tomorrow|dispatch|sent/i.test(l)) ?? '';

  const cap = (t: string) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);
  const parts = [`${tag}${langNote}.`];
  if (problem) parts.push(cap(problem.length > 140 ? `${problem.slice(0, 137)}…` : problem));
  if (resolution && resolution !== problem) {
    parts.push(resolution.length > 110 ? `${resolution.slice(0, 107)}…` : resolution);
  }
  return parts.join(' ');
}

export async function POST(req: Request) {
  try {
    const rawBody = await req.text();
    let body: WebhookBody = {};
    try {
      body = rawBody ? (JSON.parse(rawBody) as WebhookBody) : {};
    } catch {
      // ElevenLabs can post form-encoded in some configurations.
      body = Object.fromEntries(new URLSearchParams(rawBody)) as WebhookBody;
    }

    const transcript = transcriptText(body.transcript);
    const duration = body.duration_sec
      ?? body.duration_seconds
      ?? body.metadata?.call_duration_secs
      ?? null;
    const recordingUrl = body.recording_url ?? body.audio_url ?? null;
    const language = normalizeLanguage(body.language, transcript);
    const urgency = inferUrgency(transcript);

    // Resolve the call: explicit id, else the live call for this business
    // (ElevenLabs' telephony has no idea what our call_id is), else create one
    // so the artifact always lands somewhere.
    const explicitId = body.call_id || body.conversation_id || '';
    let call: Call | null = explicitId ? await getCall(explicitId) : null;
    const businessId = body.business_id || call?.business_id || (await listBusinesses())[0]?.id || '';

    if (!call && businessId) {
      call = (await listCalls(businessId)).find((c) => c.status === 'in_progress') ?? null;
      if (!call) {
        // Reuse a handed-off call only if it has no transcript of its own.
        call = (await listCalls(businessId)).find((c) => c.status === 'handed_off' && !c.transcript) ?? null;
      }
      if (!call) call = await createCall({ business_id: businessId, status: 'in_progress' });
    }
    if (!call) return fail('no business_id and no call_id — cannot attach the transcript', 400);

    const alreadyHandedOff = call.status === 'handed_off';

    const fallback = summaryFallback(transcript, urgency, language);
    const { value: summary } = await generateTextSafe(
      [
        {
          role: 'system',
          content: 'You summarize inbound phone calls for a home-services business owner. '
            + 'Reply in at most 2 sentences: what the caller needed, what was booked or sent, and anything the owner must act on. '
            + 'Name the urgency plainly. No preamble.',
        },
        {
          role: 'user',
          content: `Business: ${(await getBusiness(call.business_id))?.name ?? call.business_id}\n`
            + `Urgency hint: ${urgency}\n\nTranscript:\n${transcript.slice(0, 6000)}`,
        },
      ],
      fallback,
    );

    const updated = await updateCall(call.id, {
      ended_at: call.ended_at ?? nowIso(),
      duration_sec: duration != null && Number.isFinite(Number(duration)) ? Number(duration) : call.duration_sec,
      transcript: transcript || call.transcript,
      summary: summary.trim() || fallback,
      language: language ?? call.language,
      recording_url: recordingUrl ?? call.recording_url,
      urgency: call.urgency === 'emergency' ? 'emergency' : urgency,
      // Handoffs must survive: the owner still needs to call this person back.
      status: alreadyHandedOff ? 'handed_off' : 'completed',
    });

    return ok({ call: updated });
  } catch (err) {
    return fail(err, 500);
  }
}

/** Inspection endpoint so the dashboard can confirm the webhook is wired. */
export async function GET() {
  return ok({ ready: true, accepts: ['application/json', 'application/x-www-form-urlencoded'] });
}
