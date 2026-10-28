// 墙上时间 ⇄ 真实时刻的换算，按 IANA 时区。
//
// 「墙上时间」= 那个地方的人看钟读到的数（2026-10-05 09:30）；「真实时刻」= 一个
// UTC 瞬间。重复事件必须在墙上时间里展开：「每周一 9:30」说的是墨尔本人看到的周一、
// 看到的 9:30，夏令时切换前后对应的 UTC 时刻差一小时，周几也可能和 UTC 的周几不同。
//
// 这里用一个约定俗成的表示法：把墙上读数的年月日时分秒当成 UTC 分量塞进一个 Date
// （下文叫「浮动时间」）。rrule 库在没有 TZID 时就是这样工作的，它只做民用历法的
// 加减，不碰时区。
//
// 两个边角按 RFC 5545 §3.3.5 的口径处理：
//   · 夏令时跳过去的那段（墨尔本 10 月第一个周日 02:00–03:00 不存在）：
//     按切换前的偏移换算，结果自然往后顺延（02:30 → 03:30）。
//   · 夏令时拨回来、重复出现的那段（4 月第一个周日 02:00–03:00 出现两次）：
//     取第一次。
//
// 只依赖 Intl，不 import env / db —— scripts/migrate.ts 也要用它，那边没有完整的环境变量。

const formatterCache = new Map<string, Intl.DateTimeFormat | null>();
const FORMATTER_CACHE_LIMIT = 512;

function formatterFor(tz: string): Intl.DateTimeFormat | null {
  const hit = formatterCache.get(tz);
  if (hit !== undefined) return hit;
  let fmt: Intl.DateTimeFormat | null;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric",
      // 锁死 h23：hour12:false 在某些 ICU 组合下会落到 h24，午夜读成 "24"，
      // 算出来的偏移整整差一天，而且只在午夜那一刻错。
      hourCycle: "h23",
    });
  } catch {
    fmt = null;
  }
  // 库里的时区串是用户 / 第三方客户端写的，理论上可以有任意多种；缓存不设上限
  // 就是一个能被灌满的 Map。满了整个清掉，代价只是重建几个 formatter。
  if (formatterCache.size >= FORMATTER_CACHE_LIMIT) formatterCache.clear();
  formatterCache.set(tz, fmt);
  return fmt;
}

/**
 * 规范成 IANA 的「地区/城市」名（或 UTC）。认不出、或者规范完还不是这种形状的返回 null。
 *   · 别名先按 Intl 规范：PRC → Asia/Shanghai、US/Eastern → America/New_York、GMT → UTC。
 *     不规范的话这些名字会被当成非法、退回日历时区，而手机照着它们排，两边对不上。
 *   · "+08:00" 这类偏移写法规范完还是它自己：不收。它会原样写进导出的 TZID，手机和别的
 *     日历软件不认识，按 UTC 或本机时间去解释。
 */
export function canonicalTimeZone(tz: unknown): string | null {
  if (typeof tz !== "string") return null;
  const t = tz.trim();
  if (!t || t !== tz) return null;
  const fmt = formatterFor(t);
  if (!fmt) return null;
  const name = fmt.resolvedOptions().timeZone;
  if (name !== "UTC" && !/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)+$/.test(name)) return null;
  return name;
}

/** 规范得了（见 canonicalTimeZone）。空串、非字符串一律 false。用的时候拿规范后的名字。 */
export function isValidTimeZone(tz: unknown): tz is string {
  return canonicalTimeZone(tz) !== null;
}

const MS_HOUR = 60 * 60 * 1000;
const MS_DAY = 24 * MS_HOUR;

/** tz 在 utcMs 这一刻比 UTC 快多少毫秒（墨尔本夏令时 = +11h）。时区非法返回 null。 */
export function zoneOffsetMs(utcMs: number, tz: string): number | null {
  const fmt = formatterFor(tz);
  if (!fmt) return null;
  // Intl 只给到秒，毫秒部分先抹掉再比，否则偏移会带上 -ms 的零头。
  const wholeSecond = Math.floor(utcMs / 1000) * 1000;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = fmt.formatToParts(new Date(wholeSecond));
  } catch {
    return null;
  }
  let y = NaN, mo = NaN, d = NaN, h = NaN, mi = NaN, s = NaN;
  for (const p of parts) {
    switch (p.type) {
      case "year": y = Number(p.value); break;
      case "month": mo = Number(p.value); break;
      case "day": d = Number(p.value); break;
      case "hour": h = Number(p.value); break;
      case "minute": mi = Number(p.value); break;
      case "second": s = Number(p.value); break;
    }
  }
  if ([y, mo, d, h, mi, s].some((n) => Number.isNaN(n))) return null;
  if (h === 24) h = 0;
  return Date.UTC(y, mo - 1, d, h, mi, s) - wholeSecond;
}

/** 真实时刻 → 该时区的墙上时间（浮动表示：墙上读数当 UTC 分量）。时区非法时原样返回（= 按 UTC）。 */
export function toWallClock(instant: Date, tz: string): Date {
  const off = zoneOffsetMs(instant.getTime(), tz);
  return new Date(instant.getTime() + (off ?? 0));
}

/**
 * 墙上时间（浮动表示）→ 真实时刻。
 * 不存在的时刻（夏令时跳过的那段）往后顺延；重复出现的时刻取第一次。
 * 时区非法时按 UTC 解释。
 */
export function fromWallClock(wall: Date | number, tz: string): Date {
  const L = typeof wall === "number" ? wall : wall.getTime();
  // 墙上时间对应的真实时刻落在 L-14h … L+14h 之间；前后各取一天的偏移，
  // 就拿到了这一段里可能出现的全部偏移（夏令时一年才切两次）。
  const before = zoneOffsetMs(L - MS_DAY, tz);
  const after = zoneOffsetMs(L + MS_DAY, tz);
  if (before === null || after === null) return new Date(L);
  const candidates: number[] = [];
  for (const off of before === after ? [before] : [before, after]) {
    const t = L - off;
    if (zoneOffsetMs(t, tz) === off) candidates.push(t);
  }
  if (candidates.length > 0) return new Date(Math.min(...candidates));
  // 两个偏移都对不上 = 这个墙上时间不存在（夏令时跳过的那一段）。
  // 按切换**前**的偏移换算：02:30 + 10h 偏移 → 落在切换之后，读出来是 03:30。
  return new Date(L - before);
}

function pad(n: number, w = 2): string { return String(n).padStart(w, "0"); }

/** 真实时刻在该时区的墙上读数，写成 iCalendar 的 YYYYMMDDTHHMMSS（不带 Z）。 */
export function formatWallClockStamp(instant: Date, tz: string): string {
  const w = toWallClock(instant, tz);
  return `${pad(w.getUTCFullYear(), 4)}${pad(w.getUTCMonth() + 1)}${pad(w.getUTCDate())}`
    + `T${pad(w.getUTCHours())}${pad(w.getUTCMinutes())}${pad(w.getUTCSeconds())}`;
}
