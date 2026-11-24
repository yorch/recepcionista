/**
 * Call-forwarding instructions for connecting an owner's EXISTING business line to the AI number.
 * Pure data + string building (no I/O), so it is unit-tested. Codes are the standard GSM supplementary
 * service codes (conditional forwarding: **61* no answer, **67* busy, **62* unreachable, **004* all
 * conditional) and the common US landline/Verizon star codes. Carriers differ: the UI says so.
 */

export type CarrierId = 'att' | 'tmobile' | 'verizon' | 'gsm' | 'landline' | 'voip';

export interface DialStep {
  label: string;
  /** Exactly what to dial (copyable). Omitted for non-dial instructions. */
  dial?: string;
  note?: string;
}

export interface ForwardingGuide {
  id: CarrierId;
  name: string;
  intro: string;
  setup: DialStep[];
  cancel: DialStep[];
  notes: string[];
}

export const CARRIERS: { id: CarrierId; name: string }[] = [
  { id: 'att', name: 'AT&T' },
  { id: 'tmobile', name: 'T-Mobile / Metro' },
  { id: 'verizon', name: 'Verizon' },
  { id: 'gsm', name: 'Other mobile carrier' },
  { id: 'landline', name: 'Landline' },
  { id: 'voip', name: 'Office phone system / VoIP' },
];

/** Seconds of ringing before a no-answer forward kicks in (GSM allows 5 to 30 in steps of 5). */
export const DEFAULT_RING_SECONDS = 20;

/** Digits only, e.g. "+1 (305) 555-0142" -> "13055550142". */
export function digitsOf(phone: string): string {
  return phone.replace(/\D/g, '');
}

/** The number as a US dialer wants it for star-code carriers: 10 digits (drops a leading 1). */
export function tenDigits(phone: string): string {
  const d = digitsOf(phone);
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
}

/** "+1 305 555 0142" style for display. Falls back to the input when it is not a US/CA number. */
export function prettyPhone(phone: string): string {
  const d = digitsOf(phone);
  if (d.length === 11 && d.startsWith('1')) return `+1 ${d.slice(1, 4)} ${d.slice(4, 7)} ${d.slice(7)}`;
  return phone;
}

export function e164Of(phone: string): string {
  const d = digitsOf(phone);
  return phone.trim().startsWith('+') || d.length > 10 ? `+${d}` : `+1${d}`;
}

const GSM_NOTES = [
  'If a code is rejected, call your carrier and ask for "conditional call forwarding for no answer and busy" to this number. It is a free feature on most plans.',
  'You will hear a confirmation tone or see a message on screen. Then test it (next step).',
];

function gsmGuide(id: CarrierId, name: string, ringSeconds: number, num: string): ForwardingGuide {
  const e = e164Of(num);
  return {
    id, name,
    intro: 'Dial these on the phone whose number customers call, then press call. Your phone still rings first; she answers only if you do not.',
    setup: [
      { label: 'When you do not answer', dial: `**61*${e}**${ringSeconds}#`, note: `Rings ${ringSeconds} seconds (about ${Math.round(ringSeconds / 5)} rings), then she picks up.` },
      { label: 'When your line is busy', dial: `**67*${e}#` },
      { label: 'When your phone is off or has no signal', dial: `**62*${e}#` },
      { label: 'Or set all three at once', dial: `**004*${e}#`, note: 'Quickest option on most carriers. Skip the three codes above if you use this.' },
    ],
    cancel: [
      { label: 'Turn off all conditional forwarding', dial: '##004#' },
      { label: 'Turn off just "no answer"', dial: '##61#' },
    ],
    notes: GSM_NOTES,
  };
}

export function forwardingGuide(id: CarrierId, aiNumber: string, ringSeconds = DEFAULT_RING_SECONDS): ForwardingGuide {
  const ten = tenDigits(aiNumber);
  switch (id) {
    case 'att':
      return gsmGuide('att', 'AT&T', ringSeconds, aiNumber);
    case 'tmobile':
      return gsmGuide('tmobile', 'T-Mobile / Metro', ringSeconds, aiNumber);
    case 'gsm':
      return gsmGuide('gsm', 'Other mobile carrier', ringSeconds, aiNumber);
    case 'verizon':
      return {
        id, name: 'Verizon',
        intro: 'Dial the code from the phone whose number customers call. Wait for the confirmation tone, then hang up.',
        setup: [
          { label: 'When you do not answer or are busy', dial: `*71${ten}`, note: 'Rings about 4 times (roughly 20 seconds), then she picks up.' },
          { label: 'Or send every call to her (no ringing)', dial: `*72${ten}`, note: 'Use only when you want her to answer everything.' },
        ],
        cancel: [{ label: 'Turn forwarding off', dial: '*73' }],
        notes: ['Verizon Wireless star codes. For Fios or business lines, use the "no answer / busy" forwarding setting in your online account instead.'],
      };
    case 'landline':
      return {
        id, name: 'Landline',
        intro: 'Dial the code from the landline itself. Wait for the confirmation tone, then hang up.',
        setup: [
          { label: 'When you do not answer', dial: `*92${ten}`, note: 'Most US landlines. Rings 4 to 6 times first.' },
          { label: 'When your line is busy', dial: `*90${ten}` },
          { label: 'Or send every call to her (no ringing)', dial: `*72${ten}` },
        ],
        cancel: [
          { label: 'Turn off all forwarding', dial: '*73' },
          { label: 'Turn off no-answer forwarding', dial: '*93' },
          { label: 'Turn off busy forwarding', dial: '*91' },
        ],
        notes: [
          'Star codes differ by provider (some use *61 for no answer and *67 for busy). If one does not work, try the other, or call your phone company and ask for call forwarding on no answer and busy.',
        ],
      };
    case 'voip':
      return {
        id, name: 'Office phone system / VoIP',
        intro: 'Open your phone system admin page (RingCentral, Vonage, Grasshopper, Google Voice, 8x8, a PBX) and add a forwarding rule.',
        setup: [
          { label: 'Forward calls to', dial: e164Of(aiNumber) },
          { label: 'Rule', note: 'No answer after 15 to 20 seconds, and when busy or offline. Keep your own phones ringing first.' },
        ],
        cancel: [{ label: 'Delete or disable the forwarding rule in the same admin page.' }],
        notes: ['Your provider may call this "call handling", "failover", "find me follow me" or "after-hours routing".'],
      };
  }
}

export function ringExplanation(ringSeconds = DEFAULT_RING_SECONDS): string {
  return `Callers hear your phone ring for about ${ringSeconds} seconds. If you pick up, nothing changes. If you do not, the call moves to her, and she greets them in English or Spanish.`;
}
