// 程序里跑的数据迁移：SQL 迁移做不了的那种（要展开 RRULE、要换算时区）。
//
// 挂在两个地方，两边都会跑到：
//   · scripts/migrate.ts —— install.sh、后台「系统更新」、`npm run db:migrate` 走这里；
//   · src/lib/auto_migrate.ts —— 每次开机，在 SQL 迁移之后、开始监听之前。
// 另外恢复备份之后也跑一次（src/lib/backup.ts）：恢复回来的可能是升级前的老数据。
//
// 「只跑一次」靠 site_settings.data_migrations_done 记账：跑完把名字写进去，下次开机
// 看到就跳过。「重复跑也没事」靠每条迁移自己幂等 —— 记账丢了、手动 --rerun、恢复了
// 一份老备份，再跑一遍都只改该改的。整个过程在一个事务里、先拿 advisory lock：
// PM2 起多个进程时只有一个在做，另一个等它提交后看到记账、直接跳过。
//
// 只依赖 drizzle 和 schema，不 import env / db/client —— scripts/migrate.ts 那边没有
// 完整的环境变量，import 了 env.ts 会在校验那一步直接退出。

import { and, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import * as schema from "../db/schema.js";
import { expansionTimeZone, rawIcsStartIsUtc } from "./event_zone.js";
import { listSeriesStarts, listSeriesStartsLegacyUtc } from "./rrule_expand.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPgDb = PgDatabase<any, any, any>;

type Log = { info: (msg: string) => void; error: (msg: string, err?: unknown) => void };
const consoleLog: Log = {
  info: (m) => console.log(m),
  error: (m, err) => console.error(m, err),
};

/** 随便取的一个常数，只要别和库里别的 advisory lock 撞上。 */
const DATA_MIGRATION_LOCK_KEY = 7_401_202_610;

// ---------------------------------------------------------------------------
// 1.7.4：重复事件改成按事件自己的时区展开之后，把老的 exdates 对到新算法上。
// ---------------------------------------------------------------------------

export const EXDATE_LOCAL_TIME_MIGRATION = "2026-10-recurrence-local-time-exdates";

/**
 * 一个事件最多从第一次往后数多少次。数不到最晚那个 exdate 的话，超出去的那几个
 * 原样保留（不猜）。每天一次的事件 2 万次是 50 多年，每小时一次是两年多。
 */
const MAX_SERIES_SCAN = 20_000;

export type ExdateRemapInput = {
  startsAt: Date;
  rrule: string | null;
  allDay: boolean;
  exdates: unknown;
  /** expansionTimeZone() 算出来的时区 */
  timeZone: string;
};

export type ExdateRemapResult = {
  exdates: string[];
  /** 被改写的条数 */
  rewritten: number;
  /** 旧算法算得出、新算法算不出、却又对不上序号的条数（原样保留） */
  unmapped: number;
};

/**
 * 「删掉这一次 / 只改这一次」往 exdates 里记的是**旧算法**（DTSTART 写成 UTC 展开）算出来的
 * 那一次的时刻。展开改成按事件时区之后，这些时刻里有的已经不是任何一次了 —— 被删的那次
 * 会重新冒出来，还可能挪到别的日子。
 *
 * 对应关系按「第几次」：旧算法的第 k 次 ↔ 新算法的第 k 次。
 *   · 新算法本来就算得出的 exdate：不动（新数据、手机通过 CalDAV 写上来的、已经迁移过的）。
 *   · 旧算法算得出、新算法算不出：改成新算法里同序号的那一次。
 *   · 两边都算不出（规则后来被改过留下的孤儿、格式不对的）：原样保留，不猜。
 * 所以跑完再跑一遍，每一条都落在第一类，什么都不改。
 *
 * 纯函数，返回 null = 这个事件不需要处理（全天、不重复、没有 exdates、按 UTC 展开、规则解析不了）。
 */
export function remapLegacyExdates(ev: ExdateRemapInput): ExdateRemapResult | null {
  if (ev.allDay || !ev.rrule || ev.timeZone === "UTC") return null;
  if (!Array.isArray(ev.exdates) || ev.exdates.length === 0) return null;
  const raw = ev.exdates.filter((x): x is string => typeof x === "string");
  if (raw.length === 0) return null;

  const millis = raw.map((s) => +new Date(s)).filter((t) => !Number.isNaN(t));
  if (millis.length === 0) return null;
  const latest = new Date(Math.max(...millis));

  const legacy = listSeriesStartsLegacyUtc(ev, { until: latest, cap: MAX_SERIES_SCAN });
  if (!legacy) return null;
  const legacyIndex = new Map<number, number>();
  legacy.starts.forEach((d, i) => { if (!legacyIndex.has(d.getTime())) legacyIndex.set(d.getTime(), i); });

  // 新算法要列到两样都够：时间上覆盖最晚那个 exdate（判「新算法算不算得出」），
  // 次数上覆盖要对应的最大序号。
  let maxIndex = -1;
  for (const t of millis) {
    const i = legacyIndex.get(t);
    if (i !== undefined && i > maxIndex) maxIndex = i;
  }
  const current = listSeriesStarts(
    { startsAt: ev.startsAt, rrule: ev.rrule, allDay: false, timeZone: ev.timeZone },
    { until: latest, minCount: maxIndex + 1, cap: MAX_SERIES_SCAN },
  );
  if (!current) return null;
  const currentSet = new Set(current.starts.map((d) => d.getTime()));

  let unmapped = 0;
  // 第一遍：每条决定「留原样」还是「换成哪一次」。
  const plan = raw.map((s) => {
    const t = +new Date(s);
    if (Number.isNaN(t) || currentSet.has(t)) return { value: s, ms: t, moved: false };
    const k = legacyIndex.get(t);
    if (k === undefined) return { value: s, ms: t, moved: false };
    const target = current.starts[k];
    if (!target) { unmapped++; return { value: s, ms: t, moved: false }; }
    return { value: target.toISOString(), ms: target.getTime(), moved: true };
  });
  const rewritten = plan.filter((p) => p.moved).length;
  if (rewritten === 0) return { exdates: raw, rewritten: 0, unmapped };

  // 第二遍：留原样的一条不少（哪怕本来就有重复，也不是这次该动的）；
  // 改写出来的那一次已经在列表里了（两条本来指同一次），就不再加一条。
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

export type ExdateMigrationReport = { scanned: number; changedEvents: number; rewritten: number; unmapped: number; failed: number };

/** 对库里每个未删除、非全天、带 RRULE 和 exdates 的事件跑一遍 remapLegacyExdates。改了的刷新 updated_at。 */
export async function migrateLegacyExdates(db: AnyPgDb): Promise<ExdateMigrationReport> {
  const rows = await db
    .select({
      id: schema.events.id,
      startsAt: schema.events.startsAt,
      rrule: schema.events.rrule,
      allDay: schema.events.allDay,
      exdates: schema.events.exdates,
      extra: schema.events.extra,
      rawIcs: schema.events.rawIcs,
      calendarTimezone: schema.calendars.timezone,
    })
    .from(schema.events)
    .innerJoin(schema.calendars, eq(schema.calendars.id, schema.events.calendarId))
    .where(and(
      isNotNull(schema.events.rrule),
      ne(schema.events.rrule, ""),
      eq(schema.events.allDay, false),
      isNull(schema.events.deletedAt),
      isNotNull(schema.events.exdates),
    ));

  const report: ExdateMigrationReport = { scanned: rows.length, changedEvents: 0, rewritten: 0, unmapped: 0, failed: 0 };
  for (const row of rows) {
    let result: ExdateRemapResult | null;
    try {
      result = remapLegacyExdates({
        startsAt: row.startsAt,
        rrule: row.rrule,
        allDay: row.allDay,
        exdates: row.exdates,
        timeZone: expansionTimeZone({
          allDay: row.allDay, extra: row.extra, calendarTimezone: row.calendarTimezone,
          rawStartIsUtc: rawIcsStartIsUtc(row.rawIcs),
        }),
      });
    } catch {
      // 一条事件的规则把 rrule 库弄崩了，不能让整个迁移（连带开机）卡在它身上。
      report.failed++;
      continue;
    }
    if (!result) continue;
    report.unmapped += result.unmapped;
    if (result.rewritten === 0) continue;
    // updated_at 刷新：CalDAV 的单条 etag 和日历 ctag 都喂它，手机才会把改过的 EXDATE 重新下载。
    await db.update(schema.events)
      .set({ exdates: result.exdates, updatedAt: new Date() })
      .where(eq(schema.events.id, row.id));
    report.changedEvents++;
    report.rewritten += result.rewritten;
  }
  return report;
}

// ---------------------------------------------------------------------------
// 记账 + 调度
// ---------------------------------------------------------------------------

type DataMigration = { name: string; run: (db: AnyPgDb) => Promise<string> };

const DATA_MIGRATIONS: DataMigration[] = [
  {
    name: EXDATE_LOCAL_TIME_MIGRATION,
    run: async (db) => {
      const r = await migrateLegacyExdates(db);
      return `检查 ${r.scanned} 个带例外日期的重复事件，改写 ${r.changedEvents} 个事件里的 ${r.rewritten} 条`
        + (r.unmapped ? `，${r.unmapped} 条对不上序号、原样保留` : "")
        + (r.failed ? `，${r.failed} 个事件规则无法展开、跳过` : "");
    },
  },
];

export const DATA_MIGRATION_NAMES: readonly string[] = DATA_MIGRATIONS.map((m) => m.name);

function parseDone(v: string | null | undefined): Set<string> {
  return new Set((v ?? "").split(/\s+/).filter(Boolean));
}

/**
 * 把还没跑过的数据迁移跑掉。`force` = 不管记账，全部重跑一遍（每条都幂等）。
 * 失败直接抛（事务整体回滚、记账不写），由调用方决定是退出还是记日志继续。
 */
export async function runDataMigrations(
  db: AnyPgDb,
  opts: { force?: boolean; log?: Log } = {},
): Promise<{ ran: string[] }> {
  const log = opts.log ?? consoleLog;
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SELECT pg_advisory_xact_lock(${DATA_MIGRATION_LOCK_KEY})`));
    const [row] = await tx
      .select({ done: schema.siteSettings.dataMigrationsDone })
      .from(schema.siteSettings)
      .where(eq(schema.siteSettings.id, 1))
      .limit(1);
    const done = parseDone(row?.done);
    const ran: string[] = [];
    for (const m of DATA_MIGRATIONS) {
      if (!opts.force && done.has(m.name)) continue;
      const summary = await m.run(tx as unknown as AnyPgDb);
      log.info(`[data-migrate] ${m.name}: ${summary}`);
      done.add(m.name);
      ran.push(m.name);
    }
    // site_settings 那一行还不存在（全新安装，第一次读设置才懒插入）时写不进去：
    // 那就下次开机再跑一遍，全新安装没有任何事件，花不了什么。
    if (ran.length > 0) {
      await tx.update(schema.siteSettings)
        .set({ dataMigrationsDone: [...done].join(" ") })
        .where(eq(schema.siteSettings.id, 1));
    }
    return { ran };
  });
}
