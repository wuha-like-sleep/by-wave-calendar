// 「所有事件」保存时，主事件要改成什么样。
//
// 各端的编辑框显示的都是**点开的那一次**，保存时把那一次的时刻当 startsAt 发上来。直接写进主事件
// 的话，系列就变成从那一次才开始：从 11 月 16 日点进去只改个标题，之前的几次全没了。
//
//   · 带了 recurrenceId（是哪一次，网页和 iOS、安卓都带）：改动量 = 新时刻 − 那一次，
//     主事件、以前删掉的那几次、UNTIL 一起平移。
//   · 没带（老版桌面端、自己调接口的）：发来的时刻正好是系列里的一次 → 时间没改，主事件不动；
//     否则照发来的存（改的就是主事件）。
//   · 规则真的换了、全天和定时互换：整个系列重新定义，照发来的存。
//
// 平移按**墙上时间**算：把 9 月 28 日 09:00 拖到 10 月 5 日 09:00（中间进了夏令时），真实时刻差
// 6 天 23 小时，但用户要的是「时间不变、往后一周」。全天事件存的是 UTC 午夜，按整天算。
//
// 规则里写死的东西挪不了，也不能假装挪了：
//   · 日子写死（每月第一个周一、每月 15 号、指定月份、隔周多天……）：日子不动，只平移钟点。
//     DTSTART 往后挪一天，日子还是规则那些日子，排在它前面的那次却没了。
//   · 钟点写死（BYHOUR / BYMINUTE / BYSECOND）：开始时间不动。
// 最坏的结果是「拖到别的日子，系列没跟过去」，不会丢任何一次。
//
// 纯函数，只依赖 rrule_expand / zoned_time。

import { seriesStartsBetween } from "./rrule_expand.js";
import { fromWallClock, toWallClock } from "./zoned_time.js";

const DAY_MS = 86_400_000;

export type SeriesEditInput = {
  master: { startsAt: Date; endsAt: Date; rrule: string | null; allDay: boolean; exdates: unknown };
  /** 这次编辑之前展开用的时区（expansionTimeZone） */
  zone: string;
  sent: { startsAt?: string; endsAt?: string; rrule?: string; allDay?: boolean };
  recurrenceId?: string;
  /**
   * 打开编辑框时主事件的开始时刻。平移不是幂等的：网页的发送队列超时会重发，两个标签页也可能
   * 各发一遍，09:30 → 10:30 → 11:30。主事件已经不是这个时刻 = 这次改动已经生效过了，不再平移。
   */
  seriesBase?: string;
};

export type SeriesEditPlan = { startsAt?: Date; endsAt?: Date; rrule?: string; exdates?: string[] };

/** 规则是不是同一条。桌面端会把规则拆开重建：去掉 INTERVAL=1、把 UNTIL 改成当天 23:59:59。 */
export function sameRule(a: string, b: string): boolean {
  const norm = (r: string) => r.toUpperCase().split(";").map((p) => p.trim()).filter((p) => p && p !== "INTERVAL=1")
    .map((p) => (p.startsWith("UNTIL=") ? p.slice(0, 14) : p)).sort().join(";");
  return norm(a) === norm(b);
}

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** 规则的键 → 值。 */
function ruleParts(rule: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of rule.split(";")) {
    const at = raw.indexOf("=");
    if (at > 0) out.set(raw.slice(0, at).trim().toUpperCase(), raw.slice(at + 1).trim().toUpperCase());
  }
  return out;
}

/** 日子写死在规则里，挪 DTSTART 也换不了日子。 */
function daysLockedByRule(p: Map<string, string>): boolean {
  if (["BYMONTHDAY", "BYYEARDAY", "BYWEEKNO", "BYEASTER", "BYMONTH", "BYSETPOS"].some((k) => p.has(k))) return true;
  const byday = p.get("BYDAY");
  if (byday == null) return false;
  if (p.get("FREQ") !== "WEEKLY") return true;
  const days = byday.split(",").map((d) => d.trim());
  if (days.some((d) => !WEEKDAYS.includes(d))) return true;   // 「第一个周一」往后一天不是「第一个周二」
  // 隔周多天：转过 WKST 的那几天会落到另一组周，算不清就不动。
  const interval = Number(p.get("INTERVAL") ?? 1);
  return interval > 1 && days.length > 1;
}

const timeLockedByRule = (p: Map<string, string>) => ["BYHOUR", "BYMINUTE", "BYSECOND"].some((k) => p.has(k));

/** 规则跟着平移：BYDAY 转 dayShift 天，UNTIL 平移同样的量。 */
function shiftRule(rule: string, dayShift: number, shift: (t: number) => number, floatingDelta: number): string {
  return rule.split(";").map((raw) => {
    const at = raw.indexOf("=");
    if (at <= 0) return raw;
    const key = raw.slice(0, at).trim().toUpperCase();
    const value = raw.slice(at + 1).trim();
    if (key === "UNTIL") {
      const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/i.exec(value);
      if (!m) return raw;
      const t = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
      const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
      if (m[4] == null) return "UNTIL=" + stamp(t + dayShift * DAY_MS).slice(0, 8);   // 只有日期（全天系列）
      if (!m[7]) return "UNTIL=" + stamp(t + floatingDelta);                          // 浮动写法，本身就是墙上时间
      return "UNTIL=" + stamp(shift(t)) + "Z";
    }
    if (key === "BYDAY" && dayShift !== 0) {
      const rotated = value.split(",").map((d) => WEEKDAYS[(WEEKDAYS.indexOf(d.trim().toUpperCase()) + ((dayShift % 7) + 7)) % 7]);
      return "BYDAY=" + rotated.join(",");
    }
    return raw;
  }).join(";");
}

/** null = 照发来的存。 */
export function planSeriesEdit(input: SeriesEditInput): SeriesEditPlan | null {
  const { master, zone, sent } = input;
  if (!master.rrule) return null;
  // 这次改动已经生效过了（重发）：别的字段照写，时间和规则不再动。要排在比较规则前面：第一次把
  // 「每周一」转成了「每周二」的话，重发带的还是旧规则，会被当成换了规则，把一切写回去。
  if (input.seriesBase && new Date(input.seriesBase).getTime() !== master.startsAt.getTime()) {
    return { startsAt: master.startsAt, endsAt: master.endsAt, rrule: master.rrule };
  }
  if (sent.rrule != null && !sameRule(sent.rrule, master.rrule)) return null;
  if (sent.allDay != null && sent.allDay !== master.allDay) return null;
  const rule = master.rrule;   // 规则没真的变：留库里那份，不用客户端重建的
  const masterStart = master.startsAt.getTime();
  const masterDuration = master.endsAt.getTime() - masterStart;
  const ref = input.recurrenceId ? new Date(input.recurrenceId).getTime() : null;

  if (!sent.startsAt) {
    // 拉伸：只发了结束时刻。那是点开那一次的结束，主事件要的是时长。
    if (sent.endsAt && ref != null) {
      return { endsAt: new Date(masterStart + (new Date(sent.endsAt).getTime() - ref)), rrule: rule };
    }
    return null;
  }

  const sentStart = new Date(sent.startsAt).getTime();
  const duration = sent.endsAt ? new Date(sent.endsAt).getTime() - sentStart : masterDuration;
  const keepStart = (): SeriesEditPlan => ({ startsAt: master.startsAt, endsAt: new Date(masterStart + duration), rrule: rule });

  if (ref == null) {
    if (sentStart === masterStart) return null;
    const at = new Date(sentStart);
    const hit = seriesStartsBetween({ startsAt: master.startsAt, rrule: rule, allDay: master.allDay, timeZone: zone }, at, at);
    return hit?.some((d) => d.getTime() === sentStart) ? keepStart() : null;
  }

  const parts = ruleParts(rule);
  const daysLocked = daysLockedByRule(parts);
  let dayShift: number;
  let wallDelta = 0;
  let shift: (t: number) => number;
  if (master.allDay) {
    // 全天事件存的是 UTC 午夜。真的挪动至少差一天（跨夏令时 23 或 25 小时）；老页面发来的
    // recurrenceId 是本地午夜，差值只有一个时区偏移（最多 14 小时），不算挪动。
    const delta = sentStart - ref;
    dayShift = Math.abs(delta) < 15 * 3_600_000 ? 0 : Math.round(delta / DAY_MS);
    if (dayShift === 0 || daysLocked) return keepStart();
    const days = dayShift;
    shift = (t) => t + days * DAY_MS;
  } else {
    if (timeLockedByRule(parts)) return keepStart();
    const wallFrom = toWallClock(new Date(ref), zone).getTime();
    const wallTo = toWallClock(new Date(sentStart), zone).getTime();
    dayShift = Math.floor(wallTo / DAY_MS) - Math.floor(wallFrom / DAY_MS);
    wallDelta = wallTo - wallFrom;
    if (daysLocked) {
      wallDelta -= dayShift * DAY_MS;
      dayShift = 0;
    }
    if (wallDelta === 0) return keepStart();
    const delta = wallDelta;
    shift = (t) => fromWallClock(toWallClock(new Date(t), zone).getTime() + delta, zone).getTime();
  }

  const newStart = shift(masterStart);
  const plan: SeriesEditPlan = {
    startsAt: new Date(newStart),
    endsAt: new Date(newStart + duration),
    rrule: shiftRule(rule, dayShift, shift, wallDelta),
  };
  if (Array.isArray(master.exdates)) {
    plan.exdates = master.exdates.map((x) => {
      const t = +new Date(x as string);
      return Number.isNaN(t) ? (x as string) : new Date(shift(t)).toISOString();
    });
  }
  return plan;
}
