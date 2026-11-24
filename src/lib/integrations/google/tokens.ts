/** Access-token lifecycle: refresh on demand, coalesced; invalid_grant / revoked => needs_reauth + owner email + audit. Tokens are never logged. */
import { getBusiness, recordAudit } from '@/lib/db';
import {
  getCalendarConnectionById, getDecryptedTokens, setCalendarConnectionStatus, updateCalendarTokens,
} from '@/lib/db/calendar';
import { listBusinessUsers } from '@/lib/db/users';
import { sendEmail } from '@/lib/email';
import { appBase, clientCredentials, GOOGLE_TOKEN_URL } from './config';
import { GoogleApiError, googleFetch, toApiError } from './http';
import { makeT } from '@/lib/i18n';
import { logger } from '@/lib/log';

const log = logger('gcal');
const SKEW_MS = 90_000;
const inflight = new Map<string, Promise<string>>();

export class NeedsReauthError extends Error {
  constructor() { super('google calendar needs reauthorization'); this.name = 'NeedsReauthError'; }
}

export interface TokenResponse { access_token: string; refresh_token?: string; expires_in?: number; scope?: string }

export async function postToken(params: Record<string, string>): Promise<TokenResponse> {
  const { id, secret } = clientCredentials();
  const res = await googleFetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: secret, ...params }).toString(),
  });
  if (!res.ok) throw await toApiError(res);
  const j = (await res.json()) as TokenResponse;
  if (!j.access_token) throw new GoogleApiError(502, 'no_access_token');
  return j;
}

/** Flip an active (or failing, 'error') connection to needs_reauth ONCE (audit + owner email). Never throws. A revoked / already needs_reauth one is left alone. */
export async function markNeedsReauth(connectionId: string, reason: string): Promise<void> {
  try {
    const conn = await getCalendarConnectionById(connectionId);
    if (!conn || (conn.status !== 'active' && conn.status !== 'error')) return;
    if (!(await setCalendarConnectionStatus(connectionId, 'needs_reauth', reason))) return; // revoked meanwhile
    await recordAudit({ actor_kind: 'system', business_id: conn.business_id, action: 'calendar.needs_reauth', target: `calendar:${conn.id}`, meta: { reason } });
    const [biz, users] = await Promise.all([getBusiness(conn.business_id), listBusinessUsers(conn.business_id)]);
    const owners = users.filter((u) => u.role === 'owner' && u.email);
    for (const o of owners) {
      try {
        const t = makeT(o.locale ?? 'en');
        await sendEmail({
          to: o.email,
          subject: t('mail.gcal.subject'),
          text: t('mail.gcal.body', { business: biz?.name ?? t('mail.gcal.fallbackBusiness'), reason, url: `${appBase()}/dashboard/settings#google-calendar` }),
        });
      } catch (err) { log.warn('reauth_email_failed', { connection: connectionId, err }); }
    }
  } catch (err) { log.error('mark_needs_reauth_failed', { connection: connectionId, err }); }
}

async function refresh(connectionId: string): Promise<string> {
  const tokens = await getDecryptedTokens(connectionId);
  if (!tokens?.refresh_token) { await markNeedsReauth(connectionId, 'no_refresh_token'); throw new NeedsReauthError(); }
  let r: TokenResponse;
  try {
    r = await postToken({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
  } catch (err) {
    if (err instanceof GoogleApiError && (err.reason === 'invalid_grant' || err.reason === 'unauthorized_client')) {
      await markNeedsReauth(connectionId, err.reason);
      throw new NeedsReauthError();
    }
    throw err;
  }
  const expires = new Date(Date.now() + (r.expires_in ?? 3600) * 1000);
  await updateCalendarTokens(connectionId, { access_token: r.access_token, token_expires_at: expires, ...(r.refresh_token ? { refresh_token: r.refresh_token } : {}) });
  return r.access_token;
}

/** A valid access token for the connection (refreshes when it expires within 90 s, or when `force`). Throws NeedsReauthError. */
export async function accessTokenFor(connectionId: string, opts: { force?: boolean } = {}): Promise<string> {
  const conn = await getCalendarConnectionById(connectionId);
  if (!conn) throw new NeedsReauthError();
  if (conn.status === 'revoked' || conn.status === 'needs_reauth') throw new NeedsReauthError();
  if (!opts.force) {
    const t = await getDecryptedTokens(connectionId);
    if (t?.access_token && t.token_expires_at && new Date(t.token_expires_at).getTime() - Date.now() > SKEW_MS) return t.access_token;
  }
  let p = inflight.get(connectionId);
  if (!p) {
    p = refresh(connectionId).finally(() => inflight.delete(connectionId));
    inflight.set(connectionId, p);
  }
  return p;
}
