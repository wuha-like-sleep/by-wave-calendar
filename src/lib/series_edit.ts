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

/** 整条规则往后挪 dayShift 天 / UNTIL 平移。规则带这些日期条件时返回 null 表示日子没法跟着挪。 */
function shiftRule(rule: string, dayShift: number, shift: (t: number) => number): string | null {
  const parts = rule.split(";");
  let movable = true;
  const out = parts.map((raw) => {
    const p = raw.trim();
    const [key, value] = [p.slice(0, p.indexOf("=")).toUpperCase(), p.slice(p.indexOf("=") + 1)];
    if (key === "UNTIL") {
      const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/i.exec(value);
      if (!m) return raw;
      const t = shift(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!));
      return "UNTIL=" + new Date(t).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    }
    if (dayShift === 0) return raw;
    if (key === "BYDAY") {
      const days = value.split(",");
      // 「每月第一个周一」这种挪不了：往后一天不是「第一个周二」。
      if (days.some((d) => !WEEKDAYS.includes(d.trim().toUpperCase()))) { movable = false; return raw; }
      const rotated = days.map((d) => WEEKDAYS[(WEEKDAYS.indexOf(d.trim().toUpperCase()) + ((dayShift % 7) + 7)) % 7]);
      return "BYDAY=" + rotated.join(",");
    }
    if (key === "BYMONTHDAY" || key === "BYYEARDAY" || key === "BYWEEKNO" || key === "BYEASTER") movable = false;
    return raw;
  });
  return movable ? out.join(";") : null;
}

/** null = 照发来的存。 */
export function planSeriesEdit(input: SeriesEditInput): SeriesEditPlan | null {
  const { master, zone, sent } = input;
  if (!master.rrule) return null;
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

  // 这次改动已经生效过了（重发）：别的字段照写，时间不再动。
  if (input.seriesBase && new Date(input.seriesBase).getTime() !== masterStart) {
    return { startsAt: master.startsAt, endsAt: master.endsAt, rrule: rule };
  }

  let shift: (t: number) => number;
  let dayShift: number;
  if (master.allDay) {
    // 全天事件存的是 UTC 午夜。老页面发来的 recurrenceId 是本地午夜，差值里混着时区偏移，
    // 不取整的话主事件每存一次漂一个偏移；跨夏令时差值是 47 小时，也要算成 2 天。
    dayShift = Math.round((sentStart - ref) / DAY_MS);
    if (dayShift === 0) return keepStart();
    shift = (t) => t + dayShift * DAY_MS;
  } else {
    const wallFrom = toWallClock(new Date(ref), zone).getTime();
    const wallTo = toWallClock(new Date(sentStart), zone).getTime();
    const wallDelta = wallTo - wallFrom;
    if (wallDelta === 0) return keepStart();
    dayShift = Math.floor(wallTo / DAY_MS) - Math.floor(wallFrom / DAY_MS);
    shift = (t) => fromWallClock(toWallClock(new Date(t), zone).getTime() + wallDelta, zone).getTime();
  }

  const newStart = shift(masterStart);
  const plan: SeriesEditPlan = { startsAt: new Date(newStart), endsAt: new Date(newStart + duration) };
  const shiftedRule = shiftRule(rule, dayShift, shift);
  // 规则的日子挪不了（每月第一个周一）：改了 DTSTART 也还是那些日子，以前删掉的那几次不能动。
  plan.rrule = shiftedRule ?? rule;
  if (Array.isArray(master.exdates) && (shiftedRule != null || dayShift === 0)) {
    plan.exdates = master.exdates.map((x) => {
      const t = +new Date(x as string);
      return Number.isNaN(t) ? (x as string) : new Date(shift(t)).toISOString();
    });
  }
  return plan;
}
