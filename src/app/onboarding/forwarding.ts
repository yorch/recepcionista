/**
 * Call-forwarding instructions for connecting an owner's EXISTING business line to the AI number.
 * Pure data + string building (no I/O), so it is unit-tested. Codes are the standard GSM supplementary
 * service codes (conditional forwarding: **61* no answer, **67* busy, **62* unreachable, **004* all
 * conditional) and the common US landline/Verizon star codes. Carriers differ: the UI says so.
 */

import type { TFunction } from '@/lib/i18n/core';

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

/** The carrier's display name in the viewer's language (the English names above are the fallback). */
export function carrierName(id: CarrierId, t: TFunction): string {
  return t(`cn.carrier.${id}` as const);
}

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

function gsmGuide(id: CarrierId, ringSeconds: number, num: string, t: TFunction): ForwardingGuide {
  const e = e164Of(num);
  return {
    id, name: carrierName(id, t),
    intro: t('fwd.gsm.intro'),
    setup: [
      { label: t('fwd.gsm.noAnswer'), dial: `**61*${e}**${ringSeconds}#`, note: t('fwd.gsm.noAnswerNote', { seconds: ringSeconds, rings: Math.round(ringSeconds / 5) }) },
      { label: t('fwd.gsm.busy'), dial: `**67*${e}#` },
      { label: t('fwd.gsm.off'), dial: `**62*${e}#` },
      { label: t('fwd.gsm.all'), dial: `**004*${e}#`, note: t('fwd.gsm.allNote') },
    ],
    cancel: [
      { label: t('fwd.gsm.cancelAll'), dial: '##004#' },
      { label: t('fwd.gsm.cancelNoAnswer'), dial: '##61#' },
    ],
    notes: [t('fwd.gsm.note1'), t('fwd.gsm.note2')],
  };
}

export function forwardingGuide(id: CarrierId, aiNumber: string, t: TFunction, ringSeconds: number = DEFAULT_RING_SECONDS): ForwardingGuide {
  const ten = tenDigits(aiNumber);
  switch (id) {
    case 'att':
    case 'tmobile':
    case 'gsm':
      return gsmGuide(id, ringSeconds, aiNumber, t);
    case 'verizon':
      return {
        id, name: carrierName(id, t),
        intro: t('fwd.vz.intro'),
        setup: [
          { label: t('fwd.vz.noAnswer'), dial: `*71${ten}`, note: t('fwd.vz.noAnswerNote') },
          { label: t('fwd.vz.all'), dial: `*72${ten}`, note: t('fwd.vz.allNote') },
        ],
        cancel: [{ label: t('fwd.vz.off'), dial: '*73' }],
        notes: [t('fwd.vz.note')],
      };
    case 'landline':
      return {
        id, name: carrierName(id, t),
        intro: t('fwd.ll.intro'),
        setup: [
          { label: t('fwd.ll.noAnswer'), dial: `*92${ten}`, note: t('fwd.ll.noAnswerNote') },
          { label: t('fwd.ll.busy'), dial: `*90${ten}` },
          { label: t('fwd.ll.all'), dial: `*72${ten}` },
        ],
        cancel: [
          { label: t('fwd.ll.offAll'), dial: '*73' },
          { label: t('fwd.ll.offNoAnswer'), dial: '*93' },
          { label: t('fwd.ll.offBusy'), dial: '*91' },
        ],
        notes: [t('fwd.ll.note')],
      };
    case 'voip':
      return {
        id, name: carrierName(id, t),
        intro: t('fwd.voip.intro'),
        setup: [
          { label: t('fwd.voip.forwardTo'), dial: e164Of(aiNumber) },
          { label: t('fwd.voip.rule'), note: t('fwd.voip.ruleNote') },
        ],
        cancel: [{ label: t('fwd.voip.cancel') }],
        notes: [t('fwd.voip.note')],
      };
  }
}

export function ringExplanation(t: TFunction, ringSeconds: number = DEFAULT_RING_SECONDS): string {
  return t('fwd.ring', { seconds: ringSeconds });
}
