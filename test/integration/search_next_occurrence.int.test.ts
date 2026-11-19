// 搜索结果带 nextStartsAt：重复事件显示下一次发生，不再是系列开始那天。
//
// 契约：
//   · startsAt 一个字不变（还是系列开始，老客户端读到的形状不变）；
//   · nextStartsAt 只对重复事件算：从现在起第一次发生的开始时刻；
//   · 系列已经结束（COUNT 用完 / UNTIL 已过）→ null，前端回落 startsAt；
//   · 非重复事件 → null。
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
let cal: Awaited<ReturnType<typeof makeCalendar>>;

beforeEach(async () => {
  await resetDb();
  app = await buildRoutedApp(async (a) => { await searchRoutes(a); }, { prefix: "/api" });
  const user = await makeUser("searcher@example.com");
  cal = await makeCalendar(user.id);
  cookie = await loginAs(app, user.id);
});
afterEach(async () => { await app.close(); });

type Row = Record<string, unknown>;

async function seed(values: Partial<typeof schema.events.$inferInsert>) {
  const [row] = await db.insert(schema.events).values({
    calendarId: cal.id,
    uid: `u-${Math.random().toString(36).slice(2)}@example.com`,
    summary: "项目周会",
    startsAt: new Date("2025-01-06T01:00:00.000Z"),
    endsAt: new Date("2025-01-06T02:00:00.000Z"),
    ...values,
  }).returning();
  return row!;
}

async function search(q: string): Promise<{ events: Row[] }> {
  const res = await app.inject({ method: "GET", url: `/api/search?q=${encodeURIComponent(q)}`, headers: { cookie } });
  expect(res.statusCode, `搜索失败: ${res.body.slice(0, 200)}`).toBe(200);
  return JSON.parse(res.body) as { events: Row[] };
}

const DAY = 86_400_000;

describe("搜索结果的 nextStartsAt", () => {
  it("去年开始的每周事件：nextStartsAt 是未来一周内的下一次，startsAt 仍是系列开始", async () => {
    // 系列开始放在 370 天前的此刻之后 2 小时：之后每 7 天一次，
    // 下一次必然落在 (now, now + 7 天] 里，且与系列开始相差整周数。
    // 截到整秒：展开时 DTSTART 本来就会抹掉毫秒（rrule_expand.ts），
    // 种子带毫秒的话相位对不齐是测试自己的错，不是展开的错。
    const start = new Date(Math.floor((Date.now() - 370 * DAY + 2 * 3_600_000) / 1000) * 1000);
    const ev = await seed({
      startsAt: start,
      endsAt: new Date(start.getTime() + 3_600_000),
      rrule: "FREQ=WEEKLY",
    });
    const res = await search("周会");
    const hit = res.events.find((e) => e.id === ev!.id);
    expect(hit, "没搜到这个事件").toBeTruthy();
    expect(hit!.startsAt).toBe(start.toISOString()); // 系列开始，不变
    const next = new Date(hit!.nextStartsAt as string).getTime();
    expect(next).toBeGreaterThan(Date.now() - 60_000);
    expect(next).toBeLessThanOrEqual(Date.now() + 7 * DAY + 60_000);
    expect((next - start.getTime()) % (7 * DAY)).toBe(0); // 整周偏移，相位没变
  });

  it("非重复事件 nextStartsAt 为 null", async () => {
    const ev = await seed({});
    const res = await search("周会");
    const hit = res.events.find((e) => e.id === ev!.id);
    expect(hit!.nextStartsAt).toBeNull();
  });

  it("系列已经结束（COUNT 早用完）→ nextStartsAt 为 null", async () => {
    const ev = await seed({ rrule: "FREQ=WEEKLY;COUNT=4" }); // 2025 年 1 月就开完了
    const res = await search("周会");
    const hit = res.events.find((e) => e.id === ev!.id);
    expect(hit, "没搜到这个事件").toBeTruthy();
    expect(hit!.nextStartsAt).toBeNull();
  });

  it("被删掉的那一次（exdates）不算下一次", async () => {
    const start = new Date(Math.floor((Date.now() - 370 * DAY + 2 * 3_600_000) / 1000) * 1000);
    // 先算出「本来该是下一次」的时刻，把它删掉，下一次应顺延一周。
    const firstNext = start.getTime() + Math.ceil((Date.now() - start.getTime()) / (7 * DAY)) * 7 * DAY;
    const ev = await seed({
      startsAt: start,
      endsAt: new Date(start.getTime() + 3_600_000),
      rrule: "FREQ=WEEKLY",
      exdates: [new Date(firstNext).toISOString()],
    });
    const res = await search("周会");
    const hit = res.events.find((e) => e.id === ev!.id);
    const next = new Date(hit!.nextStartsAt as string).getTime();
    expect(next).toBe(firstNext + 7 * DAY);
  });

  it("结果里仍然不带 extra / rawIcs（算 nextStartsAt 用的内部字段不许漏出去）", async () => {
    await seed({ rrule: "FREQ=WEEKLY", extra: { attendees: ["a@example.com"], meetingPassword: "889900" } });
    const res = await search("周会");
    expect(res.events.length).toBe(1);
    expect(res.events[0]).not.toHaveProperty("extra");
    expect(res.events[0]).not.toHaveProperty("rawIcs");
    expect(JSON.stringify(res.events[0])).not.toContain("889900");
  });
});
