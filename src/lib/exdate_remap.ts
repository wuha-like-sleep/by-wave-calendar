// 一个重复事件「按哪个时区展开」变了之后，以前记下的「删掉这一次」(exdates) 和「这次及以后」
// 留下的 UNTIL 要跟着对到新的日子上。三个地方会变：
//   · 升级到 1.7.4：从「按 UTC 展开」变成按事件 / 日历时区（data_migrations.ts，只跑一次）；
//   · 改了日历的时区（PATCH /calendars/:id）：没有自己时区的事件跟着日历换；
//   · 改事件时换了时区、换了日历，或者原来是手机写的 UTC 原文、被网页编辑之后改按时区展开
//     （PATCH /events/:id）。
//
// 口径：**删掉的是你当时看到的那一次。**
//   · 那个时刻在新排法里还是一次：原样不动。
//   · 不是了（以前画在周二的「每周一」例会、夏令时后 10:30 的 9:30 例会）：换成新排法里
//     离它最近的那一次。两种排法同一次最多差「一天 + 夏令时」，超过 26 小时就不是同一次，原样保留。
//     「差一天」只会往一个方向差：新时区比旧时区快（UTC → 墨尔本 / 北京）新的那次只会更早，
//     慢（UTC → 纽约）只会更晚。所以只在那一侧找一天，另一侧只容夏令时那几个小时 ——
//     不然「每周一三五」这种隔天的规则两边各有一次，夏令时一来最近的就成了错的那边。
//   · 那个时刻本来就不是旧排法里的一次（规则后来改过留下的、写坏的）：原样保留，不猜。
// 「原样不动」优先，所以跑完再跑一遍什么都不改；恢复一份升级后的备份再跑也一样。
//
// 纯函数，只依赖 rrule_expand：scripts/migrate.ts 也要用。

import { seriesStartsBetween } from "./rrule_expand.js";
import { zoneOffsetMs } from "./zoned_time.js";

const HOUR = 60 * 60 * 1000;
/** exdate：旧的一次和新的一次最多差「一天 + 夏令时」= 25 小时。 */
const EXDATE_WINDOW_MS = 26 * HOUR;
/** 不会错一天的那一侧只容夏令时：两个时区的夏令时一进一出，最多差 2 小时。 */
const DST_ONLY_WINDOW_MS = 3 * HOUR;
/**
 * UNTIL 只在「同一天、只差夏令时」时跟着挪。差一天的（「每周一」以前画在周二）不挪：
 * 「这次及以后」拆出来的新系列从周二开始、规则是每周一，按新排法周二那次本来就不算；
 * 旧系列要是也收到周一之前，那一周就一次都没有了，提醒也不响。宁可那周多一次旧标题的。
 */
const UNTIL_WINDOW_MS = 3 * HOUR;

/**
 * 秒级 / 分钟级 / 小时级的规则不处理：没有「错一天」的问题，从第一次数到那一次可能是
 * 几百万次，而数据迁移跑在开机路径上。
 */
const SUB_DAILY_RE = /(^|;)\s*FREQ=(SECONDLY|MINUTELY|HOURLY)\s*(;|$)/i;

export type ZoneChangeInput = {
  startsAt: Date;
  rrule: string | null;
  allDay: boolean;
  exdates: unknown;
  fromZone: string;
  toZone: string;
};

export type ZoneChangeResult = {
  /** 改过才有 */
  exdates?: string[];
  /** 改过才有 */
  rrule?: string;
  /** 被改写的 exdate 条数 */
  rewritten: number;
  /** 是旧排法里的一次、26 小时内却找不到新排法的一次，原样保留的条数 */
  unmapped: number;
};

const NOTHING: ZoneChangeResult = { rewritten: 0, unmapped: 0 };

/** 往前、往后各看多远。新时区在 DTSTART 那一刻比旧时区快：错一天只会往前错；慢：只会往后。 */
function searchWindow(startsAt: Date, fromZone: string, toZone: string): { before: number; after: number } {
  const s0 = startsAt.getTime();
  const d0 = (zoneOffsetMs(s0, toZone) ?? 0) - (zoneOffsetMs(s0, fromZone) ?? 0);
  return {
    before: d0 > 0 ? EXDATE_WINDOW_MS : DST_ONLY_WINDOW_MS,
    after: d0 < 0 ? EXDATE_WINDOW_MS : DST_ONLY_WINDOW_MS,
  };
}

function nearest(candidates: Date[], t: number, win: { before: number; after: number }): Date | null {
  let best: Date | null = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const delta = c.getTime() - t;
    if (delta < -win.before || delta > win.after) continue;
    // 一样近取早的那个（< 不是 <=，candidates 是升序的）。
    const dist = Math.abs(delta);
    if (dist < bestDist) { best = c; bestDist = dist; }
  }
  return best;
}

/** 升序数组里落在 [t − before, t + after] 的那几个（二分找起点）。 */
function candidatesAround(sorted: Date[], t: number, win: { before: number; after: number }): Date[] {
  let a = 0, b = sorted.length;
  while (a < b) { const m = (a + b) >> 1; if (sorted[m]!.getTime() < t - win.before) a = m + 1; else b = m; }
  const out: Date[] = [];
  for (let i = a; i < sorted.length && sorted[i]!.getTime() <= t + win.after; i++) out.push(sorted[i]!);
  return out;
}

function isStartOf(ev: { startsAt: Date; rrule: string }, zone: string, t: number): boolean {
  const at = new Date(t);
  const hit = seriesStartsBetween({ startsAt: ev.startsAt, rrule: ev.rrule, allDay: false, timeZone: zone }, at, at);
  return !!hit && hit.some((d) => d.getTime() === t);
}

/**
 * 一个事件的全部 exdate 只展开两遍（新、旧排法各一遍，窗口盖住最早到最晚那条），
 * 不是每条各展开一遍：rrule 每次都从 DTSTART 数起，一个日历几千个事件时按条展开要几十秒。
 */
const SCAN_CAP = 200_000;

/** exdates 部分。null = 规则解析不了（或者窗口里多到数不完），整件事不做。 */
function remapExdates(
  ev: { startsAt: Date; rrule: string }, raw: string[], fromZone: string, toZone: string,
): { exdates: string[]; rewritten: number; unmapped: number } | null {
  const win = searchWindow(ev.startsAt, fromZone, toZone);
  const times = raw.map((s) => +new Date(s)).filter((t) => !Number.isNaN(t));
  if (times.length === 0) return { exdates: raw, rewritten: 0, unmapped: 0 };
  const lo = Math.min(...times);
  const hi = Math.max(...times);
  const series = (zone: string, from: number, to: number) => seriesStartsBetween(
    { startsAt: ev.startsAt, rrule: ev.rrule, allDay: false, timeZone: zone }, new Date(from), new Date(to), SCAN_CAP,
  );
  const fresh = series(toZone, lo - win.before, hi + win.after);
  const legacy = series(fromZone, lo, hi);
  if (!fresh || !legacy || fresh.length >= SCAN_CAP || legacy.length >= SCAN_CAP) return null;
  const freshSet = new Set(fresh.map((d) => d.getTime()));
  const legacySet = new Set(legacy.map((d) => d.getTime()));

  let unmapped = 0;
  const plan: { value: string; ms: number; moved: boolean }[] = [];
  for (const s of raw) {
    const t = +new Date(s);
    if (Number.isNaN(t) || freshSet.has(t) || !legacySet.has(t)) {
      plan.push({ value: s, ms: t, moved: false });
      continue;
    }
    const target = nearest(candidatesAround(fresh, t, win), t, win);
    if (!target) { unmapped++; plan.push({ value: s, ms: t, moved: false }); continue; }
    plan.push({ value: target.toISOString(), ms: target.getTime(), moved: true });
  }
  const rewritten = plan.filter((p) => p.moved).length;
  if (rewritten === 0) return { exdates: raw, rewritten: 0, unmapped };
  // 留原样的一条不少（哪怕本来就有重复，也不是这次该动的）；改写出来的那一次已经在列表里了
  // （两条本来指同一次，或者两条旧的对到了同一次新的），就不再加一条。
  const kept = new Set(plan.filter((p) => !p.moved).map((p) => p.ms));
  const out: string[] = [];
  for (const p of plan) {
    if (p.moved) {
      if (kept.has(p.ms)) continue;
      kept.add(p.ms);
    }
    out.push(p.value);
  }
  return { exdates: out, rewritten, unmapped };
}

function formatUntil(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * 「这次及以后」（和「删除这次及以后」）给旧系列加的是 UNTIL = 那一次 − 1 秒。那一次换了时刻
 * （只差夏令时的情况），旧系列在那天还能多出一次，和拆出来的新系列撞在同一天、提醒响两遍。
 * 返回改过的规则；不用改返回 null。
 */
function remapSplitUntil(ev: { startsAt: Date; rrule: string }, fromZone: string, toZone: string): string | null {
  const parts = ev.rrule.split(";");
  const idx = parts.findIndex((p) => /^UNTIL=/i.test(p.trim()));
  if (idx < 0) return null;
  const m = /^UNTIL=(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/i.exec(parts[idx]!.trim());
  if (!m) return null;
  const u = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) + 1000;
  const bare = { startsAt: ev.startsAt, rrule: parts.filter((_, i) => i !== idx).join(";") };
  const near = seriesStartsBetween(
    { ...bare, allDay: false, timeZone: toZone }, new Date(u - UNTIL_WINDOW_MS), new Date(u + UNTIL_WINDOW_MS),
  );
  if (!near || near.some((d) => d.getTime() === u) || !isStartOf(bare, fromZone, u)) return null;
  const target = nearest(near, u, { before: UNTIL_WINDOW_MS, after: UNTIL_WINDOW_MS });
  if (!target) return null;
  const next = [...parts];
  next[idx] = `UNTIL=${formatUntil(new Date(target.getTime() - 1000))}`;
  return next.join(";");
}

/**
 * 展开时区从 fromZone 换成 toZone 之后，exdates 和 UNTIL 要怎么改。
 * 全天、不重复、时区没变、规则解析不了、小时级以下的规则：什么都不改。
 */
export function remapSeriesForZoneChange(ev: ZoneChangeInput): ZoneChangeResult {
  if (ev.allDay || !ev.rrule || ev.fromZone === ev.toZone) return NOTHING;
  if (SUB_DAILY_RE.test(ev.rrule)) return NOTHING;
  const base = { startsAt: ev.startsAt, rrule: ev.rrule };
  const result: ZoneChangeResult = { rewritten: 0, unmapped: 0 };

  const raw = Array.isArray(ev.exdates) ? ev.exdates.filter((x): x is string => typeof x === "string") : [];
  if (raw.length) {
    const r = remapExdates(base, raw, ev.fromZone, ev.toZone);
    if (!r) return NOTHING;
    result.unmapped = r.unmapped;
    if (r.rewritten) { result.exdates = r.exdates; result.rewritten = r.rewritten; }
  }
  const until = remapSplitUntil(base, ev.fromZone, ev.toZone);
  if (until) result.rrule = until;
  return result;
}
