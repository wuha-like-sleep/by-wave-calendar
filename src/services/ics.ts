import type { Calendar, Event } from "../db/schema.js";
import { env } from "../env.js";
import { serializePublishedCalendar, type IcalEvent } from "../lib/ical.js";
import { exportTimeZone, rawIcsStartIsUtc } from "../lib/event_zone.js";
import { normalizeAlarms } from "../lib/reminder_triggers.js";
import type { AttendeeLike } from "../lib/attendees.js";

/**
 * 订阅链接（/ics/:token）和「导出 .ics」的正文。
 *
 * 和 CalDAV 走同一个序列化：重复事件的 DTSTART 带 TZID（没有自己时区的用日历时区），
 * EXDATE 跟着写出去，全天事件按日期写。手机系统日历订阅这个链接后展开出来的日子，
 * 和网页上看到的是同一批。
 *
 * 两种口径：
 *   · 默认（公开订阅链接）：只给标题、时间、地点、备注、重复规则 —— 参与者邮箱、
 *     组织者、提醒一律不带（拿到链接的任何人都不该看见这些）。
 *   · full（属主本人的一次性导出下载，API 与网页两个导出口）：导出就是备份，
 *     参与者 / 组织者 / 提醒 / 分类 / TRANSP / STATUS / 会议链接都带上，
 *     否则用户把 .ics 导去别的工具，半个事件就没了。鉴权在各自路由里
 *     （属主会话 / bearer），这里只管口径。
 */
export function buildIcsFeed(calendar: Calendar, events: Event[], opts: { full?: boolean } = {}): string {
  const full = opts.full === true;
  const items: IcalEvent[] = events.map((ev) => {
    const extra = (ev.extra ?? null) as null | {
      attendees?: unknown; organizer?: string | null; alarms?: unknown;
      transp?: string | null; status?: string | null; categories?: string[] | null;
      category?: string | null; url?: string | null;
    };
    return {
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
      ...(full ? {
        attendees: (extra?.attendees ?? null) as AttendeeLike[] | null,
        organizer: extra?.organizer ?? null,
        alarms: normalizeAlarms(extra?.alarms ?? []),
        transp: extra?.transp ?? null,
        status: extra?.status ?? null,
        // 与 CalDAV 合成路径同一口径：数组优先，网页的单值 category 兜底。
        categories: Array.isArray(extra?.categories) && extra.categories.length
          ? extra.categories
          : extra?.category ? [extra.category] : null,
        url: extra?.url ?? null,
      } : {}),
    };
  });
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
