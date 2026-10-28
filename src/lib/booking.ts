import { and, eq, gte, lte, isNotNull, isNull, or } from "drizzle-orm";
import { db, schema } from "../db/client.js";
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
  const windowFrom = candidates[0]!.startsAt;
  const windowTo = candidates[candidates.length - 1]!.endsAt;
  const conflicts: { startsAt: Date; endsAt: Date }[] = await db
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
  conflicts.push(...await recurringBusy(calId, windowFrom, windowTo));

  return candidates.filter((slot) => {
    const startWithBuffer = new Date(slot.startsAt.getTime() - bufferBeforeMin * 60_000);
    const endWithBuffer = new Date(slot.endsAt.getTime() + bufferAfterMin * 60_000);
    return !conflicts.some((c) => c.endsAt > startWithBuffer && c.startsAt < endWithBuffer);
  });
}

async function recurringBusy(calendarId: string, from: Date, to: Date): Promise<Slot[]> {
  const [cal] = await db
    .select({ timezone: schema.calendars.timezone })
    .from(schema.calendars)
    .where(eq(schema.calendars.id, calendarId))
    .limit(1);
  const masters = await db
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

// Atomic booking: SELECT-then-INSERT inside a single transaction so two
// guests racing for the same slot can't both insert. Postgres default
// READ COMMITTED gives us the visibility we need for the overlap check
// to actually see the other transaction's INSERT once it commits — the
// SELECT here runs at the start of *this* tx, so if the other tx commits
// first our INSERT will see it and we throw; if we commit first the
// other tx will see ours.
//
// (For true serialization under heavier load, escalate to a SERIALIZABLE
// isolation tx + retry-on-conflict, or add a PG exclusion constraint
// on (calendar_id, tsrange(starts_at, ends_at)). For the current scale
// the in-tx re-check is sufficient.)
export async function bookSlot(input: {
  link: schema.BookingLink;
  startsAt: Date;
  endsAt: Date;
  guestEmail: string;
  guestName: string;
  guestMessage?: string;
}): Promise<CreatedBooking> {
  // **请求体里的 startsAt 必须真的是一个可约时段。**
  //
  // 原来这里只查「有没有和已有事件撞上」，于是任何人都能往店主日历里写任意
  // 时间的事件：凌晨三点、周日、去年、五年以后都行 —— 只要那个时刻恰好没排东西。
  // 页面上根本不会显示这些时段，但那张表单是公开的，谁都可以自己拼一个 POST。
  // CSRF 挡不住：访客本来就能打开页面拿到 token，它防的是跨站，不是越权。
  //
  // 判据直接问 availableSlots —— 也就是页面用来画可选时段的那一个函数。
  // 不另写一份「合法性校验」：两份判据迟早会各走各的，而那种偏差没人看得见。
  // 它一并覆盖了可用时间窗、时长对齐、最短预约提前量、可约天数上限，
  // 以及前后缓冲（缓冲是下面那个 conflicts 查询没有的）。
  const now = new Date();
  const bookable = await availableSlots(input.link, now, input.link.maxDaysAhead);
  const wanted = input.startsAt.getTime();
  if (!bookable.some((s) => s.startsAt.getTime() === wanted)) {
    throw new BookingError("slotUnavailable");
  }

  return await db.transaction(async (tx) => {
    // 上面那一步是按「刚才那一瞬间」算的；这里再查一次是为了守住并发窗口
    // ——两个人同时点同一个时段。
    const conflicts = await tx
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
      throw new BookingError("slotTaken");
    }

    const [event] = await tx.insert(schema.events).values({
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

    const [booking] = await tx.insert(schema.bookings).values({
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
  });
}
