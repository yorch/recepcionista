/**
 * Booking change hooks: a tiny in-process registry so integrations (Google Calendar sync, customer
 * notices, ...) can react to booking mutations without the db layer importing them.
 *
 * Callers emit AFTER the db transaction has committed. Handlers must never throw into the caller
 * and must be idempotent (a booking can be emitted more than once).
 */
export type BookingChangeKind = 'created' | 'updated' | 'cancelled' | 'rescheduled' | 'completed' | 'refunded';

export type BookingChangeHandler = (event: { bookingId: string; businessId?: string; kind: BookingChangeKind }) => Promise<void> | void;

const handlers = new Map<string, BookingChangeHandler>();

/** Register (or replace) a named handler. */
export function onBookingChanged(name: string, handler: BookingChangeHandler): void {
  handlers.set(name, handler);
}

/** Fire all handlers; failures are swallowed (and logged by the handler itself). */
export async function emitBookingChanged(bookingId: string, kind: BookingChangeKind, businessId?: string): Promise<void> {
  for (const [, handler] of handlers) {
    try {
      await handler({ bookingId, businessId, kind });
    } catch {
      /* integrations must not break booking flows */
    }
  }
}

/** Test helper. */
export function clearBookingHandlers(): void {
  handlers.clear();
}
