import { and, eq, gte, lte, isNotNull, isNull, or } from "drizzle-orm";
import { db, schema, type DB } from "../db/client.js";
import { requestCalendarSync } from "./calendar_sync/queue.js";
import { notifyEventCancellation } from "./event_cancel.js";
import { pushEventChanged } from "./apns.js";
import { newEventUid, newInvitationToken } from "./ids.js";
import { expandEvent } from "./rrule_expand.js";
import { expansionTimeZone, rawIcsStartIsUtc } from "./event_zone.js";

export type WeeklyAvailability = Record<string, [string, string][] | null>;
export type Slot = { startsAt: Date; endsAt: Date };

/** 预约失败的原因码。路由拿 code 去查文案 —— 原来这里直接抛中文字符串，
 *  而路由把 err.message 原样贴给访客，于是德语 / 日语访客看到的是中文。 */
export class BookingError extends Error {
  constructor(public readonly code: "slotTaken" | "slotUnavailable") {
    super(code);
    this.name = "BookingError";
  }
}

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
export async function availableSlots(link: schema.BookingLink, fromUtc: Date, daysWindow: number, query: Pick<DB, "select"> = db): Promise<Slot[]> {
  const slotMinutes = link.durationMinutes;
  if (!Number.isInteger(slotMinutes) || slotMinutes <= 0 || slotMinutes > 1440 || !Number.isFinite(fromUtc.getTime())) return [];
  daysWindow = Math.min(Math.max(0, Math.floor(daysWindow)), 90);
  const bufferAfterMin = link.bufferAfterMin || 0;
  const bufferBeforeMin = link.bufferBeforeMin || 0;
  const minNoticeMs = (link.minNoticeHours || 0) * 60 * 60 * 1000;
  const earliestStart = new Date(fromUtc.getTime() + minNoticeMs);
  const endWindow = new Date(fromUtc.getTime() + daysWindow * 24 * 60 * 60 * 1000);

  // Pull all candidate slots from the weekly availability matrix.
  const availability = (link.weeklyAvailability as WeeklyAvailability) || DEFAULT_AVAILABILITY;
  const candidates: Slot[] = [];
  for (let i = 0; i < daysWindow; i++) {
    const day = new Date(fromUtc.getTime() + 8 * 60 * 60_000);
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
  candidates.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const uniqueCandidates = candidates.filter((slot, index) => index === 0 || slot.startsAt.getTime() !== candidates[index - 1]!.startsAt.getTime());
  if (uniqueCandidates.length === 0) return [];

  // Subtract existing events in the owner's calendar that overlap (including
  // a buffer cushion before and after each candidate).
  const calId = link.calendarId;
  const windowFrom = new Date(uniqueCandidates[0]!.startsAt.getTime() - bufferBeforeMin * 60_000);
  const windowTo = new Date(uniqueCandidates[uniqueCandidates.length - 1]!.endsAt.getTime() + bufferAfterMin * 60_000);
  const conflicts: { startsAt: Date; endsAt: Date }[] = await query
    .select({ startsAt: schema.events.startsAt, endsAt: schema.events.endsAt })
    .from(schema.events)
    .where(and(
      eq(schema.events.calendarId, calId),
      gte(schema.events.endsAt, windowFrom),
      lte(schema.events.startsAt, windowTo),
      isNull(schema.events.deletedAt),
      // 重复事件交给下面展开（主事件那一次也在展开结果里，而且展开会扣掉删掉的那几次）。
      or(isNull(schema.events.rrule), eq(schema.events.rrule, "")),
    ));
  // 重复事件：以前只认主事件自己那一次（每周例会只挡住了第一周）。
  // 把窗口里的每一次都展开出来，按日历上画出来的那一批时刻（同一个时区口径）算忙。
  conflicts.push(...await recurringBusy(calId, windowFrom, windowTo, query));

  return uniqueCandidates.filter((slot) => {
    const startWithBuffer = new Date(slot.startsAt.getTime() - bufferBeforeMin * 60_000);
    const endWithBuffer = new Date(slot.endsAt.getTime() + bufferAfterMin * 60_000);
    return !conflicts.some((c) => c.endsAt > startWithBuffer && c.startsAt < endWithBuffer);
  });
}

async function recurringBusy(calendarId: string, from: Date, to: Date, query: Pick<DB, "select">): Promise<Slot[]> {
  const [cal] = await query
    .select({ timezone: schema.calendars.timezone })
    .from(schema.calendars)
    .where(eq(schema.calendars.id, calendarId))
    .limit(1);
  const masters = await query
    .select({
      id: schema.events.id, startsAt: schema.events.startsAt, endsAt: schema.events.endsAt,
      allDay: schema.events.allDay, rrule: schema.events.rrule, exdates: schema.events.exdates,
      extra: schema.events.extra, rawIcs: schema.events.rawIcs,
    })
    .from(schema.events)
    .where(and(
      eq(schema.events.calendarId, calendarId),
      isNotNull(schema.events.rrule),
      lte(schema.events.startsAt, to),
      isNull(schema.events.deletedAt),
    ));
  const out: Slot[] = [];
  for (const m of masters) {
    if (!m.rrule) continue;   // 空串：不是重复事件，上面那条查询已经算过它
    for (const occ of expandEvent({
      id: m.id, startsAt: m.startsAt, endsAt: m.endsAt, rrule: m.rrule,
      exdates: Array.isArray(m.exdates) ? (m.exdates as string[]) : null,
      allDay: m.allDay,
      timeZone: expansionTimeZone({
        allDay: m.allDay, extra: m.extra, calendarTimezone: cal?.timezone,
        rawStartIsUtc: rawIcsStartIsUtc(m.rawIcs),
      }),
    }, from, to)) {
      out.push({ startsAt: occ.startsAt, endsAt: occ.endsAt });
    }
  }
  return out;
}

export async function findLinkBySlug(userId: string, slug: string): Promise<schema.BookingLink | null> {
  const [row] = await db.select().from(schema.bookingLinks).where(and(eq(schema.bookingLinks.userId, userId), eq(schema.bookingLinks.slug, slug))).limit(1);
  return row ?? null;
}

export type CreatedBooking = {
  booking: schema.Booking;
  event: schema.Event;
};

// Serialize reservations for one calendar across all booking links. The slot
// rules and recurring-event conflicts are rechecked after acquiring the row
// lock, so a waiting request observes the preceding committed reservation.
export async function bookSlot(input: {
  link: schema.BookingLink;
  startsAt: Date;
  endsAt: Date;
  guestEmail: string;
  guestName: string;
  guestMessage?: string;
}): Promise<CreatedBooking> {
  const created = await db.transaction(async (tx) => {
    const [calendar] = await tx.select({ ownerId: schema.calendars.ownerId })
      .from(schema.calendars).where(eq(schema.calendars.id, input.link.calendarId)).for("update");
    const [link] = await tx.select().from(schema.bookingLinks)
      .where(eq(schema.bookingLinks.id, input.link.id)).for("update");
    if (!calendar || !link || !link.enabled || link.calendarId !== input.link.calendarId ||
        link.userId !== calendar.ownerId) throw new BookingError("slotUnavailable");
    const [owner] = await tx.select({ disabledAt: schema.users.disabledAt }).from(schema.users)
      .where(eq(schema.users.id, link.userId));
    if (!owner || owner.disabledAt) throw new BookingError("slotUnavailable");
    const bookable = await availableSlots(link, new Date(), link.maxDaysAhead, tx);
    if (!bookable.some((slot) => slot.startsAt.getTime() === input.startsAt.getTime() &&
        slot.endsAt.getTime() === input.endsAt.getTime())) throw new BookingError("slotUnavailable");

    const [event] = await tx.insert(schema.events).values({
      calendarId: link.calendarId,
      uid: newEventUid(),
      summary: `${link.title} — ${input.guestName}`,
      description: input.guestMessage || null,
      location: null,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      allDay: false,
      rrule: null,
      extra: {
        attendees: [input.guestEmail],
        bookingLinkId: link.id,
        guestName: input.guestName,
      },
    }).returning();
    if (!event) throw new Error("事件创建失败");

    const [booking] = await tx.insert(schema.bookings).values({
      linkId: link.id,
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
  });
  await requestCalendarSync(created.event.calendarId).catch(() => undefined);
  void pushEventChanged(input.link.userId, created.event.id, "event.created").catch(() => undefined);
  return created;
}

/** Commit the booking and event cancellation together; notifications run afterwards. */
export async function cancelBooking(token: string): Promise<{ found: boolean; alreadyCancelled: boolean }> {
  const result = await db.transaction(async (tx) => {
    const [booking] = await tx.select().from(schema.bookings)
      .where(eq(schema.bookings.cancelToken, token)).for("update");
    if (!booking) return { found: false, alreadyCancelled: false };

    const now = new Date();
    const [event] = booking.eventId ? await tx.update(schema.events)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(schema.events.id, booking.eventId), isNull(schema.events.deletedAt))).returning() : [];
    if (!booking.cancelledAt) await tx.update(schema.bookings).set({ cancelledAt: now }).where(eq(schema.bookings.id, booking.id));
    const [owner] = event ? await tx.select({ id: schema.users.id, email: schema.users.email, displayName: schema.users.displayName })
      .from(schema.users).innerJoin(schema.calendars, eq(schema.calendars.ownerId, schema.users.id))
      .where(eq(schema.calendars.id, event.calendarId)) : [];
    return { found: true, alreadyCancelled: !!booking.cancelledAt, event, owner };
  });
  if (result.event) {
    await requestCalendarSync(result.event.calendarId).catch(() => undefined);
    if (result.owner) await notifyEventCancellation(result.event, result.owner).catch(() => undefined);
  }
  return { found: result.found, alreadyCancelled: result.alreadyCancelled };
}
