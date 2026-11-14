/**
 * WS1 — URL scraping + LLM extraction. Never throws: always returns a usable
 * ExtractionResult, falling back to the AC-repair template.
 */
import * as cheerio from 'cheerio';
import { generateJson, hasLlm } from '@/lib/providers/llm';
import type { ExtractionResult, FAQ, Hours, Service } from '@/lib/types';

const DAY_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

const PAGE_CAP = 12_000;
const EXTRA_PAGE_CAP = 4_000;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** AC-repair template fallback — usable even with zero external information. */
export function templateResult(businessName = 'This Business'): ExtractionResult {
  return {
    name: businessName,
    services: [
      { name: 'AC Repair', description: 'Diagnose and repair air conditioning failures', base_price: 120, duration_minutes: 90 },
      { name: 'AC Maintenance / Tune-up', description: 'Seasonal inspection, coil cleaning, refrigerant check', base_price: 89, duration_minutes: 60 },
      { name: 'AC Installation / Replacement', description: 'Full unit replacement with new equipment', base_price: 2500, duration_minutes: 240 },
      { name: 'Emergency AC Service', description: 'Same-day urgent repair for no-cooling situations', base_price: 195, duration_minutes: 90 },
    ],
    hours: {
      monday: { open: '08:00', close: '18:00' },
      tuesday: { open: '08:00', close: '18:00' },
      wednesday: { open: '08:00', close: '18:00' },
      thursday: { open: '08:00', close: '18:00' },
      friday: { open: '08:00', close: '18:00' },
      saturday: { open: '09:00', close: '14:00' },
      sunday: null,
    },
    service_area: ['Miami-Dade County'],
    faqs: [
      { question: 'Do you offer same-day service?', answer: 'Yes, we offer same-day emergency service — call and we will find the earliest slot.' },
      { question: 'How much does a repair cost?', answer: 'Repairs start around $120 depending on the issue; the technician confirms pricing after diagnosis.' },
    ],
    pricing_notes: 'All prices are starting prices and vary by equipment and job scope. Estimates are confirmed before any work begins.',
    confidence: 'low',
    source: 'template',
  };
}

/** Normalize a user-supplied URL. Returns null when unusable. */
export function normalizeUrl(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname.includes('.')) return null;
    return u.toString();
  } catch {
    return null;
  }
}

async function fetchText(url: string, cap: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    return stripToText(html).slice(0, cap);
  } finally {
    clearTimeout(timer);
  }
}

function stripToText(html: string): string {
  const $ = cheerio.load(html);
  $('script, style, nav, footer, noscript, header, iframe, svg').remove();
  const title = $('title').first().text().trim();
  const metaDesc = $('meta[name="description"]').attr('content')?.trim() ?? '';
  const heads = ['h1', 'h2', 'h3'].map((t) => $(t).map((_, el) => $(el).text().trim()).get().filter(Boolean)).flat();
  const body = $('body').text().replace(/\s+/g, ' ').trim();
  return [
    title && `TITLE: ${title}`,
    metaDesc && `META DESCRIPTION: ${metaDesc}`,
    heads.length && `HEADINGS: ${heads.slice(0, 40).join(' | ')}`,
    `BODY: ${body}`,
  ].filter(Boolean).join('\n');
}

function extractPrompt(url: string, text: string): string {
  return `You extract structured business information from scraped website text for a home-services business (e.g. AC repair, plumbing, electrician).

WEBSITE: ${url}

Return ONLY valid JSON with this exact shape:
{
  "name": "string — the business name",
  "services": [{"name": "string", "description": "string", "base_price": number|null, "duration_minutes": number|null}],
  "hours": {"monday": {"open": "HH:MM", "close": "HH:MM"}|null, "tuesday": ..., "wednesday": ..., "thursday": ..., "friday": ..., "saturday": ..., "sunday": ...},
  "service_area": ["string"],
  "faqs": [{"question": "string", "answer": "string"}],
  "pricing_notes": "string — how pricing works, deposits, warranties",
  "confidence": "high" | "medium" | "low"
}

Rules:
- Include ALL seven day keys in "hours"; use null when closed or unknown.
- base_price: a number in USD when the site states a price or a clear "starting at" figure, otherwise null. NEVER invent prices.
- Only list services the business actually offers. If unclear, include the most plausible generic services for the trade and set confidence to "low".
- hours must be 24h "HH:MM" format.
- Keep service_area to cities/neighborhoods/counties mentioned (or inferred from the business name/location).
- confidence "high" only if the site clearly states most fields.

SCRAPED TEXT:
${text}`;
}

/** Coerce and clamp an arbitrary parsed object into a valid ExtractionResult. */
function sanitize(raw: unknown, businessName: string, source: ExtractionResult['source']): ExtractionResult {
  const r = (raw ?? {}) as Record<string, unknown>;

  const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : businessName;

  const rawServices = Array.isArray(r.services) ? r.services : [];
  const services: Service[] = rawServices.slice(0, 20).flatMap((s) => {
    const o = (s ?? {}) as Record<string, unknown>;
    const nm = typeof o.name === 'string' ? o.name.trim() : '';
    if (!nm) return [];
    const price = typeof o.base_price === 'number' && Number.isFinite(o.base_price) && o.base_price >= 0 ? o.base_price : null;
    const dur = typeof o.duration_minutes === 'number' && Number.isFinite(o.duration_minutes) && o.duration_minutes > 0 ? Math.round(o.duration_minutes) : undefined;
    return [{
      name: nm,
      description: typeof o.description === 'string' ? o.description : undefined,
      base_price: price,
      duration_minutes: dur,
    }];
  });

  const hoursRaw = (r.hours ?? {}) as Record<string, unknown>;
  const hours: Hours = {};
  for (const day of DAY_KEYS) {
    const variants = [day, day.slice(0, 3), day[0].toUpperCase() + day.slice(1, 3)];
    let entry: unknown;
    for (const v of variants) {
      if (hoursRaw[v] !== undefined) { entry = hoursRaw[v]; break; }
    }
    if (entry && typeof entry === 'object') {
      const e = entry as Record<string, unknown>;
      const open = typeof e.open === 'string' && /^\d{1,2}:\d{2}/.test(e.open) ? e.open.slice(0, 5).padStart(5, '0') : undefined;
      const close = typeof e.close === 'string' && /^\d{1,2}:\d{2}/.test(e.close) ? e.close.slice(0, 5).padStart(5, '0') : undefined;
      hours[day] = open && close ? { open, close } : null;
    } else {
      hours[day] = null;
    }
  }

  const service_area = (Array.isArray(r.service_area) ? r.service_area : [])
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .map((s) => s.trim())
    .slice(0, 15);

  const faqs: FAQ[] = (Array.isArray(r.faqs) ? r.faqs : []).slice(0, 15).flatMap((f) => {
    const o = (f ?? {}) as Record<string, unknown>;
    const q = typeof o.question === 'string' ? o.question.trim() : '';
    const a = typeof o.answer === 'string' ? o.answer.trim() : '';
    return q && a ? [{ question: q, answer: a }] : [];
  });

  const pricing_notes = typeof r.pricing_notes === 'string' ? r.pricing_notes.trim() : '';

  let confidence: ExtractionResult['confidence'] = 'low';
  if (r.confidence === 'high' || r.confidence === 'medium') confidence = r.confidence;
  if (services.length === 0) confidence = 'low';

  return { name, services, hours, service_area, faqs, pricing_notes, confidence, source };
}

export async function extractFromUrl(url: string): Promise<ExtractionResult> {
  const guessName = (() => {
    try {
      const host = new URL(normalizeUrl(url) ?? `https://${url}`).hostname.replace(/^www\./, '');
      const base = host.split('.')[0];
      return base ? base[0].toUpperCase() + base.slice(1) : 'This Business';
    } catch {
      return 'This Business';
    }
  })();

  const normalized = normalizeUrl(url);
  if (!normalized) return templateResult(guessName);

  let text: string;
  try {
    const base = new URL(normalized);
    const extraPaths = ['/contact', '/services', '/about'];
    const [home, ...extras] = await Promise.all([
      fetchText(normalized, PAGE_CAP),
      ...extraPaths.map((p) => {
        const u = new URL(p, base);
        return fetchText(u.toString(), EXTRA_PAGE_CAP).catch(() => '');
      }),
    ]);
    text = [home, ...extras.filter(Boolean)].join('\n\n=== ADDITIONAL PAGE ===\n\n').trim();
    if (!text || text.replace(/\s/g, '').length < 40) return templateResult(guessName);
  } catch {
    return templateResult(guessName);
  }

  if (!hasLlm()) return templateResult(guessName);

  const { value, mocked } = await generateJson<ExtractionResult>({
    messages: [
      { role: 'system', content: 'You are a precise data-extraction engine. You output only valid JSON.' },
      { role: 'user', content: extractPrompt(normalized, text) },
    ],
    fallback: templateResult(guessName),
  });

  if (mocked) return templateResult(guessName);

  try {
    const result = sanitize(value, guessName, 'scrape');
    if (result.services.length === 0) return templateResult(guessName);
    return result;
  } catch {
    return templateResult(guessName);
  }
}
