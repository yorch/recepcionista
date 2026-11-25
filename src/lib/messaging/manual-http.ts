/** HTTP answers for a refused manual text (shared by the send and reply routes). */
import { NextResponse } from 'next/server';
import type { ManualTextResult } from '@/lib/messaging/manual';

type Reason = Extract<ManualTextResult, { ok: false }>['reason'];

const FAILURES: Record<Reason, { status: number; error: string; code: string }> = {
  empty: { status: 422, error: 'Write a message first.', code: 'empty' },
  too_long: { status: 422, error: 'Messages are limited to 320 characters.', code: 'too_long' },
  invalid_recipient: { status: 422, error: 'That is not a valid phone number.', code: 'invalid_recipient' },
  unknown_recipient: { status: 422, error: 'You can only text people who called, booked or texted this business.', code: 'unknown_recipient' },
  not_allowed: { status: 422, error: 'That number cannot be texted from here.', code: 'not_allowed' },
  rate_limited: { status: 429, error: 'Too many texts in the last hour. Try again later.', code: 'rate_limited' },
  quiet_hours: { status: 409, error: 'It is quiet hours (9pm to 8am) for this business. Try again in the morning.', code: 'quiet_hours' },
  opted_out: { status: 409, error: 'This customer opted out of texts.', code: 'opted_out' },
  cap_reached: { status: 402, error: 'This month\'s text allowance is used up.', code: 'cap_reached' },
  send_failed: { status: 502, error: 'The text could not be sent. Nothing was delivered.', code: 'send_failed' },
};

export function manualFailure(reason: Reason) {
  const f = FAILURES[reason];
  return NextResponse.json({ ok: false as const, error: f.error, code: f.code }, { status: f.status });
}

