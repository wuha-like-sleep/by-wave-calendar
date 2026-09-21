// 提醒取值 / 触发时刻的唯一事实源。
//
// 为什么要单独开一个模块：在这之前，「一条提醒到底什么时候响」这件事被拆在三处
// 各写各的 —— reminders.ts 里的 parseTriggerMs 只认 D/H/M，ical.ts 只把 TRIGGER 的
// value 抠出来（参数全丢），routes/events.ts 的 zod 把 trigger 当成 max(50) 的任意
// 字符串。三处口径对不上的后果不是报错，是「存进去了、API 返回 200、到点永远不响」，
// 以及「符号被 Math 吃掉，本该事后提醒的变成了提前提醒」。
// 从现在起网页、CalDAV、.ics 导入、三端 App、定时扫描器一律 import 这里。
//
// 两条最容易踩的语义，先写在最前面：
//
// 1) 定时事件的偏移是**绝对时长**（iCalendar 原义）：-PT1H 就是那个瞬间往前 3600 秒，
//    跨不跨夏令时都一样。
// 2) 全天事件的偏移是**墙上时间**：基准点是「事件所在时区当天 00:00」，PT9H 永远落在
//    当地 09:00，哪怕这一天正好是夏令时切换日（当天只有 23 小时）。
//    之前全天事件套用「提前 15 分钟」，中国用户会在前一天早上 07:45 收到提醒，
//    美西用户更早 —— 日期看着对、时间莫名其妙。锚定当天 00:00 就是为了修这个。

export type TriggerOption = {
  /** 存进 extra.alarms[].trigger 的原文，也是幂等键的一部分，不要随便改字面量 */
  value: string;
  /** 只给 key，不放中文：网页和三端共用同一批 key，翻译各自的 locale 文件里放 */
  i18nKey: string;
};

/** 定时事件的档位。负号 = 事件之前，空串 = 不提醒。 */
export const TIMED_TRIGGERS: readonly TriggerOption[] = [
  { value: "",        i18nKey: "app.reminder.none" },
  { value: "-PT0M",   i18nKey: "app.reminder.timed.atStart" },
  { value: "-PT5M",   i18nKey: "app.reminder.timed.min5" },
  { value: "-PT15M",  i18nKey: "app.reminder.timed.min15" },
  { value: "-PT30M",  i18nKey: "app.reminder.timed.min30" },
  { value: "-PT1H",   i18nKey: "app.reminder.timed.hour1" },
  { value: "-PT2H",   i18nKey: "app.reminder.timed.hour2" },
  { value: "-P1D",    i18nKey: "app.reminder.timed.day1" },
  { value: "-P1W",    i18nKey: "app.reminder.timed.week1" },
] as const;

/**
 * 全天事件的档位。基准点是当天 00:00，所以每一档都落在某一天的 09:00：
 * PT9H = 当天 09:00，-PT15H = 前一天 09:00（00:00 往前 15 小时），
 * -P1DT15H = 两天前 09:00，-P6DT15H = 一周前 09:00（00:00 往前 6 天 15 小时 = 7 天前的 09:00）。
 */
export const ALLDAY_TRIGGERS: readonly TriggerOption[] = [
  { value: "",          i18nKey: "app.reminder.none" },
  { value: "PT9H",      i18nKey: "app.reminder.allDay.sameDay9am" },
  { value: "-PT15H",    i18nKey: "app.reminder.allDay.dayBefore9am" },
  { value: "-P1DT15H",  i18nKey: "app.reminder.allDay.twoDaysBefore9am" },
  { value: "-P6DT15H",  i18nKey: "app.reminder.allDay.weekBefore9am" },
] as const;

/** 一个事件最多挂几条提醒。超出的截掉，不报错。 */
export const MAX_ALARMS_PER_EVENT = 8;

export type ParsedTrigger =
  | { kind: "relative"; ms: number; relatedToEnd: boolean }
  | { kind: "absolute"; at: Date };

export type Alarm = {
  trigger: string;
  action?: string | null;
  description?: string | null;
};

/** resolveTriggerAt 需要的最小事件形状。三端和 DB 行都能直接喂进来。 */
export type TriggerEventLike = {
  startsAt: Date;
  endsAt?: Date | null;
  allDay?: boolean | null;
  /** 事件所在时区（extra.timezone → 日历 timezone，由调用方先合并好） */
  timezone?: string | null;
};

const MS_SECOND = 1000;
const MS_MINUTE = 60 * MS_SECOND;
const MS_HOUR = 60 * MS_MINUTE;
const MS_DAY = 24 * MS_HOUR;
const MS_WEEK = 7 * MS_DAY;

// RFC 5545 dur-value。严格版的语法里 W 不和 D/T 同现，这里放宽成可以同现并直接相加：
// 放宽不会造成歧义（P1W2D 只可能是 9 天），而收紧的代价是第三方客户端发来的这一条被
// 整条丢掉、用户永远等不到提醒。年/月（P1Y、P1M）不在这个语法里，故意不认 —— 认了就得
// 猜「一个月」是 28 还是 31 天，猜错的提醒比不提醒更难排查。
const DURATION_RE = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i;

// 绝对触发的 DATE-TIME。RFC 要求必须是 UTC（带 Z），这里把不带 Z 的浮动写法也当 UTC，
// 和 ical.ts 里 parseICalDateValue 对无 TZID 值的处理保持一致。
const DATETIME_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?Z?$/i;

/**
 * 解析一条 TRIGGER。
 *
 * raw 可以是裸的 duration（`-PT15M`），也可以带 iCalendar 参数前缀
 * （`RELATED=END:-PT15M`、`VALUE=DATE-TIME:20260101T090000Z`、`RELATED=END;VALUE=DURATION:-PT15M`）。
 *
 * ms 是**有符号**的：负数 = 事件之前，正数 = 事件之后，0 合法（准时提醒）。
 * 之前那版用 `total > 0 ? total : null` 把 PT0S / -PT0M 判成非法，顺手还把正数触发
 * 当成了提前触发。
 *
 * 解析不了返回 null。空串（「不提醒」这个档位）也返回 null —— 它是个哨兵值，不是触发器。
 */
export function parseTrigger(raw: string): ParsedTrigger | null {
  if (typeof raw !== "string") return null;
  // ical.ts 给的是剥好的 value+params，但导入路径上时不时会有人把整行属性丢进来。
  // 认一下 "TRIGGER" 这个属性名，比让调用方各剥各的省事（剥错就是整条提醒消失）。
  // "TRIGGER;" 后面跟的是参数区，"TRIGGER:" 后面直接是值，两种都只需去掉这个前缀。
  const text = raw.replace(/^\s*TRIGGER[;:]/i, "").trim();
  if (!text) return null;

  // 拆参数：只有「第一个冒号之前那段含 =」才算参数区，否则整串都是 value。
  // 这样 `banana:x` 不会被误当成参数化写法。
  let value = text;
  let relatedToEnd = false;
  const colon = text.indexOf(":");
  if (colon > 0 && text.slice(0, colon).includes("=")) {
    value = text.slice(colon + 1).trim();
    for (const part of text.slice(0, colon).split(";")) {
      const eq = part.indexOf("=");
      if (eq <= 0) continue;
      const name = part.slice(0, eq).trim().toUpperCase();
      const pv = part.slice(eq + 1).trim().toUpperCase();
      if (name !== "RELATED") continue;      // VALUE= 等参数不用读，下面按 value 的形状分派
      if (pv === "END") relatedToEnd = true;
      else if (pv === "START") relatedToEnd = false;
      // RELATED 只允许 START/END。写了别的说明客户端想表达我们不懂的东西，
      // 这时候默认按 START 算就是在猜 —— 猜错就是提醒响在错的一端。宁可丢。
      else return null;
    }
  }
  if (!value) return null;

  const dur = parseDurationMs(value);
  if (dur !== null) return { kind: "relative", ms: dur, relatedToEnd };

  const at = parseAbsolute(value);
  if (at) return { kind: "absolute", at };

  return null;
}

/** 有符号毫秒。解析不了返回 null。0 是合法结果，调用方要用 `=== null` 判空。 */
function parseDurationMs(value: string): number | null {
  const m = DURATION_RE.exec(value);
  if (!m) return null;
  const [, sign, w, d, h, mi, s] = m;
  // 光一个 "P" 或 "PT" 也能匹配上正则（所有分组都可选），得单独挡掉。
  if (w === undefined && d === undefined && h === undefined && mi === undefined && s === undefined) return null;
  const total =
    Number(w ?? 0) * MS_WEEK +
    Number(d ?? 0) * MS_DAY +
    Number(h ?? 0) * MS_HOUR +
    Number(mi ?? 0) * MS_MINUTE +
    Number(s ?? 0) * MS_SECOND;
  const signed = sign === "-" ? -total : total;
  // -PT0M 取负会得到 -0。算术上无所谓，但它会一路带到快照断言和 JSON 里去，
  // 平白多出一种「看着一样其实不等」的值。这里收平。
  return signed === 0 ? 0 : signed;
}

function parseAbsolute(value: string): Date | null {
  const m = DATETIME_RE.exec(value);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
  const h = Number(m[4]), mi = Number(m[5]), s = Number(m[6] ?? 0);
  const at = new Date(Date.UTC(y, mo, d, h, mi, s));
  if (Number.isNaN(at.getTime())) return null;
  // Date.UTC 会把 20260230 顺延成 3 月 2 日。回读一遍分量，不一致就当没解析出来 ——
  // 把一个不存在的日期悄悄挪两天，比丢掉这条更难被发现。
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== mo || at.getUTCDate() !== d) return null;
  if (at.getUTCHours() !== h || at.getUTCMinutes() !== mi || at.getUTCSeconds() !== s) return null;
  return at;
}

/**
 * 清洗一组提醒：丢掉解析不了的、按语义去重、截到 MAX_ALARMS_PER_EVENT 条，顺序保持稳定。
 *
 * 去重比「字符串相同」更狠一点 —— `-PT15M` 和 `RELATED=START:-PT15M` 是同一个时刻，
 * 两条都留下就会在同一分钟响两次（幂等键是 (event_id, trigger, instance_start)，
 * trigger 原文不同就撞不上键，挡不住）。
 *
 * 但保留下来的那条**不改写原文**：trigger 字符串是幂等键的一部分，规范化会让已经发过的
 * 提醒对不上旧行，于是重发一遍。
 */
export function normalizeAlarms(list: unknown): Alarm[] {
  if (!Array.isArray(list)) return [];
  const out: Alarm[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const raw = (item as { trigger?: unknown }).trigger;
    if (typeof raw !== "string") continue;
    const parsed = parseTrigger(raw);
    if (!parsed) continue;                       // 垃圾值只丢这一条，其余保留
    const key = canonicalKey(parsed);
    if (seen.has(key)) continue;
    seen.add(key);
    const alarm: Alarm = { trigger: raw.trim() };
    const action = (item as { action?: unknown }).action;
    if (typeof action === "string" && action.trim()) alarm.action = action.trim();
    const description = (item as { description?: unknown }).description;
    if (typeof description === "string" && description.trim()) alarm.description = description.trim();
    out.push(alarm);
    if (out.length >= MAX_ALARMS_PER_EVENT) break;
  }
  return out;
}

function canonicalKey(p: ParsedTrigger): string {
  return p.kind === "absolute" ? `abs:${p.at.getTime()}` : `rel:${p.ms}:${p.relatedToEnd ? "end" : "start"}`;
}

/**
 * 算出这条提醒该响的绝对时刻。算不出来返回 null，**调用方负责记一条可观测的 skip 日志**。
 *
 * - 非全天：基准是 startsAt（relatedToEnd 时是 endsAt），加上有符号 ms，纯绝对时长运算。
 * - 全天：基准是事件所在时区**那一天的 00:00**，偏移按墙上时间走（见文件头第 2 条）。
 *   timezone 拿不到就返回 null —— 绝对不回落到服务器本地时区，那会算出一个和用户
 *   看到的日期对不上的时刻，而且没有任何报错。
 * - absolute：直接返回那个时刻，不需要时区。
 */
export function resolveTriggerAt(event: TriggerEventLike, trigger: string | ParsedTrigger): Date | null {
  const parsed = typeof trigger === "string" ? parseTrigger(trigger) : trigger;
  if (!parsed) return null;
  if (parsed.kind === "absolute") return new Date(parsed.at.getTime());

  if (event.allDay) return resolveAllDay(event, parsed);

  const base = parsed.relatedToEnd ? event.endsAt : event.startsAt;
  // RELATED=END 却没有 endsAt：退回 startsAt 就是把 10:45 算成 08:45，正是这一期在修的
  // 那类「不报错但算错」。宁可不排。
  if (!(base instanceof Date) || Number.isNaN(base.getTime())) return null;
  return new Date(base.getTime() + parsed.ms);
}

function resolveAllDay(event: TriggerEventLike, parsed: { ms: number; relatedToEnd: boolean }): Date | null {
  const tz = event.timezone;
  if (!tz || typeof tz !== "string" || !tz.trim()) return null;

  // 全天事件的 startsAt/endsAt 存的是当天的 UTC 午夜（见 ical.ts parseICalDateValue），
  // 所以日期分量要用 UTC getter 读，读出来的就是用户看到的那个日期。
  // 注：RELATED=END 落在 endsAt 的日期上，而 iCalendar 的 DTEND 对全天是**开区间**
  // （2026-03-05 的单日事件 DTEND 是 03-06）。我们不替调用方做减一天的猜测。
  const anchor = parsed.relatedToEnd ? event.endsAt : event.startsAt;
  if (!(anchor instanceof Date) || Number.isNaN(anchor.getTime())) return null;

  // 先在一个「假 UTC 日历」上做民用时间加减，再整体换算到 tz。
  // 这一步是全天提醒不随夏令时漂移的关键：夏令时切换那天只有 23 小时，
  // 如果换成「当地午夜的绝对时刻 + 9 小时」，用户会在当地 10:00 收到「当天 09:00」的提醒。
  const civil = Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate()) + parsed.ms;
  const c = new Date(civil);
  return wallClockInZoneToUtc(
    c.getUTCFullYear(), c.getUTCMonth(), c.getUTCDate(),
    c.getUTCHours(), c.getUTCMinutes(), c.getUTCSeconds(),
    tz,
  );
}

/**
 * 把 (y, mo, d, h, mi, s) 当成 tz 的墙上读数，返回产生这个读数的 UTC 瞬间。
 * 时区不认识（Intl 抛 RangeError）返回 null，**不回落到本地时区**。
 */
function wallClockInZoneToUtc(
  y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string,
): Date | null {
  const guess = Date.UTC(y, mo, d, h, mi, s);
  const off1 = zoneOffsetMs(guess, tz);
  if (off1 === null) return null;
  let utc = guess - off1;
  // 再迭代一次：第一次的偏移是在「猜错的瞬间」上取的，靠近夏令时切换点时会差一小时。
  const off2 = zoneOffsetMs(utc, tz);
  if (off2 === null) return null;
  if (off2 !== off1) utc = guess - off2;
  const out = new Date(utc);
  return Number.isNaN(out.getTime()) ? null : out;
}

/** tz 在 utcMs 这一刻相对 UTC 的偏移（毫秒）。时区非法返回 null。 */
function zoneOffsetMs(utcMs: number, tz: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric",
      // 锁死 h23（而不是 hour12:false）：后者对某些 locale/ICU 组合会落到 h24，
      // 午夜读成 "24" 时算出的偏移整整差一天，而且只在午夜那一刻错。
      hourCycle: "h23",
    }).formatToParts(new Date(utcMs));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? NaN);
    const y = get("year"), mo = get("month"), d = get("day"), hh = get("hour"), mi = get("minute"), s = get("second");
    if ([y, mo, d, hh, mi, s].some((n) => Number.isNaN(n))) return null;
    return Date.UTC(y, mo - 1, d, hh, mi, s) - utcMs;
  } catch {
    return null;
  }
}
