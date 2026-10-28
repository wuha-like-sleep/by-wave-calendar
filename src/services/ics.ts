import type { Calendar, Event } from "../db/schema.js";
import { env } from "../env.js";
import { serializePublishedCalendar, type IcalEvent } from "../lib/ical.js";
import { exportTimeZone, rawIcsStartIsUtc } from "../lib/event_zone.js";

/**
 * 订阅链接（/ics/:token）和「导出 .ics」的正文。
 *
 * 和 CalDAV 走同一个序列化：重复事件的 DTSTART 带 TZID（没有自己时区的用日历时区），
 * EXDATE 跟着写出去，全天事件按日期写。手机系统日历订阅这个链接后展开出来的日子，
 * 和网页上看到的是同一批。
 *
 * 公开链接：只给标题、时间、地点、备注、重复规则 —— 参与者邮箱、组织者、提醒一律不带
 * （以前的 ical-generator 版本也不带，这里保持一样）。
 */
export function buildIcsFeed(calendar: Calendar, events: Event[]): string {
  const items: IcalEvent[] = events.map((ev) => ({
    uid: ev.uid,
    summary: ev.summary,
    description: ev.description,
    location: ev.location,
    startsAt: ev.startsAt,
    endsAt: ev.endsAt,
    allDay: ev.allDay,
    rrule: ev.rrule,
    exdates: ev.rrule && Array.isArray(ev.exdates) ? (ev.exdates as string[]) : null,
    timezone: exportTimeZone({
      allDay: ev.allDay, extra: ev.extra, calendarTimezone: calendar.timezone, rrule: ev.rrule,
      // 手机写上来时 DTSTART 就是 UTC 的，服务端按 UTC 展开（见 event_zone.ts），这里也按 UTC 写。
      rawStartIsUtc: rawIcsStartIsUtc(ev.rawIcs),
    }),
    createdAt: ev.createdAt,
    updatedAt: ev.updatedAt,
  }));
  return serializePublishedCalendar(
    {
      name: calendar.name,
      description: calendar.description,
      timezone: calendar.timezone,
      url: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/cal/${calendar.id}`,
    },
    items,
  );
}
