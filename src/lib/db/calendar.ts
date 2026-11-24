/**
 * Google Calendar persistence: the connection (with ENCRYPTED tokens), the booking<->event links, and the busy blocks
 * mirrored from the owner's calendar. Node runtime only.
 *
 * Tokens: stored only as AES-256-GCM envelopes (src/lib/totp.ts encryptSecret) bound to the connection id (aad), so a token cannot
 * be copied from one row to another. Every function here returns the token-free `CalendarConnection`; the plaintext is available
 * only from `getDecryptedTokens`. Busy blocks hold times only: no title, description or attendee ever reaches the database.
 */
import crypto from 'node:crypto';
import { prisma, type DbClient } from './client';
import { decryptSecret, encryptSecret } from '@/lib/totp';
import type {
  BusyTransparency, CalendarBusyBlock, CalendarConnection, CalendarConnectionStatus, CalendarEventLink, CalendarProvider, CalendarTokens,
} from '@/lib/types';
import { CALENDAR_STATUSES } from '@/lib/types';
import type { CalendarBusyBlock as BusyRow, CalendarConnection as ConnRow, CalendarEventLink as LinkRow } from '@prisma/client';

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

function toConnection(r: ConnRow): CalendarConnection {
  return {
    id: r.id, business_id: r.businessId, connected_by_user_id: r.connectedByUserId, provider: r.provider as CalendarProvider,
    account_email: r.accountEmail, calendar_id: r.calendarId, token_expires_at: iso(r.tokenExpiresAt), scopes: r.scopes,
    has_refresh_token: r.refreshTokenEnc !== null, sync_token: r.syncToken, watch_channel_id: r.watchChannelId,
    watch_resource_id: r.watchResourceId, watch_expires_at: iso(r.watchExpiresAt), status: r.status as CalendarConnectionStatus,
    last_sync_at: iso(r.lastSyncAt), last_error: r.lastError, created_at: r.createdAt.toISOString(), updated_at: r.updatedAt.toISOString(),
  };
}

const toLink = (r: LinkRow): CalendarEventLink => ({
  id: r.id, booking_id: r.bookingId, connection_id: r.connectionId, google_event_id: r.googleEventId, etag: r.etag,
  last_synced_at: r.lastSyncedAt.toISOString(), last_pushed_hash: r.lastPushedHash,
});

const toBlock = (r: BusyRow): CalendarBusyBlock => ({
  id: r.id, connection_id: r.connectionId, business_id: r.businessId, google_event_id: r.googleEventId,
  starts_at: r.startsAt.toISOString(), ends_at: r.endsAt.toISOString(), all_day: r.allDay,
  transparency: r.transparency as BusyTransparency, summary_redacted: r.summaryRedacted, updated_at: r.updatedAt.toISOString(),
});

const clip = (v: string | null | undefined, max: number): string | null => (v ? v.slice(0, max) : null);
const isUnique = (err: unknown): boolean => (err as { code?: string } | null)?.code === 'P2002';

// ── connections ──────────────────────────────────────────────────────────────

export interface ConnectCalendarInput {
  business_id: string;
  connected_by_user_id?: string | null;
  provider?: CalendarProvider;
  account_email: string;
  calendar_id?: string;
  access_token: string;
  /** Required: without a refresh token the connection dies in an hour. */
  refresh_token: string;
  token_expires_at: Date | string | null;
  scopes?: string;
}

/**
 * Create the business's connection, or RE-connect it (same row, so ids and links survive): new tokens, status 'active', the old
 * sync token and push channel forgotten (the next sync is a full one). One connection per (business, provider). Reconnecting the
 * same Google account keeps the chosen calendar; a different account starts on `calendar_id` (default 'primary') and the caller
 * must have cleaned up the old account's events first (see resetForNewAccount).
 */
export async function upsertCalendarConnection(input: ConnectCalendarInput): Promise<CalendarConnection> {
  const provider = input.provider ?? 'google';
  if (!input.access_token || !input.refresh_token) throw new Error('upsertCalendarConnection: access and refresh tokens are required');
  const expires = input.token_expires_at ? new Date(input.token_expires_at) : null;
  if (expires && Number.isNaN(expires.getTime())) throw new Error('upsertCalendarConnection: invalid token_expires_at');
  const accountEmail = input.account_email.trim().toLowerCase().slice(0, 320);
  const common = {
    connectedByUserId: input.connected_by_user_id ?? null,
    accountEmail,
    tokenExpiresAt: expires,
    scopes: (input.scopes ?? '').slice(0, 2000),
    syncToken: null, watchChannelId: null, watchResourceId: null, watchExpiresAt: null,
    status: 'active', lastError: null,
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await prisma.calendarConnection.findUnique({ where: { businessId_provider: { businessId: input.business_id, provider } }, select: { id: true, accountEmail: true } });
    const id = existing?.id ?? crypto.randomUUID();
    // Reconnecting the SAME Google account keeps the calendar the owner picked (a reconnect after needs_reauth must not silently
    // move the sync back to 'primary'); a different account gets the requested calendar ('primary' by default).
    const calendarId = clip(input.calendar_id, 300) ?? 'primary';
    const keepCalendar = existing !== null && existing.accountEmail === accountEmail;
    const enc = { accessTokenEnc: encryptSecret(input.access_token, id), refreshTokenEnc: encryptSecret(input.refresh_token, id) };
    try {
      const row = existing
        ? await prisma.calendarConnection.update({ where: { id }, data: { ...common, ...(keepCalendar ? {} : { calendarId }), ...enc } })
        : await prisma.calendarConnection.create({ data: { id, businessId: input.business_id, provider, ...common, calendarId, ...enc } });
      return toConnection(row);
    } catch (err) {
      // lost a create race (unique business+provider): loop and take the update path with the winner's id
      if (!(isUnique(err) || (err as { code?: string })?.code === 'P2025') || attempt === 2) throw err;
    }
  }
  throw new Error('unreachable');
}

export async function getCalendarConnection(businessId: string, provider: CalendarProvider = 'google'): Promise<CalendarConnection | null> {
  const row = await prisma.calendarConnection.findUnique({ where: { businessId_provider: { businessId, provider } } });
  return row ? toConnection(row) : null;
}

export async function getCalendarConnectionById(id: string): Promise<CalendarConnection | null> {
  const row = await prisma.calendarConnection.findUnique({ where: { id } });
  return row ? toConnection(row) : null;
}

/** A push-notification channel id (Google `X-Goog-Channel-ID`) back to its connection. */
export async function getCalendarConnectionByChannel(channelId: string): Promise<CalendarConnection | null> {
  if (!channelId) return null;
  const row = await prisma.calendarConnection.findFirst({ where: { watchChannelId: channelId } });
  return row ? toConnection(row) : null;
}

export async function listCalendarConnections(opts: { status?: CalendarConnectionStatus; limit?: number } = {}): Promise<CalendarConnection[]> {
  const rows = await prisma.calendarConnection.findMany({
    where: opts.status ? { status: opts.status } : {}, orderBy: { createdAt: 'asc' }, take: Math.min(Math.max(opts.limit ?? 200, 1), 1000),
  });
  return rows.map(toConnection);
}

/** Active connections whose push channel is missing or expires before `before` (the renewal job). */
export async function listConnectionsNeedingWatchRenewal(before: Date, limit = 100): Promise<CalendarConnection[]> {
  const rows = await prisma.calendarConnection.findMany({
    where: { status: 'active', OR: [{ watchExpiresAt: null }, { watchExpiresAt: { lt: before } }] },
    orderBy: { watchExpiresAt: { sort: 'asc', nulls: 'first' } }, take: Math.min(Math.max(limit, 1), 500),
  });
  return rows.map(toConnection);
}

/** The ONLY way to read the plaintext tokens. Throws when an envelope cannot be decrypted (wrong key or tampering). Null: no connection. */
export async function getDecryptedTokens(connectionId: string): Promise<CalendarTokens | null> {
  const r = await prisma.calendarConnection.findUnique({
    where: { id: connectionId }, select: { id: true, accessTokenEnc: true, refreshTokenEnc: true, tokenExpiresAt: true },
  });
  if (!r) return null;
  return {
    access_token: r.accessTokenEnc ? decryptSecret(r.accessTokenEnc, r.id) : null,
    refresh_token: r.refreshTokenEnc ? decryptSecret(r.refreshTokenEnc, r.id) : null,
    token_expires_at: iso(r.tokenExpiresAt),
  };
}

/** Store a refreshed access token (and, when Google rotated it, the refresh token). Returns false when the connection is gone or revoked. */
export async function updateCalendarTokens(
  connectionId: string, tokens: { access_token: string; token_expires_at: Date | string | null; refresh_token?: string },
): Promise<boolean> {
  const expires = tokens.token_expires_at ? new Date(tokens.token_expires_at) : null;
  // Never changes the status (a refresh that returns after Disconnect must not resurrect a revoked connection) and never writes a
  // token into a revoked row.
  const res = await prisma.calendarConnection.updateMany({
    where: { id: connectionId, status: { not: 'revoked' } },
    data: {
      accessTokenEnc: encryptSecret(tokens.access_token, connectionId), tokenExpiresAt: expires,
      ...(tokens.refresh_token ? { refreshTokenEnc: encryptSecret(tokens.refresh_token, connectionId) } : {}),
    },
  });
  return res.count === 1;
}

export interface CalendarSyncPatch {
  sync_token?: string | null;
  watch_channel_id?: string | null;
  watch_resource_id?: string | null;
  watch_expires_at?: Date | string | null;
  calendar_id?: string;
  last_sync_at?: Date | string | null;
  last_error?: string | null;
}

/**
 * Sync bookkeeping (never tokens or status; use updateCalendarTokens / setCalendarConnectionStatus). Returns the connection or null
 * (unknown connection, or `expectCalendarId` no longer matches: the owner switched calendars while the caller was working, so its
 * result belongs to the OLD calendar and must be discarded).
 */
export async function updateCalendarSyncState(connectionId: string, patch: CalendarSyncPatch, opts: { expectCalendarId?: string } = {}): Promise<CalendarConnection | null> {
  const d = (v: Date | string | null | undefined) => (v === undefined ? undefined : v === null ? null : new Date(v));
  try {
    const where = opts.expectCalendarId !== undefined
      ? { id: connectionId, calendarId: opts.expectCalendarId.slice(0, 300), status: { not: 'revoked' } }
      : { id: connectionId };
    const data = {
        ...(patch.sync_token !== undefined ? { syncToken: patch.sync_token } : {}),
        ...(patch.watch_channel_id !== undefined ? { watchChannelId: patch.watch_channel_id } : {}),
        ...(patch.watch_resource_id !== undefined ? { watchResourceId: patch.watch_resource_id } : {}),
        ...(patch.watch_expires_at !== undefined ? { watchExpiresAt: d(patch.watch_expires_at) } : {}),
        ...(patch.calendar_id !== undefined ? { calendarId: patch.calendar_id.slice(0, 300) } : {}),
        ...(patch.last_sync_at !== undefined ? { lastSyncAt: d(patch.last_sync_at) } : {}),
        ...(patch.last_error !== undefined ? { lastError: clip(patch.last_error, 500) } : {}),
      };
    const res = await prisma.calendarConnection.updateMany({ where, data });
    if (res.count !== 1) return null;
    const row = await prisma.calendarConnection.findUnique({ where: { id: connectionId } });
    return row ? toConnection(row) : null;
  } catch (err) {
    if ((err as { code?: string })?.code === 'P2025') return null;
    throw err;
  }
}

/**
 * Change the connection state. 'revoked' also WIPES the stored tokens, the sync token and the push channel and deletes the mirrored
 * busy blocks (a disconnected calendar must neither keep credentials nor keep blocking time). Other states keep everything.
 * Returns false when the connection does not exist, or when a non-'revoked' status is requested for a connection that is already revoked.
 */
export async function setCalendarConnectionStatus(connectionId: string, status: CalendarConnectionStatus, lastError: string | null = null): Promise<boolean> {
  if (!CALENDAR_STATUSES.includes(status)) throw new Error('setCalendarConnectionStatus: invalid status');
  return prisma.$transaction(async (tx) => {
    // 'revoked' is terminal for in-flight work: only a reconnect (upsertCalendarConnection) leaves it. A sync / refresh that finishes
    // after Disconnect must not flip the row back to active / error.
    const res = await tx.calendarConnection.updateMany({
      where: status === 'revoked' ? { id: connectionId } : { id: connectionId, status: { not: 'revoked' } },
      data: status === 'revoked'
        ? { status, lastError: clip(lastError, 500), accessTokenEnc: null, refreshTokenEnc: null, tokenExpiresAt: null, syncToken: null, watchChannelId: null, watchResourceId: null, watchExpiresAt: null }
        : { status, lastError: clip(lastError, 500) },
    });
    if (res.count !== 1) return false;
    if (status === 'revoked') await tx.calendarBusyBlock.deleteMany({ where: { connectionId } });
    return true;
  });
}

/** Delete the connection; its links and busy blocks go with it (cascade). */
export async function deleteCalendarConnection(connectionId: string): Promise<boolean> {
  const res = await prisma.calendarConnection.deleteMany({ where: { id: connectionId } });
  return res.count === 1;
}

// ── booking <-> event links ──────────────────────────────────────────────────

export interface EventLinkInput {
  booking_id: string;
  connection_id: string;
  google_event_id: string;
  etag?: string | null;
  last_pushed_hash?: string | null;
  at?: Date;
}

/** Create or update the link of a booking (one event per booking). */
export async function upsertEventLink(input: EventLinkInput): Promise<CalendarEventLink> {
  const at = input.at ?? new Date();
  const data = {
    connectionId: input.connection_id, googleEventId: input.google_event_id, etag: input.etag ?? null,
    lastPushedHash: input.last_pushed_hash ?? null, lastSyncedAt: at,
  };
  const row = await prisma.calendarEventLink.upsert({ where: { bookingId: input.booking_id }, update: data, create: { bookingId: input.booking_id, ...data } });
  return toLink(row);
}

export async function getEventLinkByBooking(bookingId: string): Promise<CalendarEventLink | null> {
  const row = await prisma.calendarEventLink.findUnique({ where: { bookingId } });
  return row ? toLink(row) : null;
}

export async function getEventLinkByGoogleEvent(connectionId: string, googleEventId: string): Promise<CalendarEventLink | null> {
  const row = await prisma.calendarEventLink.findUnique({ where: { connectionId_googleEventId: { connectionId, googleEventId } } });
  return row ? toLink(row) : null;
}

/** Record that the event was seen/pushed again (new etag / hash) without touching its identity. */
export async function touchEventLink(bookingId: string, patch: { etag?: string | null; last_pushed_hash?: string | null }, at: Date = new Date()): Promise<boolean> {
  const res = await prisma.calendarEventLink.updateMany({
    where: { bookingId },
    data: {
      lastSyncedAt: at,
      ...(patch.etag !== undefined ? { etag: patch.etag } : {}),
      ...(patch.last_pushed_hash !== undefined ? { lastPushedHash: patch.last_pushed_hash } : {}),
    },
  });
  return res.count === 1;
}

export async function deleteEventLink(bookingId: string): Promise<boolean> {
  const res = await prisma.calendarEventLink.deleteMany({ where: { bookingId } });
  return res.count === 1;
}

export async function listEventLinksForConnection(connectionId: string, limit = 1000): Promise<CalendarEventLink[]> {
  const rows = await prisma.calendarEventLink.findMany({ where: { connectionId }, orderBy: { lastSyncedAt: 'asc' }, take: Math.min(Math.max(limit, 1), 5000) });
  return rows.map(toLink);
}

// ── busy blocks ──────────────────────────────────────────────────────────────

export interface BusyBlockInput {
  google_event_id: string;
  starts_at: Date | string;
  ends_at: Date | string;
  all_day?: boolean;
  transparency?: BusyTransparency;
}

function normBlock(b: BusyBlockInput): { googleEventId: string; startsAt: Date; endsAt: Date; allDay: boolean; transparency: BusyTransparency } | null {
  const startsAt = new Date(b.starts_at);
  const endsAt = new Date(b.ends_at);
  if (!b.google_event_id || Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt.getTime() < startsAt.getTime()) return null;
  return { googleEventId: b.google_event_id.slice(0, 1024), startsAt, endsAt, allDay: b.all_day === true, transparency: b.transparency === 'transparent' ? 'transparent' : 'opaque' };
}

const CHUNK = 1000;

/**
 * Replace ALL busy blocks of a connection with `rows` in one transaction (a full resync). Malformed rows (bad dates, end before
 * start, no event id) are skipped; a repeated event id keeps its last row. Returns how many rows are stored.
 * Only times are stored; there is deliberately no way to pass a title.
 */
export async function replaceBusyBlocks(connectionId: string, rows: BusyBlockInput[]): Promise<number> {
  return (await replaceBusyBlocksIf(connectionId, rows)).stored;
}

/**
 * replaceBusyBlocks, but conditional: with `expectCalendarId` the rows are written only while the connection still syncs THAT
 * calendar and is not revoked (checked under a row lock, so a concurrent calendar switch or Disconnect waits for this
 * transaction and a later one sees the result). `applied: false` means the rows were discarded.
 */
export async function replaceBusyBlocksIf(connectionId: string, rows: BusyBlockInput[], opts: { expectCalendarId?: string } = {}): Promise<{ applied: boolean; stored: number }> {
  const byEvent = new Map<string, NonNullable<ReturnType<typeof normBlock>>>();
  for (const r of rows) { const n = normBlock(r); if (n) byEvent.set(n.googleEventId, n); }
  return prisma.$transaction(async (tx) => {
    const found = await tx.$queryRaw<{ business_id: string; calendar_id: string; status: string }[]>`
      SELECT "business_id", "calendar_id", "status" FROM "calendar_connections" WHERE "id" = ${connectionId} FOR SHARE`;
    const conn = found[0];
    if (!conn) return { applied: false, stored: 0 };
    if (opts.expectCalendarId !== undefined && (conn.calendar_id !== opts.expectCalendarId.slice(0, 300) || conn.status === 'revoked')) return { applied: false, stored: 0 };
    await tx.calendarBusyBlock.deleteMany({ where: { connectionId } });
    const data = [...byEvent.values()].map((n) => ({ connectionId, businessId: conn.business_id, ...n }));
    for (let i = 0; i < data.length; i += CHUNK) await tx.calendarBusyBlock.createMany({ data: data.slice(i, i + CHUNK) });
    return { applied: true, stored: data.length };
  }, { timeout: 60_000 });
}

/** Insert or update one busy block (incremental sync). Returns null for a malformed row or an unknown connection. */
export async function upsertBusyBlock(connectionId: string, row: BusyBlockInput, db: DbClient = prisma, opts: { expectCalendarId?: string } = {}): Promise<CalendarBusyBlock | null> {
  const n = normBlock(row);
  if (!n) return null;
  const conn = await db.calendarConnection.findUnique({ where: { id: connectionId }, select: { businessId: true, calendarId: true, status: true } });
  if (!conn) return null;
  if (opts.expectCalendarId !== undefined && (conn.calendarId !== opts.expectCalendarId || conn.status === 'revoked')) return null; // the calendar was switched / disconnected meanwhile
  const saved = await db.calendarBusyBlock.upsert({
    where: { connectionId_googleEventId: { connectionId, googleEventId: n.googleEventId } },
    update: { startsAt: n.startsAt, endsAt: n.endsAt, allDay: n.allDay, transparency: n.transparency, summaryRedacted: true },
    create: { connectionId, businessId: conn.businessId, ...n },
  });
  return toBlock(saved);
}

/** Remove one event's block (it was deleted or cancelled in Google). True when a row was removed. */
export async function deleteBusyBlock(connectionId: string, googleEventId: string): Promise<boolean> {
  const res = await prisma.calendarBusyBlock.deleteMany({ where: { connectionId, googleEventId } });
  return res.count === 1;
}

/**
 * Busy blocks of a business that intersect [fromUtc, toUtc), soonest first, BOUNDED (default 2000). Events marked 'transparent'
 * (shown as free in Google) are left out unless `includeTransparent`. Blocks of a revoked connection do not exist (they are deleted).
 */
export async function listBusyBlocksInRange(
  businessId: string, fromUtc: Date, toUtc: Date, opts: { includeTransparent?: boolean; limit?: number } = {},
): Promise<CalendarBusyBlock[]> {
  const rows = await prisma.calendarBusyBlock.findMany({
    where: {
      businessId, startsAt: { lt: toUtc }, endsAt: { gt: fromUtc },
      ...(opts.includeTransparent ? {} : { transparency: 'opaque' }),
    },
    orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    take: Math.min(Math.max(opts.limit ?? 2000, 1), 10_000),
  });
  return rows.map(toBlock);
}
