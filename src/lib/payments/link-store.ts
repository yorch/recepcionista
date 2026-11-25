/**
 * Remember the Payment Link texted for a booking's deposit (the booking stores ONE id, the latest) and keep exactly that one payable:
 *  - the link it replaces is deactivated (a voice-tool link and a dashboard link, or two dashboard clicks, must not leave two live links),
 *  - a link made for a booking that was cancelled meanwhile (cancel raced the creation) is deactivated at once.
 * Best effort and never throws: the payments webhook still alerts the owner if a deactivated-too-late link is paid.
 */
import { getBooking, getBookingPaymentLinkId, prisma, recordAudit, replaceBookingPaymentLink } from '@/lib/db';
import { logger } from '@/lib/log';
import { deactivatePaymentLink, findActivePaymentLinksForBooking } from '@/lib/providers/stripe';

const log = logger('payments.link-store');

/** Thrown when a payment link is asked for a cancelled booking (the caller answers 409). */
export class BookingCancelledError extends Error {
  constructor() { super('the booking is cancelled; a deposit link cannot be created for it'); this.name = 'BookingCancelledError'; }
}

export async function rememberPaymentLink(bookingId: string, linkId: string): Promise<void> {
  try {
    const { stored, previous } = await replaceBookingPaymentLink(bookingId, linkId);
    if (!stored) return;
    const booking = await getBooking(bookingId);
    // The new link is dead on arrival when the booking was cancelled OR its deposit was paid (the owner marked it received, or a card payment landed)
    // while the link was being made: a stale snapshot must never leave a live link on a paid deposit.
    const deadOnArrival = booking?.status === 'cancelled' && !booking.deposit_paid ? 'booking_cancelled' : booking?.deposit_paid ? 'deposit_already_paid' : null;
    const stale = [previous, deadOnArrival ? linkId : null].filter((x): x is string => Boolean(x));
    for (const id of stale) {
      if (await deactivatePaymentLink(id) && booking) {
        await recordAudit({ actor_kind: 'system', business_id: booking.business_id, action: 'booking.payment_link_deactivated', target: `booking:${bookingId}`, meta: { link: id, reason: id === linkId ? deadOnArrival : 'replaced' } });
      }
    }
  } catch (err) {
    log.warn('remember.failed', { booking: bookingId, err });
  }
}

const QUEUE_SOURCE = 'link-deactivate';
/** Strict per-request timeout and search budget for the background work (a cancel never waits for it). */
const BG_REQUEST_MS = 4_000;
const BG_LOOKUP = { maxPages: 2, budgetMs: 6_000 };
const QUEUE_GIVE_UP_MS = 3 * 24 * 3600_000;
const inflight = new Set<Promise<unknown>>();
/** Test seam / graceful shutdown: resolves when the background deactivations started so far have finished. */
export async function flushLinkDeactivations(): Promise<void> { await Promise.allSettled([...inflight]); }

/**
 * Stop a booking's deposit link: the stored link id is deactivated; when NONE is stored (a link texted before the id was stored) the booking's links
 * are looked up in Stripe by their `booking_id` metadata (this business only) and deactivated too. Best effort, each deactivation audited
 * (`booking.payment_link_deactivated`, `via: 'stripe_lookup'` for the lookup), never throws. `complete` is false when Stripe could not be reached
 * (the queue retries). A payment that still arrives for a cancelled booking alerts the owner and reopens the refund (payments webhook).
 */
export async function deactivateLinksForCancelledBooking(
  booking: { id: string; business_id: string }, opts: { fetchImpl?: typeof fetch; timeoutMs?: number; lookup?: { maxPages?: number; budgetMs?: number } } = {},
): Promise<{ deactivated: number; via: 'stored' | 'lookup' | 'none'; complete: boolean }> {
  try {
    const stored = await getBookingPaymentLinkId(booking.id);
    let ids: string[]; let complete = true;
    if (stored) ids = [stored];
    else {
      const found = await findActivePaymentLinksForBooking(booking.id, { fetchImpl: opts.fetchImpl, businessId: booking.business_id, ...(opts.lookup ?? {}) });
      ids = found.ids; complete = found.complete;
    }
    const via = stored ? 'stored' as const : ids.length > 0 ? 'lookup' as const : 'none' as const;
    let deactivated = 0;
    for (const id of ids) {
      if (!(await deactivatePaymentLink(id, opts.fetchImpl, opts.timeoutMs))) { complete = false; continue; }
      deactivated++;
      await recordAudit({ actor_kind: 'system', business_id: booking.business_id, action: 'booking.payment_link_deactivated', target: `booking:${booking.id}`, meta: { link: id, ...(via === 'lookup' ? { via: 'stripe_lookup' } : {}) } });
    }
    return { deactivated, via, complete };
  } catch (err) {
    log.warn('cancel_deactivate.failed', { booking: booking.id, err });
    return { deactivated: 0, via: 'none', complete: false };
  }
}

async function runQueued(booking: { id: string; business_id: string }, fetchImpl?: typeof fetch): Promise<boolean> {
  const r = await deactivateLinksForCancelledBooking(booking, { fetchImpl, timeoutMs: BG_REQUEST_MS, lookup: BG_LOOKUP });
  if (r.complete) await prisma.processedEvent.deleteMany({ where: { source: QUEUE_SOURCE, id: booking.id } });
  return r.complete;
}

/**
 * Cancel path AND manual-mark path (the owner marked the deposit received by hand): the booking's deposit link must stop taking money, but a cancel (the dashboard, the customer's SMS, a live VOICE call)
 * never waits for Stripe and never pages Stripe's account-wide link list inline. Only a booking that HAD a deposit link attempt (a stored link id, or
 * a texted payment-link message) is queued at all; the queue row is durable (processed_events), the first attempt runs in the background right away
 * with strict short timeouts, and the reconcile job (drainLinkDeactivations) retries what failed for up to 3 days. Never throws.
 */
export async function scheduleLinkDeactivation(booking: { id: string; business_id: string }, opts: { fetchImpl?: typeof fetch } = {}): Promise<'none' | 'queued'> {
  try {
    const stored = await getBookingPaymentLinkId(booking.id);
    const texted = stored ? true : (await prisma.smsLog.findFirst({ where: { bookingId: booking.id, kind: 'payment_link' }, select: { id: true } })) !== null;
    if (!texted) return 'none';
    await prisma.processedEvent.upsert({ where: { source_id: { source: QUEUE_SOURCE, id: booking.id } }, create: { source: QUEUE_SOURCE, id: booking.id, status: 'processing' }, update: {} });
    const job = runQueued(booking, opts.fetchImpl).catch((err) => log.warn('link_deactivate.background_failed', { booking: booking.id, err }));
    inflight.add(job);
    void job.finally(() => inflight.delete(job));
    return 'queued';
  } catch (err) {
    log.warn('link_deactivate.schedule_failed', { booking: booking.id, err });
    return 'none';
  }
}

/** Reconcile-job pass: retries queued deactivations (oldest first, bounded), and drops the ones older than 3 days. Never throws. */
export async function drainLinkDeactivations(opts: { now?: Date; limit?: number; fetchImpl?: typeof fetch } = {}): Promise<{ considered: number; done: number; dropped: number }> {
  const now = opts.now ?? new Date();
  const out = { considered: 0, done: 0, dropped: 0 };
  try {
    out.dropped = (await prisma.processedEvent.deleteMany({ where: { source: QUEUE_SOURCE, createdAt: { lt: new Date(now.getTime() - QUEUE_GIVE_UP_MS) } } })).count;
    const rows = await prisma.processedEvent.findMany({
      where: { source: QUEUE_SOURCE, claimedAt: { lt: new Date(now.getTime() - 2 * 60_000) } }, orderBy: { claimedAt: 'asc' }, take: Math.min(Math.max(opts.limit ?? 20, 1), 100), select: { id: true },
    });
    out.considered = rows.length;
    for (const r of rows) {
      await prisma.processedEvent.updateMany({ where: { source: QUEUE_SOURCE, id: r.id }, data: { claimedAt: now } }); // rotate: a failing one does not starve the rest
      const b = await prisma.booking.findUnique({ where: { id: r.id }, select: { id: true, businessId: true, status: true, depositPaid: true, depositSource: true } });
      // Two reasons to stop a booking's link: it was cancelled unpaid, or its deposit was marked received by hand. A card-paid deposit has nothing to stop.
      const stop = b && ((b.status === 'cancelled' && !b.depositPaid) || (b.depositPaid && b.depositSource === 'manual'));
      if (!b || !stop) { await prisma.processedEvent.deleteMany({ where: { source: QUEUE_SOURCE, id: r.id } }); out.dropped++; continue; }
      if (await runQueued({ id: b.id, business_id: b.businessId }, opts.fetchImpl)) out.done++;
    }
  } catch (err) {
    log.warn('link_deactivate.drain_failed', { err });
  }
  return out;
}
