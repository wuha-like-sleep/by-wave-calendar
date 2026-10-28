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
    // Pass an iterator that HALTS at the cap. Plain `.between(...).slice(N)`
    // would first MATERIALIZE every in-window occurrence — a pathological
    // RRULE (e.g. FREQ=SECONDLY over a month) is millions of Date objects and
    // a CPU/memory spike before the slice ever runs. The API accepts arbitrary
    // rrule strings, and the reminders cron re-expands every event every
    // minute over a 30-day window, so this is a real DoS surface. The iterator
    // returns false once we've collected the cap, stopping generation early.
    : utcRule.between(expandFrom, to, true, (_d: Date, i: number) => i < MAX_OCCURRENCES_PER_EVENT);

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

/** 窗口外（两头的余量里）最多回调这么多次就放弃。FREQ=SECONDLY 的余量是几万次，正常规则几次。 */
const OUT_OF_WINDOW_CALL_LIMIT = 50_000;

/**
 * 在墙上时间里展开、换回真实时刻、只留 [from, to] 里的。
 * 上限照旧：窗口内收满 MAX_OCCURRENCES_PER_EVENT 条就停。两头余量里的回调单独计数、
 * 不占这个额度 —— 占的话，密集规则（FREQ=SECONDLY）光余量就把额度用光，返回 0 次，
 * 事件整个从日历和提醒里消失；UTC 那条路是 366 次。
 */
function zonedStartsBetween(wall: WallRule, tz: string, from: Date, to: Date): Date[] {
  const offFrom = toWallClock(from, tz).getTime() - from.getTime();
  const offTo = toWallClock(to, tz).getTime() - to.getTime();
  const wallFrom = new Date(from.getTime() + Math.min(offFrom, offTo) - WALL_WINDOW_SLACK_MS);
  const wallTo = new Date(to.getTime() + Math.max(offFrom, offTo) + WALL_WINDOW_SLACK_MS);
  const out: Date[] = [];
  const seen = new Set<number>();
  let outside = 0;
  wall.rule.between(wallFrom, wallTo, true, (d: Date) => {
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
    return out.length < MAX_OCCURRENCES_PER_EVENT && outside < OUT_OF_WINDOW_CALL_LIMIT;
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

/** 解析不了返回 null。全天 / UTC 走原来那条路。 */
export function seriesStartsBetween(
  event: Pick<EventForExpansion, "startsAt" | "rrule" | "allDay" | "timeZone">, from: Date, to: Date,
): Date[] | null {
  if (!event.rrule) return null;
  let utcRule: RRuleType;
  try { utcRule = parseRuleUtc(event.startsAt, event.rrule); } catch { return null; }
  const tz = zoneFor(event);
  const wall = tz ? toWallClockRule(utcRule, event.startsAt, tz) : null;
  try {
    if (wall && tz) return zonedStartsBetween(wall, tz, from, to);
    return utcRule.between(from, to, true, (_d: Date, i: number) => i < MAX_OCCURRENCES_PER_EVENT);
  } catch {
    return null;
  }
}
