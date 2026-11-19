// ICS 导入批量化的回归测试：upsertEvents 从「逐条 SELECT + INSERT」改成
// 「按 uid 分块预查 + 多行 upsert 分块落库」之后，对外语义必须逐条不变 ——
// 计数（inserted / updated / skipped）、内容没变不刷新 updatedAt、软删不复活、
// 短 uid 合成规则幂等、同一文件里重复 uid 按出现顺序后者覆盖前者。
//
// 为什么必须走真 DB：这些语义全在 SQL 层（唯一索引冲突、xmax 判定、jsonb 读回
// 的键序），纯逻辑测试看不见。2000 条那条同时是性能回归线：逐条往返的旧实现
// 在 PGlite 上要跑几十秒，批量后应回到秒级。
import { vi, beforeAll, beforeEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

import { and, eq, isNull, sql } from "drizzle-orm";
import { ensureSchema, resetDb, db, schema, makeUser, makeCalendar } from "./harness.js";
import { importIcsText } from "../../src/lib/ics_import.js";

beforeAll(async () => { await ensureSchema(); });
beforeEach(async () => { await resetDb(); });

const CRLF = "\r\n";

function vevent(uid: string, summary: string, day: number, extra: string[] = []): string[] {
  const d = String(day).padStart(2, "0");
  return [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `SUMMARY:${summary}`,
    `DTSTART:202607${d}T090000Z`,
    `DTEND:202607${d}T100000Z`,
    ...extra,
    "END:VEVENT",
  ];
}

function icsOf(blocks: string[][]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//batch//EN", ...blocks.flat(), "END:VCALENDAR"].join(CRLF) + CRLF;
}

/** N 条互不相同的一次性事件，uid 都 ≥ 8 字符（不触发短 uid 合成）。 */
function bulkIcs(n: number, summaryPrefix = "批量事件"): string {
  const blocks: string[][] = [];
  for (let i = 0; i < n; i++) {
    blocks.push(vevent(`bulk-uid-${String(i).padStart(6, "0")}@example.com`, `${summaryPrefix} ${i}`, (i % 28) + 1));
  }
  return icsOf(blocks);
}

async function countRows(calendarId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.events)
    .where(eq(schema.events.calendarId, calendarId));
  return r!.n;
}

async function rowByUid(calendarId: string, uid: string) {
  const [r] = await db
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.calendarId, calendarId), eq(schema.events.uid, uid)));
  return r;
}

describe("大文件导入：计数与幂等", () => {
  it("2000 条首次导入全 inserted，再导一次全 skipped 且不刷新 updatedAt", async () => {
    const user = await makeUser("bulk@example.com");
    const cal = await makeCalendar(user.id);
    const text = bulkIcs(2000);

    const t0 = Date.now();
    const first = await importIcsText(cal.id, text, { sourceTag: "file:bulk.ics" });
    const firstMs = Date.now() - t0;
    expect(first).toEqual({ inserted: 2000, updated: 0, skipped: 0, total: 2000 });
    expect(await countRows(cal.id)).toBe(2000);

    const probeBefore = await rowByUid(cal.id, "bulk-uid-000123@example.com");
    expect(probeBefore).toBeTruthy();

    const t1 = Date.now();
    const second = await importIcsText(cal.id, text, { sourceTag: "file:bulk.ics" });
    const secondMs = Date.now() - t1;
    expect(second).toEqual({ inserted: 0, updated: 0, skipped: 2000, total: 2000 });
    expect(await countRows(cal.id)).toBe(2000);

    // 内容没变就不许动 updatedAt（CalDAV etag 挂在它上面，动一下客户端就 412）。
    const probeAfter = await rowByUid(cal.id, "bulk-uid-000123@example.com");
    expect(probeAfter!.updatedAt.getTime()).toBe(probeBefore!.updatedAt.getTime());

    // 性能回归线只打日志不做断言：CI 机器快慢不一，硬断言会误报；
    // 逐条往返的旧实现在这台机器上是十几秒量级，批量后应为秒级。
    console.log(`[ics-import-batch] first=${firstMs}ms second=${secondMs}ms (2000 events)`);
  }, 180_000);

  it("改了其中 10 条标题再导入：updated=10，其余 skipped", async () => {
    const user = await makeUser("bulk2@example.com");
    const cal = await makeCalendar(user.id);
    await importIcsText(cal.id, bulkIcs(2000));

    const blocks: string[][] = [];
    for (let i = 0; i < 2000; i++) {
      const summary = i < 10 ? `改过的标题 ${i}` : `批量事件 ${i}`;
      blocks.push(vevent(`bulk-uid-${String(i).padStart(6, "0")}@example.com`, summary, (i % 28) + 1));
    }
    const res = await importIcsText(cal.id, icsOf(blocks));
    expect(res).toEqual({ inserted: 0, updated: 10, skipped: 1990, total: 2000 });
    expect((await rowByUid(cal.id, "bulk-uid-000003@example.com"))!.summary).toBe("改过的标题 3");
    expect((await rowByUid(cal.id, "bulk-uid-000100@example.com"))!.summary).toBe("批量事件 100");
  }, 180_000);
});

describe("批量后仍要成立的逐条语义", () => {
  it("同一文件里同 uid 出现两次：按顺序后者覆盖，计数 inserted+updated", async () => {
    const user = await makeUser("dup@example.com");
    const cal = await makeCalendar(user.id);
    const text = icsOf([
      vevent("dup-uid-0001@example.com", "第一版标题", 3),
      vevent("other-uid-01@example.com", "无关事件", 4),
      vevent("dup-uid-0001@example.com", "第二版标题", 3),
    ]);
    const res = await importIcsText(cal.id, text);
    expect(res).toEqual({ inserted: 2, updated: 1, skipped: 0, total: 3 });
    expect(await countRows(cal.id)).toBe(2);
    expect((await rowByUid(cal.id, "dup-uid-0001@example.com"))!.summary).toBe("第二版标题");
  });

  it("同一文件里同 uid 同内容出现两次：inserted + skipped，不重复落行", async () => {
    const user = await makeUser("dup2@example.com");
    const cal = await makeCalendar(user.id);
    const text = icsOf([
      vevent("same-uid-001@example.com", "同一个事件", 5),
      vevent("same-uid-001@example.com", "同一个事件", 5),
    ]);
    const res = await importIcsText(cal.id, text);
    expect(res).toEqual({ inserted: 1, updated: 0, skipped: 1, total: 2 });
    expect(await countRows(cal.id)).toBe(1);
  });

  it("已软删的行不复活：再导入计 skipped，deletedAt 还在", async () => {
    const user = await makeUser("softdel@example.com");
    const cal = await makeCalendar(user.id);
    const text = icsOf([vevent("ghost-uid-01@example.com", "删过的事件", 6)]);
    await importIcsText(cal.id, text);
    await db
      .update(schema.events)
      .set({ deletedAt: new Date() })
      .where(eq(schema.events.uid, "ghost-uid-01@example.com"));

    const res = await importIcsText(cal.id, text);
    expect(res).toEqual({ inserted: 0, updated: 0, skipped: 1, total: 1 });
    const row = await rowByUid(cal.id, "ghost-uid-01@example.com");
    expect(row!.deletedAt).not.toBeNull();
  });

  it("短 uid 合成稳定：两次导入落在同一行，第二次 skipped", async () => {
    const user = await makeUser("shortuid@example.com");
    const cal = await makeCalendar(user.id);
    const text = icsOf([vevent("abc123", "短 uid 事件", 7)]);
    const first = await importIcsText(cal.id, text);
    expect(first.inserted).toBe(1);
    const second = await importIcsText(cal.id, text);
    expect(second).toEqual({ inserted: 0, updated: 0, skipped: 1, total: 1 });
    expect(await countRows(cal.id)).toBe(1);
    const rows = await db
      .select({ uid: schema.events.uid })
      .from(schema.events)
      .where(and(eq(schema.events.calendarId, cal.id), isNull(schema.events.deletedAt)));
    expect(rows[0]!.uid.startsWith("abc123-")).toBe(true);
    expect(rows[0]!.uid.length).toBeGreaterThan(8);
  });

  it("上游没带 VALARM 时保留用户在本地加的提醒和分类", async () => {
    const user = await makeUser("keepalarm@example.com");
    const cal = await makeCalendar(user.id);
    const uid = "keep-alarm-1@example.com";
    await importIcsText(cal.id, icsOf([vevent(uid, "球赛", 8)]), { sourceTag: "sub:test" });
    // 模拟用户在本地给这个订阅事件加了提醒和分类。
    await db
      .update(schema.events)
      .set({ extra: { source: "sub:test", alarms: [{ trigger: "-PT30M", action: "DISPLAY" }], category: "sports" } })
      .where(eq(schema.events.uid, uid));

    const res = await importIcsText(cal.id, icsOf([vevent(uid, "球赛", 8)]), { sourceTag: "sub:test" });
    expect(res.skipped).toBe(1);
    const row = await rowByUid(cal.id, uid);
    const extra = row!.extra as { alarms?: unknown[]; category?: string };
    expect(extra.alarms).toHaveLength(1);
    expect(extra.category).toBe("sports");
  });
});
