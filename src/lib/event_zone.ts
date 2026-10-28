// 一个事件「按哪个时区展开重复规则、按哪个时区导出」。所有展开 RRULE 的地方
// （日历接口、提醒、预约忙闲、数据迁移）和 CalDAV / 订阅导出都问这一个函数，
// 口径只有一份。
//
// 顺序：
//   1. 全天事件 → UTC。全天存的是「那一天的 UTC 午夜」（日期，不是时刻），
//      按 UTC 展开出来的还是那些日期，换任何时区都会错一天。
//   2. 手机通过 CalDAV 写上来的原文里 DTSTART 明确写成 UTC（…Z、没有 TZID）：
//      UTC。那份原文会原样回放给手机，手机照 RFC 5545 按 UTC 展开；服务端要是
//      换成别的时区，两边就对不上了。排在 extra.timezone 前面：原文只在最后一次写入
//      来自 CalDAV 时才有（网页 / App 一编辑就清掉），而 CalDAV PUT 只在带 TZID 时才
//      覆盖 extra.timezone —— 网页建的事件被手机用 UTC 写法存回来，extra.timezone
//      还是旧值，原文才是手机手上那一份。
//   3. extra.timezone（事件自己的时区：网页 / App 编辑框里那一栏，
//      CalDAV 客户端 DTSTART;TZID=… 带上来的，.ics 导入 / 订阅时源文件里的 TZID）。
//   4. 日历的时区（calendars.timezone）。
//   5. 都没有、或者不是合法的 IANA 时区名 → UTC。
//
// 只依赖 zoned_time，不 import env / db：scripts/migrate.ts 也要用它。

import { isValidTimeZone } from "./zoned_time.js";

/**
 * 原文 VEVENT 的 DTSTART 是不是写成了 UTC 时刻。
 * JS 和 SQL（提醒扫描只取这一个布尔，不把整份原文搬回来）共用这一个正则源。
 * `(^|\n)` 让它只认行首的 DTSTART，不会被 DESCRIPTION 里的同名字样骗到。
 */
export const RAW_START_IS_UTC_PATTERN = "(^|\\n)DTSTART(;VALUE=DATE-TIME)?:[0-9]{8}T[0-9]{6}Z";
const RAW_START_IS_UTC_RE = new RegExp(RAW_START_IS_UTC_PATTERN, "i");

export function rawIcsStartIsUtc(rawIcs: string | null | undefined): boolean {
  if (!rawIcs || !rawIcs.includes("BEGIN:VEVENT")) return false;
  return RAW_START_IS_UTC_RE.test(rawIcs);
}

export type EventZoneInputs = {
  allDay: boolean;
  /** events.extra（jsonb，形状不可信） */
  extra: unknown;
  /** calendars.timezone */
  calendarTimezone: string | null | undefined;
  /** 原文 DTSTART 是 UTC 写法。有原文的路径用 rawIcsStartIsUtc() 算，提醒扫描在 SQL 里算。 */
  rawStartIsUtc?: boolean;
};

/** extra.timezone，合法才算数。 */
export function extraTimeZoneOf(extra: unknown): string | null {
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return null;
  const tz = (extra as { timezone?: unknown }).timezone;
  if (typeof tz !== "string") return null;
  const t = tz.trim();
  return isValidTimeZone(t) ? t : null;
}

/** 展开重复规则用的时区。永远返回一个合法的时区名（兜底 "UTC"）。 */
export function expansionTimeZone(e: EventZoneInputs): string {
  if (e.allDay) return "UTC";
  if (e.rawStartIsUtc) return "UTC";
  const own = extraTimeZoneOf(e.extra);
  if (own) return own;
  const cal = typeof e.calendarTimezone === "string" ? e.calendarTimezone.trim() : "";
  if (cal && isValidTimeZone(cal)) return cal;
  return "UTC";
}

/**
 * 把一个重复事件抄进**另一个**日历（收到邀请后「加到我的日历」）时，副本要钉上的时区。
 * 原事件没有自己的时区时，展开用的是原日历的时区；副本换了日历，不钉的话会改用收件人
 * 日历的时区展开，「每周一」可能变成别的日子。null = 不需要钉（不重复 / 全天 / 本来就有）。
 */
export function timeZoneToPinOnCopy(e: EventZoneInputs & { rrule: string | null | undefined }): string | null {
  if (e.allDay || !e.rrule) return null;
  // 原文是 UTC 写法时，展开按 UTC、不看 extra.timezone；副本没有原文，要把 UTC 钉上。
  if (!e.rawStartIsUtc && extraTimeZoneOf(e.extra)) return null;
  return expansionTimeZone(e);
}

/**
 * 合成 VEVENT（网页 / App 建的事件，没有原文可回放）导出时 DTSTART 带哪个 TZID。
 * null = 写成 UTC（…Z）。
 *   · 全天：null（DTSTART;VALUE=DATE，不需要时区）。
 *   · 原文 DTSTART 是 UTC：null（和展开同一个口径）。
 *   · 有合法的 extra.timezone：一律带上（以前就是这样）；UTC 写成 …Z。
 *   · 重复事件：带上展开用的那个时区，手机照着它展开，才和服务端算出同一批日子。
 *   · 不重复、也没有自己的时区：null。单个时刻写成 UTC 是精确的，不会有歧义。
 */
export function exportTimeZone(e: EventZoneInputs & { rrule: string | null | undefined }): string | null {
  if (e.allDay || e.rawStartIsUtc) return null;
  const own = extraTimeZoneOf(e.extra);
  if (own) return own === "UTC" ? null : own;
  if (!e.rrule) return null;
  const tz = expansionTimeZone(e);
  return tz === "UTC" ? null : tz;
}
