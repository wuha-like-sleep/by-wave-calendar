import { and, eq, gte, lte, isNotNull, isNull, or } from "drizzle-orm";
import { db, schema, type DB } from "../db/client.js";
import { requestCalendarSync } from "./calendar_sync/queue.js";
import { notifyEventCancellation } from "./event_cancel.js";
import { createNotification } from "./notifications.js";
import { isValidLocale, translate, type LocaleCode } from "./i18n.js";
import { getSettings } from "./site_settings.js";
import { pushEventChanged } from "./apns.js";
import { newEventUid, newInvitationToken } from "./ids.js";
import { expandEvent } from "./rrule_expand.js";
import { expansionTimeZone, rawIcsStartIsUtc } from "./event_zone.js";
import { canonicalTimeZone, fromWallClock, toWallClock, zoneOffsetMs } from "./zoned_time.js";

export type WeeklyAvailability = Record<string, [string, string][] | null>;
export type Slot = { startsAt: Date; endsAt: Date };

/** Legacy calendars without a usable IANA zone retain their original schedule. */
export function bookingTimeZoneFromCalendar(timezone: unknown): string {
  return canonicalTimeZone(typeof timezone === "string" ? timezone.trim() : timezone) ?? "Asia/Shanghai";
}

export async function bookingTimeZone(link: Pick<schema.BookingLink, "calendarId">, query: Pick<DB, "select"> = db): Promise<string> {
  const [calendar] = await query.select({ timezone: schema.calendars.timezone }).from(schema.calendars)
    .where(eq(schema.calendars.id, link.calendarId)).limit(1);
  return bookingTimeZoneFromCalendar(calendar?.timezone);
}

// A DST gap has no real instant; a repeated wall-clock time can have two. Keep
// their UTC identities distinct instead of moving a nonexistent 02:30 to 03:30.
function wallClockInstants(wall: number, timezone: string, offsets: number[]): Date[] {
  return [...new Set(offsets.map(offset => wall - offset))]
    .filter(instant => toWallClock(new Date(instant), timezone).getTime() === wall)
    .sort((a, b) => a - b).map(instant => new Date(instant));
}

function slotWithinWallWindow(start: Date, end: Date, firstWall: number, lastWall: number, timezone: string): boolean {
  const within = (instant: number) => {
    const wall = toWallClock(new Date(instant), timezone).getTime();
    return wall >= firstWall && wall < lastWall;
  };
  // End is exclusive. At a clock rollback the instant immediately before
  // 01:00 can be 01:59, outside a range advertised as ending at 01:45.
  let left = start.getTime(), right = end.getTime() - 1;
  if (!within(left) || !within(right)) return false;
  const initialOffset = zoneOffsetMs(left, timezone);
  if (initialOffset === zoneOffsetMs(right, timezone)) return true;
  // Slots last at most one day, so they can cross one IANA offset transition.
  // Check both sides: valid endpoints alone can hide an unavailable interval
  // between the two folds of a short repeated-hour availability window.
  while (right - left > 1) {
    const middle = Math.floor((left + right) / 2);
    if (zoneOffsetMs(middle, timezone) === initialOffset) left = middle;
    else right = middle;
  }
  return within(left) && within(right);
}

// All-day storage contains floating civil dates at UTC midnight, not UTC
// instants. Query/expand in that date space, then convert both boundaries in
// the host calendar's zone; a DST day can be 23 or 25 real hours long.
function allDayWindow(from: Date, to: Date, timezone: string): { from: Date; to: Date } {
  const first = toWallClock(from, timezone), last = toWallClock(to, timezone);
  first.setUTCHours(0, 0, 0, 0);
  last.setUTCHours(24, 0, 0, 0);
  return { from: first, to: last };
}
function allDayBusy(slot: Slot, timezone: string): Slot {
  return { startsAt: fromWallClock(slot.startsAt, timezone), endsAt: fromWallClock(slot.endsAt, timezone) };
}

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
// Weekly availability is wall-clock time in the initiating calendar's zone;
// returned slots are absolute instants, independent of any visitor's device.
export async function availableSlots(link: schema.BookingLink, fromUtc: Date, daysWindow: number,
  query: Pick<DB, "select"> = db, resolvedTimezone?: string): Promise<Slot[]> {
  const slotMinutes = link.durationMinutes;
  if (!Number.isInteger(slotMinutes) || slotMinutes <= 0 || slotMinutes > 1440 || !Number.isFinite(fromUtc.getTime())) return [];
  daysWindow = Math.min(Math.max(0, Math.floor(daysWindow)), 90);
  const timezone = resolvedTimezone === undefined ? await bookingTimeZone(link, query) : bookingTimeZoneFromCalendar(resolvedTimezone);
  const bufferAfterMin = link.bufferAfterMin || 0;
  const bufferBeforeMin = link.bufferBeforeMin || 0;
  const minNoticeMs = (link.minNoticeHours || 0) * 60 * 60 * 1000;
  const earliestStart = new Date(fromUtc.getTime() + minNoticeMs);
  const firstDay = toWallClock(fromUtc, timezone);
  const endWindowWall = new Date(firstDay);
  endWindowWall.setUTCDate(endWindowWall.getUTCDate() + daysWindow);
  const endWindow = fromWallClock(endWindowWall, timezone);

  // Pull all candidate slots from the weekly availability matrix.
  const availability = (link.weeklyAvailability as WeeklyAvailability) || DEFAULT_AVAILABILITY;
  const candidates: Slot[] = [];
  for (let i = 0; i < daysWindow; i++) {
    const day = new Date(firstDay);
    day.setUTCDate(day.getUTCDate() + i);
    const midnight = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
    // The local day's real instants can extend into the following UTC day.
    // Sample beyond that whole interval, including zones west of UTC.
    const offsets = [...new Set([zoneOffsetMs(midnight - 86_400_000, timezone), zoneOffsetMs(midnight + 2 * 86_400_000, timezone)])]
      .filter((offset): offset is number => offset !== null);
    const dow = String(day.getUTCDay());
    const windows = availability[dow];
    if (!windows || windows.length === 0) continue;
    for (const [startStr, endStr] of windows) {
      const a = parseHM(startStr); const b = parseHM(endStr);
      if (!a || !b) continue;
      const cursorMin = a.h * 60 + a.m;
      const endMin = b.h * 60 + b.m;
      const availabilityStartWall = midnight + cursorMin * 60_000;
      const availabilityEndWall = midnight + endMin * 60_000;
      // A repeated closing time applies to both folds of the available range.
      // Use its final instant; the wall-clock check below still prevents slots
      // from extending beyond the advertised closing time in either fold.
      const availabilityEnds = wallClockInstants(availabilityEndWall, timezone, offsets);
      const availabilityEnd = availabilityEnds.at(-1) ?? fromWallClock(availabilityEndWall, timezone);
      for (let t = cursorMin; t < endMin; t += slotMinutes) {
        for (const startUtc of wallClockInstants(midnight + t * 60_000, timezone, offsets)) {
          const endUtc = new Date(startUtc.getTime() + slotMinutes * 60_000);
          if (startUtc < earliestStart || endUtc > endWindow || endUtc > availabilityEnd) continue;
          // A nonexistent closing time must not be shifted to a later clock
          // reading by the gap conversion (02:30 must not become 03:30).
          if (toWallClock(endUtc, timezone).getTime() > availabilityEndWall) continue;
          if (offsets.length > 1 && !slotWithinWallWindow(startUtc, endUtc, availabilityStartWall, availabilityEndWall, timezone)) continue;
          candidates.push({ startsAt: startUtc, endsAt: endUtc });
        }
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
  const floatingWindow = allDayWindow(windowFrom, windowTo, timezone);
  const rows = await query
    .select({ startsAt: schema.events.startsAt, endsAt: schema.events.endsAt, allDay: schema.events.allDay })
    .from(schema.events)
    .where(and(
      eq(schema.events.calendarId, calId),
      or(
        and(eq(schema.events.allDay, false), gte(schema.events.endsAt, windowFrom), lte(schema.events.startsAt, windowTo)),
        and(eq(schema.events.allDay, true), gte(schema.events.endsAt, floatingWindow.from), lte(schema.events.startsAt, floatingWindow.to)),
      ),
      isNull(schema.events.deletedAt),
      // 重复事件交给下面展开（主事件那一次也在展开结果里，而且展开会扣掉删掉的那几次）。
      or(isNull(schema.events.rrule), eq(schema.events.rrule, "")),
    ));
  const conflicts: Slot[] = rows.map(row => row.allDay ? allDayBusy(row, timezone) : row);
  // 重复事件：以前只认主事件自己那一次（每周例会只挡住了第一周）。
  // 把窗口里的每一次都展开出来，按日历上画出来的那一批时刻（同一个时区口径）算忙。
  conflicts.push(...await recurringBusy(calId, windowFrom, windowTo, query, timezone));

  return uniqueCandidates.filter((slot) => {
    const startWithBuffer = new Date(slot.startsAt.getTime() - bufferBeforeMin * 60_000);
    const endWithBuffer = new Date(slot.endsAt.getTime() + bufferAfterMin * 60_000);
    return !conflicts.some((c) => c.endsAt > startWithBuffer && c.startsAt < endWithBuffer);
  });
}

async function recurringBusy(calendarId: string, from: Date, to: Date, query: Pick<DB, "select">, timezone: string): Promise<Slot[]> {
  const floatingWindow = allDayWindow(from, to, timezone);
  const masters = await query
    .select({
      id: schema.events.id, startsAt: schema.events.startsAt, endsAt: schema.events.endsAt,
      allDay: schema.events.allDay, rrule: schema.events.rrule, exdates: schema.events.exdates,
      extra: schema.events.extra, rawIcs: schema.events.rawIcs, updatedAt: schema.events.updatedAt,
    })
    .from(schema.events)
    .where(and(
      eq(schema.events.calendarId, calendarId),
      isNotNull(schema.events.rrule),
      or(and(eq(schema.events.allDay, false), lte(schema.events.startsAt, to)),
        and(eq(schema.events.allDay, true), lte(schema.events.startsAt, floatingWindow.to))),
      isNull(schema.events.deletedAt),
    ));
  const out: Slot[] = [];
  for (const m of masters) {
    if (!m.rrule) continue;   // 空串：不是重复事件，上面那条查询已经算过它
    for (const occ of expandEvent({
      id: m.id, startsAt: m.startsAt, endsAt: m.endsAt, rrule: m.rrule,
      exdates: Array.isArray(m.exdates) ? (m.exdates as string[]) : null,
      allDay: m.allDay, updatedAt: m.updatedAt,
      timeZone: expansionTimeZone({
        allDay: m.allDay, extra: m.extra, calendarTimezone: timezone,
        rawStartIsUtc: rawIcsStartIsUtc(m.rawIcs),
      }),
    }, m.allDay ? floatingWindow.from : from, m.allDay ? floatingWindow.to : to)) {
      out.push(m.allDay ? allDayBusy(occ, timezone) : { startsAt: occ.startsAt, endsAt: occ.endsAt });
    }
  }
  return out;
}

export async function findLinkBySlug(userId: string, slug: string): Promise<schema.BookingLink | null> {
  const [row] = await db.select().from(schema.bookingLinks).where(and(eq(schema.bookingLinks.userId, userId), eq(schema.bookingLinks.slug, slug))).limit(1);
  return row ?? null;
}

/** Keep guests' cancellation links alive while their bookings are still active. */
export async function deleteBookingLink(id: string, userId: string): Promise<"deleted" | "not_found" | "active_bookings"> {
  return db.transaction(async (tx) => {
    // bookSlot locks this same row before inserting a booking, so a booking
    // cannot slip between the check and the cascading link deletion.
    const [link] = await tx.select({ id: schema.bookingLinks.id }).from(schema.bookingLinks)
      .where(and(eq(schema.bookingLinks.id, id), eq(schema.bookingLinks.userId, userId))).for("update");
    if (!link) return "not_found";
    const [active] = await tx.select({ id: schema.bookings.id }).from(schema.bookings)
      .where(and(eq(schema.bookings.linkId, id), isNull(schema.bookings.cancelledAt),
        gte(schema.bookings.endsAt, new Date()))).limit(1);
    if (active) return "active_bookings";
    await tx.delete(schema.bookingLinks).where(eq(schema.bookingLinks.id, id));
    return "deleted";
  });
}

export type CreatedBooking = {
  booking: schema.Booking;
  event: schema.Event;
  timeZone: string;
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
  /** Display preference for this guest's notices only; never a scheduling zone. */
  guestTimeZone?: string;
}): Promise<CreatedBooking> {
  const guestTimeZone = canonicalTimeZone(input.guestTimeZone);
  const created = await db.transaction(async (tx) => {
    const [calendar] = await tx.select({ ownerId: schema.calendars.ownerId, timezone: schema.calendars.timezone })
      .from(schema.calendars).where(eq(schema.calendars.id, input.link.calendarId)).for("update");
    const [link] = await tx.select().from(schema.bookingLinks)
      .where(eq(schema.bookingLinks.id, input.link.id)).for("update");
    if (!calendar || !link || !link.enabled || link.calendarId !== input.link.calendarId ||
        link.userId !== calendar.ownerId) throw new BookingError("slotUnavailable");
    const [owner] = await tx.select({ disabledAt: schema.users.disabledAt }).from(schema.users)
      .where(eq(schema.users.id, link.userId));
    if (!owner || owner.disabledAt) throw new BookingError("slotUnavailable");
    const timeZone = bookingTimeZoneFromCalendar(calendar.timezone);
    const bookable = await availableSlots(link, new Date(), link.maxDaysAhead, tx, timeZone);
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
        timezone: timeZone,
        ...(guestTimeZone ? { bookingGuestTimeZone: guestTimeZone } : {}),
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

    return { booking, event, timeZone };
  });
  await requestCalendarSync(created.event.calendarId).catch(() => undefined);
  void pushEventChanged(input.link.userId, created.event.id, "event.created").catch(() => undefined);
  // 站内通知：所有者通知邮件受 link.notifyEmail 控制，但站内这一条不受它
  // 管 —— 那个开关的语义是「别往我邮箱里塞」，站内收件箱正是关掉邮件后
  // 还能看见新预约的地方。写失败不影响预约本身（createNotification 不抛）。
  await notifyBookingCreated(input, created).catch(() => undefined);
  return created;
}

/** 给链接所有者写一条「新预约」站内通知。文字按所有者 locale 定稿，时间按日历时区。 */
async function notifyBookingCreated(
  input: { link: schema.BookingLink; guestName: string; guestEmail: string },
  created: CreatedBooking,
): Promise<void> {
  const [owner] = await db.select({ locale: schema.users.locale }).from(schema.users)
    .where(eq(schema.users.id, input.link.userId)).limit(1);
  const siteDefault = (await getSettings().catch(() => null))?.defaultLocale;
  const locale: LocaleCode = isValidLocale(owner?.locale) ? owner.locale : isValidLocale(siteDefault) ? siteDefault : "zh-CN";
  const when = new Intl.DateTimeFormat(locale, {
    timeZone: created.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(created.booking.startsAt);
  await createNotification({
    userId: input.link.userId,
    type: "booking_created",
    title: translate(locale, "notif.bookingCreated.title", { title: input.link.title }),
    body: translate(locale, "notif.bookingCreated.body", {
      guest: `${input.guestName} <${input.guestEmail}>`,
      when: `${when} (${created.timeZone})`,
    }),
    // 深链接直达这条预约生成的事件（日历应用会按参数打开它）。
    url: `/app?event=${created.event.id}&cal=${input.link.calendarId}`,
    // 有人约了你的时间 —— 值得推（收件人可在设置里关 notify_inbox_push）。
    push: { actionLabel: translate(locale, "notif.push.view") },
  });
}

/** 给链接所有者写一条「预约被取消」站内通知（访客走取消链接那条路）。 */
async function notifyBookingCancelled(ownerId: string, linkTitle: string, guestName: string, startsAt: Date, timeZone: string): Promise<void> {
  const [owner] = await db.select({ locale: schema.users.locale }).from(schema.users)
    .where(eq(schema.users.id, ownerId)).limit(1);
  const siteDefault = (await getSettings().catch(() => null))?.defaultLocale;
  const locale: LocaleCode = isValidLocale(owner?.locale) ? owner.locale : isValidLocale(siteDefault) ? siteDefault : "zh-CN";
  const when = new Intl.DateTimeFormat(locale, {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(startsAt);
  await createNotification({
    userId: ownerId,
    type: "booking_cancelled",
    title: translate(locale, "notif.bookingCancelled.title", { title: linkTitle }),
    body: translate(locale, "notif.bookingCancelled.body", {
      guest: guestName,
      when: `${when} (${timeZone})`,
    }),
    // 事件已经删了，深链接指过去只会扑空；落到预约管理页。
    url: "/app/booking-links",
    push: { actionLabel: translate(locale, "notif.push.view") },
  });
}

/** Commit the booking and event cancellation together; notifications run afterwards. */
export async function cancelBooking(token: string): Promise<{ found: boolean; alreadyCancelled: boolean }> {
  const result = await db.transaction(async (tx) => {
    const [candidate] = await tx.select({ eventId: schema.bookings.eventId }).from(schema.bookings)
      .where(eq(schema.bookings.cancelToken, token)).limit(1);
    if (!candidate) return { found: false, alreadyCancelled: false };
    // All cancellation entry points lock event before booking. Reversing this
    // order here can deadlock against an owner/Outlook event deletion.
    if (candidate.eventId) await tx.select({ id: schema.events.id }).from(schema.events)
      .where(eq(schema.events.id, candidate.eventId)).for("update");
    const [booking] = await tx.select().from(schema.bookings)
      .where(eq(schema.bookings.cancelToken, token)).for("update");
    if (!booking) return { found: false, alreadyCancelled: false };
    if (booking.eventId && booking.eventId !== candidate.eventId) throw new Error("booking_event_changed");

    const now = new Date();
    const [event] = booking.eventId ? await tx.update(schema.events)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(schema.events.id, booking.eventId), isNull(schema.events.deletedAt))).returning() : [];
    if (!booking.cancelledAt) await tx.update(schema.bookings).set({ cancelledAt: now }).where(eq(schema.bookings.id, booking.id));
    const [owner] = event ? await tx.select({ id: schema.users.id, email: schema.users.email, displayName: schema.users.displayName })
      .from(schema.users).innerJoin(schema.calendars, eq(schema.calendars.ownerId, schema.users.id))
      .where(eq(schema.calendars.id, event.calendarId)) : [];
    return { found: true, alreadyCancelled: !!booking.cancelledAt, event, owner, booking };
  });
  if (result.event) {
    await requestCalendarSync(result.event.calendarId).catch(() => undefined);
    if (result.owner) await notifyEventCancellation(result.event, result.owner).catch(() => undefined);
    // 站内通知给所有者：访客取消预约目前只有一封取消邮件能告诉他，邮件
    // 没到（SMTP 未配/被拦）就只能等他自己翻日历才发现。result.event 非空
    // 意味着这次调用真的删掉了事件，重复取消不会重复写。
    if (result.owner && result.booking) {
      const [link] = await db.select({ title: schema.bookingLinks.title }).from(schema.bookingLinks)
        .where(eq(schema.bookingLinks.id, result.booking.linkId)).limit(1);
      const tz = await bookingTimeZone({ calendarId: result.event.calendarId }).catch(() => "UTC");
      await notifyBookingCancelled(result.owner.id, link?.title ?? result.event.summary, result.booking.guestName, result.booking.startsAt, tz).catch(() => undefined);
    }
  }
  return { found: result.found, alreadyCancelled: result.alreadyCancelled };
}
