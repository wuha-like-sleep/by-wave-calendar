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

import { and, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import * as schema from "../db/schema.js";
import { expansionTimeZone, rawIcsStartIsUtc } from "./event_zone.js";
import { remapSeriesForZoneChange } from "./exdate_remap.js";

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
// 1.7.4：重复事件改成按事件自己的时区展开之后，把老的 exdates / UNTIL 对到新排法上。
// ---------------------------------------------------------------------------

export const EXDATE_LOCAL_TIME_MIGRATION = "2026-10-recurrence-local-time-exdates";

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
  /** 旧排法算得出、26 小时内却找不到新排法的一次，原样保留的条数 */
  unmapped: number;
};

/**
 * 「删掉这一次 / 只改这一次」往 exdates 里记的是**旧算法**（DTSTART 写成 UTC 展开）算出来的
 * 那一次的时刻。旧算法就是「按 UTC 展开」，所以这里只是 exdate_remap.ts 的
 * fromZone = "UTC" 那一种，口径见那边：删掉的是当时看到的那一次 —— 那个时刻新排法里还有
 * 就不动，没有了就换成离它最近的那一次。
 *
 * 纯函数，返回 null = 这个事件不需要处理（全天、不重复、没有 exdates、按 UTC 展开、规则解析不了）。
 */
export function remapLegacyExdates(ev: ExdateRemapInput): ExdateRemapResult | null {
  if (ev.allDay || !ev.rrule || ev.timeZone === "UTC") return null;
  if (!Array.isArray(ev.exdates) || ev.exdates.length === 0) return null;
  const raw = ev.exdates.filter((x): x is string => typeof x === "string");
  if (raw.length === 0) return null;
  const r = remapSeriesForZoneChange({
    startsAt: ev.startsAt, rrule: ev.rrule, allDay: false, exdates: raw, fromZone: "UTC", toZone: ev.timeZone,
  });
  return { exdates: r.exdates ?? raw, rewritten: r.rewritten, unmapped: r.unmapped };
}

export type ExdateMigrationReport = {
  scanned: number; changedEvents: number; rewritten: number; untilMoved: number; unmapped: number;
  failed: number; raced: number;
};

type MigrationRow = {
  id: string; startsAt: Date; rrule: string | null; allDay: boolean; exdates: unknown;
  extra: unknown; rawIcs: string | null; calendarTimezone: string | null;
};

const migrationColumns = {
  id: schema.events.id,
  startsAt: schema.events.startsAt,
  rrule: schema.events.rrule,
  allDay: schema.events.allDay,
  exdates: schema.events.exdates,
  extra: schema.events.extra,
  rawIcs: schema.events.rawIcs,
  calendarTimezone: schema.calendars.timezone,
};

function planFor(row: MigrationRow) {
  return remapSeriesForZoneChange({
    startsAt: row.startsAt,
    rrule: row.rrule,
    allDay: row.allDay,
    exdates: row.exdates,
    fromZone: "UTC",
    toZone: expansionTimeZone({
      allDay: row.allDay, extra: row.extra, calendarTimezone: row.calendarTimezone,
      rawStartIsUtc: rawIcsStartIsUtc(row.rawIcs),
    }),
  });
}

/**
 * 对库里每个未删除、非全天、带 RRULE、又带 exdates 或 UNTIL 的事件跑一遍。改了的刷新 updated_at。
 *
 * 写回时比对旧值（exdates、rrule 都没被别人动过才写）：后台「系统更新」跑迁移的时候老进程
 * 还在接请求，这段时间里有人「删掉这一次」或者手机 PUT 了新的 EXDATE，不能拿读进来的
 * 旧列表整列盖掉。撞上了就重读这一行再算一遍。
 */
export async function migrateLegacyExdates(db: AnyPgDb): Promise<ExdateMigrationReport> {
  const rows: MigrationRow[] = await db
    .select(migrationColumns)
    .from(schema.events)
    .innerJoin(schema.calendars, eq(schema.calendars.id, schema.events.calendarId))
    .where(and(
      isNotNull(schema.events.rrule),
      ne(schema.events.rrule, ""),
      eq(schema.events.allDay, false),
      isNull(schema.events.deletedAt),
      or(isNotNull(schema.events.exdates), sql`${schema.events.rrule} ILIKE '%UNTIL=%'`),
    ));

  const report: ExdateMigrationReport = {
    scanned: rows.length, changedEvents: 0, rewritten: 0, untilMoved: 0, unmapped: 0, failed: 0, raced: 0,
  };
  for (const first of rows) {
    let row: MigrationRow | undefined = first;
    for (let attempt = 0; row && attempt < 3; attempt++) {
      let plan: ReturnType<typeof planFor>;
      try {
        plan = planFor(row);
      } catch {
        // 一条事件的规则把 rrule 库弄崩了，不能让整个迁移（连带开机）卡在它身上。
        report.failed++;
        break;
      }
      if (!plan.exdates && !plan.rrule) { report.unmapped += plan.unmapped; break; }
      // updated_at 刷新：CalDAV 的单条 etag 和日历 ctag 都喂它，手机才会把改过的 EXDATE 重新下载。
      const updated = await db.update(schema.events)
        .set({
          ...(plan.exdates ? { exdates: plan.exdates } : {}),
          ...(plan.rrule ? { rrule: plan.rrule } : {}),
          updatedAt: new Date(),
        })
        .where(and(
          eq(schema.events.id, row.id),
          eq(schema.events.rrule, row.rrule ?? ""),
          row.exdates == null
            ? sql`(${schema.events.exdates} IS NULL OR ${schema.events.exdates} = 'null'::jsonb)`
            : sql`${schema.events.exdates} = ${JSON.stringify(row.exdates)}::jsonb`,
        ))
        .returning({ id: schema.events.id });
      if (updated.length) {
        report.changedEvents++;
        report.rewritten += plan.rewritten;
        report.unmapped += plan.unmapped;
        if (plan.rrule) report.untilMoved++;
        break;
      }
      // 读完之后被改过：重读这一行（可能已经删了、改成全天了），再算一遍。
      report.raced++;
      [row] = await db
        .select(migrationColumns)
        .from(schema.events)
        .innerJoin(schema.calendars, eq(schema.calendars.id, schema.events.calendarId))
        .where(and(eq(schema.events.id, first.id), isNull(schema.events.deletedAt)))
        .limit(1);
    }
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
      return `检查 ${r.scanned} 个带例外日期或结束时间的重复事件，改写 ${r.changedEvents} 个事件里的 ${r.rewritten} 条例外日期`
        + (r.untilMoved ? `、${r.untilMoved} 个结束时间` : "")
        + (r.unmapped ? `，${r.unmapped} 条一天之内找不到对应的那一次、原样保留` : "")
        + (r.raced ? `，${r.raced} 次和同时进来的修改撞上、重读后再算` : "")
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
