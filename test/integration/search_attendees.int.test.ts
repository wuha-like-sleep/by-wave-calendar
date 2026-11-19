// 搜索补上参与人：extra.attendees 里的邮箱（人名部分）也要能搜到事件。
//
// 边界（和 routes/search.ts 文件头的规矩一致）：
//   · 参与人只参与 WHERE —— 搜索结果仍然不返回 extra（里面有入会密码）；
//   · 隔离不变：别人日历上的事件，哪怕参与人对得上，也搜不到；
//   · 词间 AND 不变：一个词在标题、一个词在参与人里，合起来要能命中；
//     参与人对上但另一个词哪儿都没有，就不该出现。
import { vi, beforeAll, beforeEach, afterEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

import type { FastifyInstance } from "fastify";
import {
  ensureSchema, resetDb, db, schema,
  makeUser, makeCalendar, buildRoutedApp, loginAs,
} from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://unused:unused@localhost:5432/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const { searchRoutes } = await import("../../src/routes/search.js");

beforeAll(async () => { await ensureSchema(); });

let app: FastifyInstance;
let cookie: string;
let user: Awaited<ReturnType<typeof makeUser>>;
let cal: Awaited<ReturnType<typeof makeCalendar>>;

beforeEach(async () => {
  await resetDb();
  app = await buildRoutedApp(async (a) => { await searchRoutes(a); }, { prefix: "/api" });
  user = await makeUser("searcher@example.com");
  cal = await makeCalendar(user.id);
  cookie = await loginAs(app, user.id);
});
afterEach(async () => { await app.close(); });

type Row = Record<string, unknown>;

async function seed(values: Partial<typeof schema.events.$inferInsert> = {}) {
  const [row] = await db.insert(schema.events).values({
    calendarId: cal.id,
    uid: `u-${Math.random().toString(36).slice(2)}@example.com`,
    summary: "项目周会",
    startsAt: new Date("2026-07-14T01:00:00.000Z"),
    endsAt: new Date("2026-07-14T02:00:00.000Z"),
    ...values,
  }).returning();
  return row!;
}

async function search(q: string): Promise<{ events: Row[] }> {
  const res = await app.inject({ method: "GET", url: `/api/search?q=${encodeURIComponent(q)}`, headers: { cookie } });
  expect(res.statusCode, `搜索失败: ${res.body.slice(0, 200)}`).toBe(200);
  return JSON.parse(res.body) as { events: Row[] };
}

describe("按参与人搜事件", () => {
  it("标题里没有、只在 attendees 里出现的人名能搜到", async () => {
    const ev = await seed({ extra: { attendees: ["zhangsan@example.com", "lisi@example.com"] } });
    const byName = await search("zhangsan");
    expect(byName.events.map((e) => e.id)).toContain(ev!.id);
    const byDomain = await search("lisi@example");
    expect(byDomain.events.map((e) => e.id)).toContain(ev!.id);
  });

  it("参与人命中的结果里仍然不带 extra（入会密码不能借搜索漏出去）", async () => {
    await seed({ extra: { attendees: ["zhangsan@example.com"], meetingPassword: "889900" } });
    const res = await search("zhangsan");
    expect(res.events.length).toBe(1);
    expect(res.events[0]).not.toHaveProperty("extra");
    expect(JSON.stringify(res.events[0])).not.toContain("889900");
  });

  it("词间 AND 跨字段成立：一个词在标题、一个词在参与人", async () => {
    const ev = await seed({ extra: { attendees: ["wangwu@example.com"] } });
    const hit = await search("周会 wangwu");
    expect(hit.events.map((e) => e.id)).toContain(ev!.id);
    const miss = await search("周会 zhaoliu");
    expect(miss.events.map((e) => e.id)).not.toContain(ev!.id);
  });

  it("没有 attendees 的事件不会被参与人词误命中", async () => {
    await seed({ extra: { category: "work" } });
    await seed({});
    const res = await search("zhangsan");
    expect(res.events).toHaveLength(0);
  });

  it("别人日历上的事件，参与人对得上也搜不到（隔离不变）", async () => {
    const other = await makeUser("other@example.com");
    const otherCal = await makeCalendar(other.id);
    await db.insert(schema.events).values({
      calendarId: otherCal.id,
      uid: "other-ev-1@example.com",
      summary: "别人的会",
      startsAt: new Date("2026-07-14T01:00:00.000Z"),
      endsAt: new Date("2026-07-14T02:00:00.000Z"),
      extra: { attendees: ["zhangsan@example.com"] },
    });
    const res = await search("zhangsan");
    expect(res.events).toHaveLength(0);
  });

  it("中文短词照旧能搜到（短词回落 ILIKE 的语义不变）", async () => {
    const ev = await seed({});
    const res = await search("周会");
    expect(res.events.map((e) => e.id)).toContain(ev!.id);
  });
});
