/**
 * Availability over the business's own hours + existing bookings. Internal
 * calendar by design — no external calendar API in the MVP.
 */
import { getBookedSlots } from '@/lib/db';
import type { Business, TimeSlot } from '@/lib/types';

const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function atTime(dateStr: string, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(`${dateStr}T00:00:00`);
  d.setHours(h, m, 0, 0);
  return d;
}

export async function slotsForDate(
  business: Business,
  dateStr: string,
  durationMinutes = 60,
): Promise<TimeSlot[]> {
  const dow = DAY_KEYS[new Date(`${dateStr}T12:00:00`).getDay()];
  const hours = business.hours?.[dow];
  if (!hours) return [];

  const booked = new Set((await getBookedSlots(business.id, dateStr)).map((s) => new Date(s).getTime()));
  const open = atTime(dateStr, hours.open);
  const close = atTime(dateStr, hours.close);
  const slots: TimeSlot[] = [];

  for (let t = open.getTime(); t + durationMinutes * 60000 <= close.getTime(); t += 60 * 60000) {
    slots.push({
      start: new Date(t).toISOString(),
      end: new Date(t + durationMinutes * 60000).toISOString(),
      available: !booked.has(t),
    });
  }
  return slots;
}

/** Next N available slots starting today, skipping past times. */
export async function nextAvailable(business: Business, count = 3, durationMinutes = 60): Promise<TimeSlot[]> {
  const out: TimeSlot[] = [];
  const now = Date.now();
  for (let dayOffset = 0; dayOffset < 14 && out.length < count; dayOffset++) {
    const d = new Date();
    d.setDate(d.getDate() + dayOffset);
    const dateStr = d.toISOString().slice(0, 10);
    for (const slot of await slotsForDate(business, dateStr, durationMinutes)) {
      if (slot.available && new Date(slot.start).getTime() > now + 60 * 60000) {
        out.push(slot);
        if (out.length >= count) break;
      }
    }
  }
  return out;
}

export async function isWithinHours(business: Business, iso: string): Promise<boolean> {
  const d = new Date(iso);
  const dateStr = iso.slice(0, 10);
  return (await slotsForDate(business, dateStr)).some((s) => s.available || s.start === iso);
}
