/**
 * Call screening state for a forwarded call (webhook / Twilio line). The whisper (`<Number url=/api/voice/screen>`) runs on the owner's
 * leg before bridging; it records, per PARENT call sid, WHEN the owner answered, WHEN they accepted (pressed 1) and whether they
 * declined, in `processed_events` rows (no schema). The Dial callbacks use them so that
 *   - a declined / unanswered whisper is NEVER metered as forwarded minutes and is treated as unanswered (caller -> voicemail), and
 *   - an accepted call is metered for the BRIDGED seconds only (leg duration minus the whisper).
 * UNVERIFIED against live Twilio (docs/runbook.md section 8 live test): whether DialCallDuration already excludes the whisper.
 */
import { claimEvent, prisma } from '@/lib/db';

const START = 'forward-screen-start';
const ACCEPT = 'forward-screen-accept';
const DECLINE = 'forward-screen-decline';

export const markScreenStarted = (parentSid: string): Promise<boolean> => claimEvent(START, parentSid, 24 * 3600_000);
export const markScreenAccepted = (parentSid: string): Promise<boolean> => claimEvent(ACCEPT, parentSid, 24 * 3600_000);
export const markScreenDeclined = (parentSid: string): Promise<boolean> => claimEvent(DECLINE, parentSid, 24 * 3600_000);

export interface ScreenOutcome { screened: boolean; declined: boolean; accepted: boolean; whisperSeconds: number }

export async function screenOutcome(parentSid: string): Promise<ScreenOutcome> {
  if (!parentSid) return { screened: false, declined: false, accepted: false, whisperSeconds: 0 };
  const rows = await prisma.processedEvent.findMany({ where: { id: parentSid, source: { in: [START, ACCEPT, DECLINE] } }, select: { source: true, claimedAt: true } });
  const at = (s: string) => rows.find((r) => r.source === s)?.claimedAt ?? null;
  const start = at(START); const accept = at(ACCEPT);
  return {
    screened: rows.length > 0, declined: at(DECLINE) !== null, accepted: accept !== null,
    whisperSeconds: start && accept ? Math.max(0, Math.round((accept.getTime() - start.getTime()) / 1000)) : 0,
  };
}

/** Seconds that were really bridged: 0 for a screened call that was not accepted, leg duration minus the whisper when accepted, else unchanged. */
export function bridgedSeconds(legSeconds: number | null, o: ScreenOutcome): number | null {
  if (!o.screened) return legSeconds;
  if (o.declined || !o.accepted) return 0;
  return legSeconds === null ? null : Math.max(0, legSeconds - o.whisperSeconds);
}
