// Bounded RRULE expansion. Without this, /api/events returns only the
// master row for recurring events and the in-app calendar grid renders
// daily/weekly meetings as a single occurrence at the original startsAt.
//
// We use the well-tested `rrule` library rather than rolling our own —
// RFC 5545 has too many edge cases (BYDAY with negative offsets, MONTHLY
// with BYSETPOS, leap-day YEARLY) to hand-roll without subtle bugs.
//
// ── 按事件自己的时区展开 ──────────────────────────────────────────────
//
// 以前这里把 DTSTART 写成 UTC（DTSTART:…Z）交给 rrule 库，于是 BYDAY / BYMONTHDAY /
// BYHOUR 全按 UTC 的日历去算：
//   · 墨尔本周一 9:30 = UTC 周日 22:30，「每周一」按 UTC 的周一算，落到了墨尔本的周二；
//   · 北京早上 8 点前、纽约晚上 7 点后同理，错一天；
//   · 不带 BY* 的「每周」按固定的 UTC 间隔走，夏令时一切换，墙上时间整体挪一小时。
// 现在：把 DTSTART 换成该时区的墙上时间、当浮动时间交给 rrule（rrule 只做民用历法的
// 加减），每个结果再按该时区换回真实时刻。时区怎么定见 event_zone.ts。
// 全天事件的时区永远是 UTC（存的是 UTC 午夜的日期），走的还是原来那条路，一个字节不变。

// rrule v2.x ships only a CommonJS build with a fake-ESM shim that doesn't
// expose named exports correctly in Node's strict ESM mode. Native named
// imports throw at module load:
//   SyntaxError: Named export 'rrulestr' not found.
// Workaround: default-import the whole module and destructure. The default
// export is the CJS module.exports object. We also pull the *type* RRule
// in via a type-only named import — TS strips type-only imports at
// runtime, so this doesn't trigger the CJS-named-export crash.
import rrulePkg from "rrule";
import type { RRule as RRuleType, Options as RRuleOptions } from "rrule";
import { fromWallClock, isValidTimeZone, toWallClock } from "./zoned_time.js";
const { RRule, rrulestr } = rrulePkg as unknown as {
  RRule: typeof RRuleType;
  rrulestr: (s: string) => RRuleType;
};

// Soft cap on how many occurrences we'll emit per event in one expansion.
// Prevents a malicious or malformed RRULE (e.g. FREQ=SECONDLY) from
// blowing up the JSON payload. Reasonable for a UI that paints a month
// at a time.
export const MAX_OCCURRENCES_PER_EVENT = 366;

export type EventForExpansion = {
  id: string;
  startsAt: Date;
  endsAt: Date;
  rrule: string | null;
  // Optional exclusion list of ISO timestamps. When the user deletes
  // "just this occurrence" of a recurring event we append the instance
  // start here; expandEvent skips those occurrences.
  exdates?: string[] | null;
  /** 全天事件一律按 UTC 展开（不管 timeZone 传的是什么）。 */
  allDay: boolean;
  /**
   * 按哪个时区展开，调用方用 event_zone.ts 的 expansionTimeZone() 算好传进来。
   * 必填：漏传就是回到「按 UTC 展开」的老毛病，所以让类型检查替我们盯着每个调用点。
   * null / 非法时区名 → UTC。
   */
  timeZone: string | null;
};

export type ExpandedOccurrence = {
  // The master event's id stays the same for every occurrence — the client
  // distinguishes them by startsAt. This matches how Google Calendar / Toast
  // UI Calendar render recurring instances.
  id: string;
  startsAt: Date;
  endsAt: Date;
  isOccurrence: boolean;  // true for non-first occurrences
};

/** 用 UTC 的 DTSTART 解析 RRULE。解析不了抛错（调用方兜底成只显示主事件）。 */
function parseRuleUtc(startsAt: Date, rrule: string): RRuleType {
  // The DB stores just the RRULE: line (e.g. "FREQ=WEEKLY;BYDAY=MO"),
  // so prefix it with DTSTART before parsing. rrulestr accepts both
  // forms but DTSTART is needed for it to anchor occurrences.
  const dtstartUtc = startsAt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return rrulestr(`DTSTART:${dtstartUtc}\nRRULE:${rrule}`);
}

/** 展开要用的时区：全天 / 没传 / 非法 → null（= 按 UTC，走原来那条路）。 */
function zoneFor(event: Pick<EventForExpansion, "allDay" | "timeZone">): string | null {
  if (event.allDay) return null;
  const tz = event.timeZone;
  if (!tz || tz === "UTC" || !isValidTimeZone(tz)) return null;
  return tz;
}

type WallRule = {
  rule: RRuleType;
  wallStart: Date;
  /** 第一次的真实时刻（抹掉毫秒，和 UTC 那条路一样） */
  realStart: Date;
  /** UNTIL 的真实时刻；没有 UNTIL 是 +Infinity */
  untilMs: number;
};

/**
 * 同一条规则换到墙上时间里：DTSTART、UNTIL 都换成该时区的墙上读数。
 * DTSTART 抹掉毫秒：UTC 那条路（parseRuleUtc）也是抹掉的，手机写回来的 EXDATE 只到秒，
 * 留着毫秒的话每一次都带 .123，手机上删掉的那次在这边删不掉。
 * UNTIL 在库里是一个真实时刻（…Z）。墙上读数的先后和真实时刻的先后在夏令时拨回的那一小时里
 * 对不上，所以墙上的 UNTIL 放宽几个小时让 rrule 多给几次，再按真实时刻筛（untilMs）。
 * 拿不到单条 RRule（比如字符串里塞了好几条规则）返回 null，调用方退回 UTC 展开。
 */
function toWallClockRule(utcRule: RRuleType, startsAt: Date, tz: string): WallRule | null {
  if (!(utcRule instanceof RRule)) return null;
  const orig = (utcRule as unknown as { origOptions: Partial<RRuleOptions> }).origOptions;
  if (!orig) return null;
  const realStart = new Date(Math.floor(startsAt.getTime() / 1000) * 1000);
  const wallStart = toWallClock(realStart, tz);
  const options: Partial<RRuleOptions> = { ...orig, dtstart: wallStart, tzid: null };
  let untilMs = Infinity;
  if (orig.until) {
    untilMs = orig.until.getTime();
    options.until = new Date(toWallClock(orig.until, tz).getTime() + WALL_WINDOW_SLACK_MS);
  }
  return { rule: new RRule(options), wallStart, realStart, untilMs };
}

// ── 跳到窗口附近再开始数 ──────────────────────────────────────────────
//
// rrule 库从 DTSTART 一次一次往后数，数到窗口才开始给结果。2020 年开始的「每天」看一个月的
// 窗口要数两千多次（3.6ms），一屏几十个这样的事件就是一百多毫秒，而网页每 30 秒、提醒每分钟
// 都要算一遍；FREQ=MINUTELY 看一周要数三百多万次（4.8 秒），期间整个进程不响应别的请求，
// 而任何登录用户都能建这种事件。
//
// 把 DTSTART 往后挪「整数个周期」，结果集在窗口里完全不变：间隔的相位、没写 BYDAY 时取的
// 星期几、没写 BYHOUR 时取的时分秒都不变（挪的是整数个周期，浮动时间里也没有夏令时）。
// 只有这几种不能挪：
//   · 带 COUNT：「总共 10 次」要从第一次数起，挪了就多算。COUNT 本身也限住了要数多少次。
//   · MONTHLY / YEARLY：月份长度不一，31 号开始的「每月」不能简单加周期。它们一年才数 12 次，不需要。
//   · MINUTELY 带 BYHOUR、SECONDLY 带 BYHOUR / BYMINUTE：rrule 库跳过不匹配的小时时不推进
//     分钟的相位，结果取决于从头数的路径（「每 45 分钟，只在 9、10 点」跳了就少一次）。
//     这几种从头数也只数匹配的那几个小时，慢不到上面那个程度。
// 挪到窗口前至少一个完整周期，所以被跳过的全都早于窗口（WEEKLY 的第一个周期会被新 DTSTART
// 截掉一部分，那部分也在窗口之前）。test/rrule_fast_forward.test.ts 拿没挪的结果逐条对照。
const FAST_FORWARD_PERIOD_MS: Partial<Record<number, number>> = {
  [RRule.WEEKLY]: 7 * 86_400_000,
  [RRule.DAILY]: 86_400_000,
  [RRule.HOURLY]: 3_600_000,
  [RRule.MINUTELY]: 60_000,
  [RRule.SECONDLY]: 1_000,
};

let fastForwardEnabled = true;
/** 只给对照测试用：关掉跳跃，拿到「老老实实从头数」的结果。 */
export function __setFastForwardForTest(on: boolean): void { fastForwardEnabled = on; }

// ── 数不完的规则不交给 rrule 库 ──────────────────────────────────────────
//
// rrule 库的小时 / 分钟 / 秒级循环是 `for (;;)`，直到碰上匹配的才出来。「每 2 小时，只在 1 点」
// 而第一次在偶数点：永远碰不上，**死循环**，整个进程卡死，而且不会自己恢复（进程还活着，
// pm2 也不重启）。日期上不可能的条件（2 月 30 日）不会死循环，但要一路数到 9999 年，「每天」
// 每次 3 秒多。rrule 字符串是用户写的（API 收任意字符串）、也是订阅源写的，这不能靠「没人这么写」。
// 这些规则排不出任何一次，或者是实际不会有人用的写法，一律只显示主事件（和规则写坏了同样处理）。
const MAX_STEPS_BEFORE_WINDOW = 50_000;
const WEEK_MS = 7 * 86_400_000;
const MONTH_MAX_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const numbers = (v: unknown): number[] =>
  (Array.isArray(v) ? v : v == null ? [] : [v]).filter((x): x is number => typeof x === "number");
const countOf = (v: unknown): number => (Array.isArray(v) ? v.length : v == null ? 0 : 1);
const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** 从 start 开始每次加 interval（模 modulo），碰得到 values 里的某一个吗。 */
function canReach(values: number[], modulo: number, start: number, interval: number): boolean {
  const g = gcd(interval, modulo);
  return values.some((v) => v >= 0 && v < modulo && ((v - start) % g + g) % g === 0);
}
const anyInRange = (values: number[], modulo: number) => values.some((v) => v >= 0 && v < modulo);

/** 这条规则交给 rrule 库会不会数不完。 */
function neverFinishes(o: Partial<RRuleOptions>): boolean {
  const interval = o.interval ?? 1;
  if (!(interval >= 1)) return true;   // 负的间隔往回数，年份永远到不了上限

  // 日期上不可能的条件
  const months = numbers(o.bymonth).filter((m) => m >= 1 && m <= 12);
  if (countOf(o.bymonth) > 0 && months.length === 0) return true;
  const monthDays = numbers(o.bymonthday);
  if (countOf(o.bymonthday) > 0) {
    const fits = (m: number) => monthDays.some((d) => d !== 0 && Math.abs(d) <= MONTH_MAX_DAYS[m - 1]!);
    if (!(months.length ? months : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).some(fits)) return true;
  }
  // RFC 5545：这几个只对 YEARLY 有意义，和别的条件一交就可能永远对不上。
  if (o.freq !== RRule.YEARLY && (countOf(o.byyearday) || countOf(o.byweekno) || o.byeaster != null)) return true;
  // RFC 5545 同样不允许每周规则带 BYMONTHDAY，正常客户端写不出来，要数到 9999 年时每次约 2 秒。
  if (o.freq === RRule.WEEKLY && countOf(o.bymonthday)) return true;

  const hours = numbers(o.byhour);
  const minutes = numbers(o.byminute);
  const seconds = numbers(o.bysecond);

  const setpos = numbers(o.bysetpos);
  if (setpos.length) {
    if (o.freq! > RRule.DAILY) return true;
    const perDay = Math.max(hours.length, 1) * Math.max(minutes.length, 1) * Math.max(seconds.length, 1);
    if (o.freq === RRule.DAILY && setpos.every((p) => p === 0 || Math.abs(p) > perDay)) return true;
    if (o.freq === RRule.WEEKLY && setpos.every((p) => p === 0 || Math.abs(p) > Math.max(countOf(o.byweekday), 1) * perDay)) return true;
  }

  // 「每月第 6 个周一」：没有这一天。数到 9999 年每次约 1 秒。
  if (o.freq === RRule.MONTHLY && countOf(o.byweekday)) {
    const ordinals = (Array.isArray(o.byweekday) ? o.byweekday : [o.byweekday]).map((d) => (d as { n?: number } | null)?.n);
    if (ordinals.every((n) => typeof n === "number" && Math.abs(n) > 5)) return true;
  }

  // 间隔是 7 天的整数倍，星期几就永远不变：「每 168 小时，只在周二」而第一次在周一。
  const period = FAST_FORWARD_PERIOD_MS[o.freq!];
  if (period && o.freq !== RRule.WEEKLY && (period * interval) % WEEK_MS === 0 && countOf(o.byweekday)) {
    const startDay = (o.dtstart!.getUTCDay() + 6) % 7;   // rrule 的 weekday：周一 = 0
    const days = (Array.isArray(o.byweekday) ? o.byweekday : [o.byweekday]).map((d) => (typeof d === "number" ? d : (d as { weekday?: number } | null)?.weekday));
    if (!days.includes(startDay)) return true;
  }

  // 小时级以下的 for (;;)：指定的时分秒碰不上就出不来。
  const start = o.dtstart!;
  // 日期条件没对上时，rrule 库一次跳到当天末尾，内层加小时 / 分钟的步长就不再是 1，碰不到目标
  // 时分，同样死循环（「每分钟，只在周一 9 点」而第一次在周二 10 点）。这几种组合算不清，不算。
  const dateFilter = countOf(o.bymonth) || countOf(o.bymonthday) || countOf(o.byweekday);
  if (dateFilter) {
    if (o.freq === RRule.HOURLY && countOf(o.byhour) && interval > 1) return true;
    if (o.freq === RRule.MINUTELY && countOf(o.byhour)) return true;
    if (o.freq === RRule.SECONDLY && (countOf(o.byhour) || countOf(o.byminute))) return true;
  }
  if (o.freq === RRule.HOURLY) {
    if (countOf(o.byhour) && !canReach(hours, 24, start.getUTCHours(), interval)) return true;
  } else if (o.freq === RRule.MINUTELY) {
    if (countOf(o.byminute) && !canReach(minutes, 60, start.getUTCMinutes(), interval)) return true;
    // 间隔超过一小时时，进位是一次跳好几个小时，碰不碰得上取决于路径，算不清就不算。
    if (countOf(o.byhour) && (interval >= 60 || !anyInRange(hours, 24))) return true;
  } else if (o.freq === RRule.SECONDLY) {
    if (countOf(o.bysecond) && !canReach(seconds, 60, start.getUTCSeconds(), interval)) return true;
    if ((countOf(o.byhour) || countOf(o.byminute)) && interval >= 60) return true;
    if (countOf(o.byhour) && !anyInRange(hours, 24)) return true;
    if (countOf(o.byminute) && !anyInRange(minutes, 60)) return true;
  }
  return false;
}

/**
 * 真正交给 rrule 库的规则：数不完的返回 null，能跳的跳到 windowFrom 之前至少一个周期。
 * 不能跳（COUNT、结果取决于路径）的只能从头数，要数太多次也不数。
 */
function prepareRule(rule: RRuleType, windowFrom: Date): RRuleType | null {
  // 一个字符串里塞了好几条规则 / RDATE（只有直接调接口才写得出来），逐条判断不划算。
  if (!(rule instanceof RRule)) return null;
  const orig = (rule as unknown as { origOptions: Partial<RRuleOptions> }).origOptions;
  if (!orig?.dtstart || orig.freq == null || neverFinishes(orig)) return null;
  const period = FAST_FORWARD_PERIOD_MS[orig.freq];
  if (!period) return rule;   // MONTHLY / YEARLY：一年才数 12 次
  const step = period * (orig.interval ?? 1);
  const behind = Math.floor((windowFrom.getTime() - orig.dtstart.getTime()) / step);
  const pathDependent = (orig.freq === RRule.MINUTELY && countOf(orig.byhour) > 0)
    || (orig.freq === RRule.SECONDLY && (countOf(orig.byhour) > 0 || countOf(orig.byminute) > 0));
  if (orig.count != null || pathDependent) {
    return Math.min(orig.count ?? Infinity, behind) > MAX_STEPS_BEFORE_WINDOW ? null : rule;
  }
  if (!fastForwardEnabled || behind - 1 < 1) return rule;
  return new RRule({ ...orig, dtstart: new Date(orig.dtstart.getTime() + (behind - 1) * step) });
}

// Given an event with optional RRULE and a [from, to] window, return all
// occurrence start/end pairs that overlap the window. For non-recurring
// events this is just the single (startsAt, endsAt) pair (filtered to the
// window). For recurring events, expansion is bounded by:
//   - the rrule's own COUNT / UNTIL
//   - MAX_OCCURRENCES_PER_EVENT
//   - the requested [from, to] window
export function expandEvent(event: EventForExpansion, from: Date, to: Date): ExpandedOccurrence[] {
  const durationMs = event.endsAt.getTime() - event.startsAt.getTime();

  if (!event.rrule) {
    // Non-recurring: keep only if it actually overlaps the window. The DB
    // query that loaded this event has already filtered by the window for
    // master rows, but we double-check here so the helper is safe to call
    // standalone.
    if (event.endsAt < from || event.startsAt > to) return [];
    return [{ id: event.id, startsAt: event.startsAt, endsAt: event.endsAt, isOccurrence: false }];
  }

  let utcRule: RRuleType;
  try {
    utcRule = parseRuleUtc(event.startsAt, event.rrule);
  } catch {
    // Malformed RRULE — fall back to just the master. Better to show
    // something than to crash the whole calendar grid.
    if (event.endsAt < from || event.startsAt > to) return [];
    return [{ id: event.id, startsAt: event.startsAt, endsAt: event.endsAt, isOccurrence: false }];
  }

  // rrule.between expects inclusive=true for the boundary instants. We pull
  // occurrences whose START is in [from - duration, to] so events that
  // START before `from` but END after `from` still get included.
  const expandFrom = new Date(from.getTime() - Math.max(0, durationMs));

  const tz = zoneFor(event);
  const wall = tz ? toWallClockRule(utcRule, event.startsAt, tz) : null;
  const starts = wall && tz
    ? zonedStartsBetween(wall, tz, expandFrom, to)
    : utcStartsBetween(utcRule, expandFrom, to);
  if (!starts) {
    // 这条规则数不完（见 neverFinishes）：和规则写坏了一样，只显示主事件。
    if (event.endsAt < from || event.startsAt > to) return [];
    return [{ id: event.id, startsAt: event.startsAt, endsAt: event.endsAt, isOccurrence: false }];
  }

  // Build a Set of exdate timestamps (ms) for fast lookup. The
  // exdates array on the event is stored as ISO strings; we normalize
  // to ms here so a TZ-formatted vs naive-formatted exdate still
  // compares equal to the computed instance start (always a real instant).
  const exdateSet = exdateMillis(event.exdates);

  const masterStartTime = event.startsAt.getTime();
  return starts.filter((s: Date) => !exdateSet.has(s.getTime())).map((start: Date) => {
    const startMs = start.getTime();
    return {
      id: event.id,
      startsAt: start,
      endsAt: new Date(startMs + durationMs),
      isOccurrence: startMs !== masterStartTime,
    };
  });
}

export function exdateMillis(exdates: readonly string[] | null | undefined): Set<number> {
  const set = new Set<number>();
  if (Array.isArray(exdates)) {
    for (const e of exdates) {
      const t = +new Date(e);
      if (!isNaN(t)) set.add(t);
    }
  }
  return set;
}

// 浮动窗口比真实窗口两头各宽这么多。真实时刻 t 的墙上读数 = t + 偏移(t)，窗口里的
// 偏移和两端的偏移最多差一个夏令时的跨度（一般 1 小时，历史上的「双夏令时」2 小时）。
const WALL_WINDOW_SLACK_MS = 3 * 60 * 60 * 1000;

// Pass an iterator that HALTS at the cap. Plain `.between(...).slice(N)`
// would first MATERIALIZE every in-window occurrence — a pathological
// RRULE (e.g. FREQ=SECONDLY over a month) is millions of Date objects and
// a CPU/memory spike before the slice ever runs. The API accepts arbitrary
// rrule strings, and the reminders cron re-expands every event every
// minute over a 30-day window, so this is a real DoS surface. The iterator
// returns false once we've collected the cap, stopping generation early.
function utcStartsBetween(rule: RRuleType, from: Date, to: Date, cap = MAX_OCCURRENCES_PER_EVENT): Date[] | null {
  const prepared = prepareRule(rule, from);
  return prepared && prepared.between(from, to, true, (_d: Date, i: number) => i < cap);
}

/** 窗口外（两头的余量里）最多回调这么多次就放弃。FREQ=SECONDLY 的余量是几万次，正常规则几次。 */
const OUT_OF_WINDOW_CALL_LIMIT = 50_000;

/**
 * 在墙上时间里展开、换回真实时刻、只留 [from, to] 里的。
 * 上限照旧：窗口内收满 MAX_OCCURRENCES_PER_EVENT 条就停。两头余量里的回调单独计数、
 * 不占这个额度 —— 占的话，密集规则（FREQ=SECONDLY）光余量就把额度用光，返回 0 次，
 * 事件整个从日历和提醒里消失；UTC 那条路是 366 次。
 */
function zonedStartsBetween(wall: WallRule, tz: string, from: Date, to: Date, cap = MAX_OCCURRENCES_PER_EVENT): Date[] | null {
  const offFrom = toWallClock(from, tz).getTime() - from.getTime();
  const offTo = toWallClock(to, tz).getTime() - to.getTime();
  const wallFrom = new Date(from.getTime() + Math.min(offFrom, offTo) - WALL_WINDOW_SLACK_MS);
  const wallTo = new Date(to.getTime() + Math.max(offFrom, offTo) + WALL_WINDOW_SLACK_MS);
  const out: Date[] = [];
  const seen = new Set<number>();
  let outside = 0;
  const prepared = prepareRule(wall.rule, wallFrom);
  if (!prepared) return null;
  prepared.between(wallFrom, wallTo, true, (d: Date) => {
    const real = wallToReal(d, wall, tz);
    const ms = real.getTime();
    // 夏令时跳过的那段会被顺延，可能和下一次撞在同一个时刻上：只留一个。
    if (ms >= from.getTime() && ms <= to.getTime() && ms <= wall.untilMs) {
      if (!seen.has(ms)) {
        seen.add(ms);
        out.push(real);
      }
    } else {
      outside++;
    }
    return out.length < cap && outside < OUT_OF_WINDOW_CALL_LIMIT;
  });
  return out.sort((a, b) => a.getTime() - b.getTime());
}

/** 浮动的一次 → 真实时刻。第一次就是主事件本身，直接用库里那个时刻（落在拨回重叠段的第二遍时不被改成第一遍）。 */
function wallToReal(d: Date, wall: WallRule, tz: string): Date {
  if (d.getTime() === wall.wallStart.getTime()) return new Date(wall.realStart.getTime());
  return fromWallClock(d, tz);
}

// ---------------------------------------------------------------------------
// 不扣 exdates、只看规则本身：[from, to] 里有哪几次。给「换了展开时区，以前删掉的那几次
// 要对到新的日子上」用（exdate_remap.ts）。和 expandEvent 是同一条路，口径只有一份。
// ---------------------------------------------------------------------------

/**
 * 解析不了返回 null。全天 / UTC 走原来那条路。
 * cap 默认和 expandEvent 一样；数据迁移一次要看很长一段，传大的，收满了自己判「数不完」。
 */
export function seriesStartsBetween(
  event: Pick<EventForExpansion, "startsAt" | "rrule" | "allDay" | "timeZone">, from: Date, to: Date,
  cap = MAX_OCCURRENCES_PER_EVENT,
): Date[] | null {
  if (!event.rrule) return null;
  let utcRule: RRuleType;
  try { utcRule = parseRuleUtc(event.startsAt, event.rrule); } catch { return null; }
  const tz = zoneFor(event);
  const wall = tz ? toWallClockRule(utcRule, event.startsAt, tz) : null;
  try {
    if (wall && tz) return zonedStartsBetween(wall, tz, from, to, cap);
    return utcStartsBetween(utcRule, from, to, cap);
  } catch {
    return null;
  }
}
