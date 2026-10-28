// 恢复备份：「备份里缺、库里有数据」的那几张表，数之前先锁住 —— 在真 Postgres（PGlite）里看锁。
//
// ── 这条在防什么 ────────────────────────────────────────────────────────
// importData 先数缺的表在库里有几行（有数据又没被站长确认 → 拦下），再整库清空、按文件插回。
// 以前的注释说「在同一个事务里数，免得数的时候是空的、删的时候已经有了」—— 这在默认的
// READ COMMITTED 下不成立：事务里每条语句各拿各的快照，数完 0 行之后别的连接照样能插进来
// 并提交（恰好有人在 App 里登录，devices 多一行），下面那条 DELETE 把它一起删掉，
// 拦截页上没出现过、站长也没确认过。
//
// 现在数之前对缺的表拿 SHARE ROW EXCLUSIVE：和 INSERT / UPDATE / DELETE 要的 ROW EXCLUSIVE
// 互斥，和 SELECT 不冲突，一直拿到事务结束。
//
// ── 为什么是看 pg_locks，而不是真起两个连接去抢 ─────────────────────────
// PGlite 只有一个连接，造不出真并发。pg_locks 是 Postgres 自己的锁表：锁拿没拿到、拿的是
// 什么模式，看它最直接；「这个模式和写入互斥」是 Postgres 文档里的锁冲突表，下面把它写成断言。

import { vi, beforeAll, beforeEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

import { sql, type SQL } from "drizzle-orm";
import { ensureSchema, resetDb, db, makeUser } from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";

const { exportData, importData, lockAndCountAbsentTables, RestoreNeedsConfirmationError } = await import("../../src/lib/backup.js");

beforeAll(async () => { await ensureSchema(); });
beforeEach(async () => { await resetDb(); });

/** 和 INSERT / UPDATE / DELETE（RowExclusiveLock）互斥、又不挡 SELECT（AccessShareLock）的模式。 */
const BLOCKS_WRITES_NOT_READS = new Set(["ShareLock", "ShareRowExclusiveLock", "ExclusiveLock"]);

async function locksHeld(tx: { execute(q: SQL): Promise<unknown> }, tables: string[]): Promise<Record<string, string[]>> {
  const res = await tx.execute(sql`
    SELECT c.relname AS rel, l.mode AS mode
      FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
     WHERE l.pid = pg_backend_pid() AND l.granted AND c.relname IN ${sql`(${sql.join(tables.map((t) => sql`${t}`), sql`, `)})`}`);
  const rows = (res as unknown as { rows: Array<{ rel: string; mode: string }> }).rows;
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[r.rel] ??= []).push(r.mode);
  return out;
}

/** 测试里 db 是 PGlite 的 drizzle，类型上和生产的 postgres-js 不是同一个；运行时 src/db/client.js
 *  已经被 mock 成同一个 PGlite 实例（importData 里用的也是它），这里只是把类型对上。 */
const asProdTx = (tx: unknown) => tx as Parameters<typeof lockAndCountAbsentTables>[0];

async function oldBundle(...drop: string[]) {
  const bundle = JSON.parse(JSON.stringify(await exportData()));
  for (const t of drop) delete bundle.tables[t];
  return bundle;
}

describe("数「缺的表有没有数据」之前先锁住", () => {
  it("**缺的表拿到的是挡写不挡读的锁，文件里有的表不额外锁**", async () => {
    await makeUser("a@example.com");
    const bundle = await oldBundle("devices", "bookings");
    const held = await db.transaction(async (tx) => {
      await lockAndCountAbsentTables(asProdTx(tx), bundle);
      return locksHeld(tx, ["devices", "bookings", "users"]);
    });
    for (const t of ["devices", "bookings"]) {
      expect(
        (held[t] ?? []).some((m) => BLOCKS_WRITES_NOT_READS.has(m)),
        `${t} 在数之前没有被锁成「挡写」的模式（实际：${JSON.stringify(held[t] ?? [])}）—— ` +
          "READ COMMITTED 下数完之后别人还能插进来，下面的 DELETE 会把没出现在拦截页上的行一起删掉",
      ).toBe(true);
      expect(held[t] ?? [], `${t} 被锁成了连读都挡的模式，恢复期间整站读不了`).not.toContain("AccessExclusiveLock");
    }
    // 文件里有的表会按文件整张替换，数不数都一样，不需要在这一步锁。
    expect((held.users ?? []).some((m) => BLOCKS_WRITES_NOT_READS.has(m))).toBe(false);
  });

  it("文件里一张都不缺 → 不锁任何东西，也不数", async () => {
    const bundle = await oldBundle();
    const { held, atRisk } = await db.transaction(async (tx) => {
      const atRisk = await lockAndCountAbsentTables(asProdTx(tx), bundle);
      return { atRisk, held: await locksHeld(tx, ["devices", "bookings", "users"]) };
    });
    expect(atRisk).toEqual([]);
    expect(Object.values(held).flat().filter((m) => BLOCKS_WRITES_NOT_READS.has(m))).toEqual([]);
  });

  it("加了锁之后，拦截和恢复的结果不变（被拦：一行不动；没数据：照常恢复）", async () => {
    const u = await makeUser("a@example.com");
    const { db: _db, schema } = await import("./harness.js");
    await _db.insert(schema.devices).values({
      userId: u.id, label: "iPhone", kind: "ios", refreshTokenHash: "h", refreshTokenPrefix: "bwd_abcdefgh_", lastSeenAt: new Date(),
    });
    const bundle = await oldBundle("devices");
    await expect(importData(bundle)).rejects.toBeInstanceOf(RestoreNeedsConfirmationError);
    expect((await _db.select().from(schema.devices)).length, "被拦下之前 devices 已经被清空了").toBe(1);
    const ok = await importData(await oldBundle("push_subscriptions"));
    expect(ok.ok).toBe(true);
  });
});
