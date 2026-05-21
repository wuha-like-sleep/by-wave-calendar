import { and, eq, gte, lte, isNull } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { newEventUid, newInvitationToken } from "./ids.js";

export type WeeklyAvailability = Record<string, [string, string][] | null>;
export type Slot = { startsAt: Date; endsAt: Date };

export const DEFAULT_AVAILABILITY: WeeklyAvailability = {
  "0": null, // Sun
  "1": [["09:00", "18:00"]], // Mon
  "2": [["09:00", "18:00"]],
  "3": [["09:00", "18:00"]],
  "4": [["09:00", "18:00"]],
  "5": [["09:00", "18:00"]], // Fri
  "6": null, // Sat
};

function parseHM(s: string): { h: number; m: number } | null {
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]); const mm = Number(m[2]);
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  return { h, m: mm };
}

// Generate candidate slots for the link over the next maxDaysAhead days,
// then subtract anything overlapping with the owner's existing events.
// Times are computed as UTC instants from the link's weekly availability
// interpreted as the *server's local time* (Asia/Shanghai by default —
// matches existing convention).
export async function availableSlots(link: schema.BookingLink, fromUtc: Date, daysWindow: number): Promise<Slot[]> {
  const slotMinutes = link.durationMinutes;
  const bufferAfterMin = link.bufferAfterMin || 0;
  const bufferBeforeMin = link.bufferBeforeMin || 0;
  const minNoticeMs = (link.minNoticeHours || 0) * 60 * 60 * 1000;
  const earliestStart = new Date(fromUtc.getTime() + minNoticeMs);
  const endWindow = new Date(fromUtc.getTime() + daysWindow * 24 * 60 * 60 * 1000);

  // Pull all candidate slots from the weekly availability matrix.
  const availability = (link.weeklyAvailability as WeeklyAvailability) || DEFAULT_AVAILABILITY;
  const candidates: Slot[] = [];
  for (let i = 0; i < daysWindow; i++) {
    const day = new Date(fromUtc);
    day.setUTCDate(day.getUTCDate() + i);
    const dow = String(day.getUTCDay());
    const windows = availability[dow];
    if (!windows || windows.length === 0) continue;
    for (const [startStr, endStr] of windows) {
      const a = parseHM(startStr); const b = parseHM(endStr);
      if (!a || !b) continue;
      // Interpret times as Asia/Shanghai wall-clock — i.e. compute the UTC
      // instant where Shanghai's clock reads (a.h:a.m). Shanghai = UTC+8.
      const cursorMin = a.h * 60 + a.m;
      const endMin = b.h * 60 + b.m;
      for (let t = cursorMin; t + slotMinutes <= endMin; t += slotMinutes) {
        const startUtc = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 0, t - 8 * 60, 0));
        const endUtc = new Date(startUtc.getTime() + slotMinutes * 60 * 1000);
        if (startUtc < earliestStart) continue;
        if (endUtc > endWindow) continue;
        candidates.push({ startsAt: startUtc, endsAt: endUtc });
      }
    }
  }
  if (candidates.length === 0) return [];

  // Subtract existing events in the owner's calendar that overlap (including
  // a buffer cushion before and after each candidate).
  const calId = link.calendarId;
  const conflicts = await db
    .select({ startsAt: schema.events.startsAt, endsAt: schema.events.endsAt })
    .from(schema.events)
    .where(and(
      eq(schema.events.calendarId, calId),
      gte(schema.events.endsAt, candidates[0]!.startsAt),
      lte(schema.events.startsAt, candidates[candidates.length - 1]!.endsAt),
      isNull(schema.events.deletedAt),
    ));

  return candidates.filter((slot) => {
    const startWithBuffer = new Date(slot.startsAt.getTime() - bufferBeforeMin * 60_000);
    const endWithBuffer = new Date(slot.endsAt.getTime() + bufferAfterMin * 60_000);
    return !conflicts.some((c) => c.endsAt > startWithBuffer && c.startsAt < endWithBuffer);
  });
}

export async function findLinkBySlug(userId: string, slug: string): Promise<schema.BookingLink | null> {
  const [row] = await db.select().from(schema.bookingLinks).where(and(eq(schema.bookingLinks.userId, userId), eq(schema.bookingLinks.slug, slug))).limit(1);
  return row ?? null;
}

export type CreatedBooking = {
  booking: schema.Booking;
  event: schema.Event;
};

// Atomic booking: validates the slot is still free, creates an event in the
// owner's calendar, and stores the booking row that links back. Caller is
// responsible for sending confirmation emails.
export async function bookSlot(input: {
  link: schema.BookingLink;
  startsAt: Date;
  endsAt: Date;
  guestEmail: string;
  guestName: string;
  guestMessage?: string;
}): Promise<CreatedBooking> {
  // Re-check overlap; race could have filled the slot since we listed.
  const conflicts = await db
    .select({ id: schema.events.id })
    .from(schema.events)
    .where(and(
      eq(schema.events.calendarId, input.link.calendarId),
      gte(schema.events.endsAt, input.startsAt),
      lte(schema.events.startsAt, input.endsAt),
      isNull(schema.events.deletedAt),
    ))
    .limit(1);
  if (conflicts.length > 0) {
    throw new Error("时段已被占用，请选择其他时间");
  }

  const [event] = await db.insert(schema.events).values({
    calendarId: input.link.calendarId,
    uid: newEventUid(),
    summary: `${input.link.title} — ${input.guestName}`,
    description: input.guestMessage || null,
    location: null,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    allDay: false,
    rrule: null,
    extra: {
      attendees: [input.guestEmail],
      bookingLinkId: input.link.id,
      guestName: input.guestName,
    },
  }).returning();
  if (!event) throw new Error("事件创建失败");

  const [booking] = await db.insert(schema.bookings).values({
    linkId: input.link.id,
    eventId: event.id,
    guestEmail: input.guestEmail,
    guestName: input.guestName,
    guestMessage: input.guestMessage || null,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    cancelToken: newInvitationToken(),
  }).returning();
  if (!booking) throw new Error("预约记录创建失败");

  return { booking, event };
}
