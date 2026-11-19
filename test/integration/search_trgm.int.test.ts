// 迁移 0062 的 pg_trgm 索引：两个运行环境都要验 ——
//   ① 装了 pg_trgm 的库（生产形态）：迁移真能把 4 个索引建出来，而且搜索路由
//      发出的两种 ILIKE 形状（summary 子串、(extra ->> 'attendees') 子串）
//      都能被对应的 trgm 索引服务（EXPLAIN 里是 Bitmap Index Scan）；
//   ② 没装 pg_trgm 的库（集成测试的 PGlite 默认形态）：迁移不许抛错，索引
//      缺席，ILIKE 照常返回正确结果 —— 索引只是加速，不是正确性前提。
//
// 为什么用 enable_seqscan=off 验「能走索引」：PGlite 的规划器成本模型和正式
// Postgres 不一样，5000 行量级它对高选择性词也选顺序扫（实测）。关掉顺序扫
// 后能选出 Bitmap Index Scan，证明索引对这条查询形状可用；正式 Postgres 上
// 规划器在数据量和统计信息正常时会自己选，这一点本环境验不了，如实标注。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";

const MIGRATION_SQL = readFileSync("drizzle/migrations/0062_search_trgm_indexes.sql", "utf8");

async function applyMigration(pg: PGlite): Promise<void> {
  for (const stmt of MIGRATION_SQL.split("--> statement-breakpoint")) {
    const t = stmt.trim();
    if (t) await pg.exec(t);
  }
}

async function makeEventsTable(pg: PGlite): Promise<void> {
  await pg.exec(
    `CREATE TABLE events (
       id int PRIMARY KEY,
       summary text NOT NULL,
       location text,
       description text,
       extra jsonb
     )`,
  );
}

async function indexNames(pg: PGlite): Promise<string[]> {
  const r = await pg.query<{ indexname: string }>(
    "SELECT indexname FROM pg_indexes WHERE tablename = 'events' ORDER BY indexname",
  );
  return r.rows.map((x) => x.indexname);
}

async function explain(pg: PGlite, sqlText: string): Promise<string> {
  const r = await pg.query<Record<string, string>>(sqlText);
  return r.rows.map((x) => Object.values(x)[0]).join("\n");
}

describe("装了 pg_trgm 时", () => {
  it("迁移建出 4 个 trgm 索引，两种搜索形状都能走索引", async () => {
    const pg = new PGlite({ extensions: { pg_trgm } });
    try {
      await makeEventsTable(pg);
      await applyMigration(pg);
      expect(await indexNames(pg)).toEqual(expect.arrayContaining([
        "events_summary_trgm_idx",
        "events_location_trgm_idx",
        "events_description_trgm_idx",
        "events_attendees_trgm_idx",
      ]));

      await pg.query(
        "INSERT INTO events SELECT g, 'daily standup meeting ' || g, 'room ' || g, 'notes', jsonb_build_object('attendees', jsonb_build_array('user' || g || '@example.com')) FROM generate_series(1, 5000) g",
      );
      await pg.query(
        "INSERT INTO events VALUES (90001, 'quarterlyreview board session', 'hq', 'x', '{\"attendees\":[\"zhangsan@example.com\"]}'::jsonb)",
      );
      await pg.query("ANALYZE events");
      await pg.query("SET enable_seqscan = off");

      const summaryPlan = await explain(pg, "EXPLAIN SELECT id FROM events WHERE summary ILIKE '%quarterlyreview%'");
      expect(summaryPlan).toContain("Bitmap Index Scan on events_summary_trgm_idx");

      const attendeesPlan = await explain(pg, "EXPLAIN SELECT id FROM events WHERE (extra ->> 'attendees') ILIKE '%zhangsan%'");
      expect(attendeesPlan).toContain("Bitmap Index Scan on events_attendees_trgm_idx");

      const hit = await pg.query<{ id: number }>("SELECT id FROM events WHERE (extra ->> 'attendees') ILIKE '%zhangsan%'");
      expect(hit.rows).toEqual([{ id: 90001 }]);
    } finally {
      await pg.close();
    }
  }, 120_000);
});

describe("没装 pg_trgm 时（集成测试的默认 PGlite）", () => {
  it("迁移不抛错、索引缺席、ILIKE 结果照常正确", async () => {
    const pg = new PGlite();
    try {
      await makeEventsTable(pg);
      await applyMigration(pg); // 不许抛：DO + EXCEPTION 兜底要生效
      const names = await indexNames(pg);
      expect(names.filter((n) => n.includes("trgm"))).toEqual([]);

      await pg.query(
        "INSERT INTO events VALUES (1, '项目周会', null, null, '{\"attendees\":[\"zhangsan@example.com\"]}'::jsonb)",
      );
      const hit = await pg.query<{ id: number }>("SELECT id FROM events WHERE (extra ->> 'attendees') ILIKE '%zhangsan%'");
      expect(hit.rows).toEqual([{ id: 1 }]);
    } finally {
      await pg.close();
    }
  }, 120_000);
});
