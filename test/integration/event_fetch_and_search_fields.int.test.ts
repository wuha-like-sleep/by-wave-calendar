// 「手上只有半个事件」的客户端怎么把它补齐 —— 从 HTTP 打进去。
//
// ── 这条的形状 ────────────────────────────────────────────────────────
//
// 搜索结果按设计只回一部分字段（description 是特意不回的，见 routes/search.ts
// 文件头）。而客户端要把一条搜索结果变成可编辑的事件，缺的字段只能**自己编一个
// 默认值**——编出来的默认值随后会被当成用户的修改原样 PATCH 回去。
//
// iOS 上就是这样：搜索结果里没有 allDay，客户端填 false；没有 rrule，填 null。
// 于是从搜索结果点进去改一下标题：
//   · 全天事件当场变成定时事件，时间还会跟着时区挪；
//   · 重复事件因为看不见 rrule，不弹「改这一个还是整个系列」，整条系列被改掉。
// 全程不报任何错。
//
// 两条路一起堵：
//   ① 搜索结果补上 allDay / rrule —— 这两个字段没有隐私顾虑，且决定了「这条记录
//      该怎么解释」，缺了就只能靠猜；
//   ② 补上 GET /events/:id —— 客户端要完整的那一份时有地方拿，不用编。
//
// description 和 extra **不该**出现在搜索结果里：前者是文件头写明的隐私取舍，
// 后者装着入会密码。要完整内容就走 ①②里的第二条。

import { vi, beforeAll, beforeEach, afterEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

import type { FastifyInstance } from "fastify";
import {
  ensureSchema, resetDb, db, schema,
  makeUser, makeCalendar, makeMembership, buildRoutedApp, loginAs,
} from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const { eventRoutes } = await import("../../src/routes/events.js");
const { searchRoutes } = await import("../../src/routes/search.js");

beforeAll(async () => { await ensureSchema(); });

let app: FastifyInstance;
let cookie: string;
let user: Awaited<ReturnType<typeof makeUser>>;
let cal: Awaited<ReturnType<typeof makeCalendar>>;

beforeEach(async () => {
  await resetDb();
  // 两组路由注册在同一个实例上：这一档要在同一次会话里「先搜索、再按 id 取」。
  app = await buildRoutedApp(async (a) => {
    await eventRoutes(a);
    await searchRoutes(a);
  }, { prefix: "/api" });
  user = await makeUser("owner@example.com");
  cal = await makeCalendar(user.id);
  cookie = await loginAs(app, user.id);
});
afterEach(async () => { await app.close(); });

type Row = Record<string, unknown>;

async function seed(values: Partial<typeof schema.events.$inferInsert> = {}) {
  const [row] = await db.insert(schema.events).values({
    calendarId: cal.id,
    uid: `u-${Math.random().toString(36).slice(2)}@example.com`,
    summary: "季度复盘",
    startsAt: new Date("2026-07-14T00:00:00.000Z"),
    endsAt: new Date("2026-07-14T23:59:59.999Z"),
    ...values,
  }).returning();
  return row!;
}

async function searchOne(q = "季度复盘"): Promise<Row> {
  const res = await app.inject({ method: "GET", url: `/api/search?q=${encodeURIComponent(q)}`, headers: { cookie } });
  expect(res.statusCode, `搜索失败: ${res.body.slice(0, 200)}`).toBe(200);
  const body = JSON.parse(res.body) as { events: Row[] };
  expect(body.events.length, "搜索什么也没搜到 —— 下面的断言全是空的").toBeGreaterThan(0);
  return body.events[0]!;
}

describe("搜索结果要带上「该怎么解释这条记录」的字段", () => {
  it("搜得到（presence）", async () => {
    await seed();
    expect((await searchOne()).summary).toBe("季度复盘");
  });

  it("全天事件的 allDay 要回出来", async () => {
    await seed({ allDay: true });
    expect(
      (await searchOne()).allDay,
      "搜索结果没有 allDay —— 客户端只能填 false，" +
        "而这个编出来的 false 会被当成用户的修改存回去：全天事件当场变成定时事件",
    ).toBe(true);
  });

  it("定时事件的 allDay 也要回出来，而不是干脆没这个键", async () => {
    // 只测 true 的话，「永远回 true」这种改法照样绿。
    await seed({ allDay: false });
    const r = await searchOne();
    expect(r).toHaveProperty("allDay");
    expect(r.allDay).toBe(false);
  });

  it("重复事件的 rrule 要回出来", async () => {
    await seed({ rrule: "FREQ=WEEKLY;COUNT=5" });
    expect(
      (await searchOne()).rrule,
      "搜索结果没有 rrule —— 客户端不知道这是重复事件，" +
        "不会弹「改这一个还是整个系列」，于是整条系列被改掉",
    ).toBe("FREQ=WEEKLY;COUNT=5");
  });

  it("不重复的事件 rrule 是 null", async () => {
    await seed();
    expect((await searchOne()).rrule).toBeNull();
  });

  it("**description 仍然不回**（这是文件头写明的隐私取舍，不是漏了）", async () => {
    await seed({ description: "薪资调整草案，勿外传" });
    const r = await searchOne();
    expect(
      JSON.stringify(r),
      "私密备注被带进搜索结果列表了",
    ).not.toContain("薪资调整草案");
  });

  it("**extra 仍然不回**（里面有入会密码）", async () => {
    await seed({ extra: { meetingPassword: "hunter2", url: "https://meet.example.com/x" } });
    const r = await searchOne();
    expect(JSON.stringify(r), "入会密码进了搜索结果").not.toContain("hunter2");
  });
});

describe("按 id 取完整事件", () => {
  it("取得到，而且带着搜索结果没有的那些字段", async () => {
    const ev = await seed({
      description: "薪资调整草案，勿外传",
      extra: { url: "https://meet.example.com/x", meetingPassword: "hunter2", timezone: "Asia/Shanghai" },
      allDay: true,
    });
    const res = await app.inject({ method: "GET", url: `/api/events/${ev.id}`, headers: { cookie } });
    expect(res.statusCode, `取不到: ${res.body.slice(0, 300)}`).toBe(200);
    const body = JSON.parse(res.body) as Row;
    expect(body.id).toBe(ev.id);
    expect(body.description, "description 没回来 —— 客户端还是只能编一个").toBe("薪资调整草案，勿外传");
    expect((body.extra as Row | null)?.url).toBe("https://meet.example.com/x");
    expect((body.extra as Row | null)?.meetingPassword).toBe("hunter2");
    expect(body.allDay).toBe(true);
  });

  it("共享给我的日历上的事件也取得到 —— 搜索能搜到它", async () => {
    // 这条是真会咬人的：搜索的范围是「自己的 + 共享给自己的」，
    // 而按 id 单取如果只认 owner，就成了「搜得到、点进去 404」。
    const other = await makeUser("other@example.com");
    const theirCal = await makeCalendar(other.id, "他的日历");
    await makeMembership(theirCal.id, user.id);
    const [ev] = await db.insert(schema.events).values({
      calendarId: theirCal.id, uid: "shared@example.com", summary: "共享的会",
      startsAt: new Date("2026-07-15T01:00:00.000Z"), endsAt: new Date("2026-07-15T02:00:00.000Z"),
    }).returning();

    const found = await app.inject({ method: "GET", url: "/api/search?q=%E5%85%B1%E4%BA%AB%E7%9A%84%E4%BC%9A", headers: { cookie } });
    expect(JSON.parse(found.body).events.length, "搜索本来就搜不到它 —— 这条用例没测到东西").toBeGreaterThan(0);

    const res = await app.inject({ method: "GET", url: `/api/events/${ev!.id}`, headers: { cookie } });
    expect(res.statusCode, "搜得到却点不进去").toBe(200);
  });

  it("别人的事件取不到，而且是 404 不是 403", async () => {
    const other = await makeUser("stranger@example.com");
    const theirCal = await makeCalendar(other.id, "别人的日历");
    const [ev] = await db.insert(schema.events).values({
      calendarId: theirCal.id, uid: "private@example.com", summary: "别人的会",
      startsAt: new Date("2026-07-16T01:00:00.000Z"), endsAt: new Date("2026-07-16T02:00:00.000Z"),
    }).returning();
    const res = await app.inject({ method: "GET", url: `/api/events/${ev!.id}`, headers: { cookie } });
    expect(res.statusCode, "别人的事件被取到了").toBe(404);
  });

  it("没登录取不到", async () => {
    const ev = await seed();
    const res = await app.inject({ method: "GET", url: `/api/events/${ev.id}` });
    expect([401, 403]).toContain(res.statusCode);
  });

  it("已删除的事件取不到", async () => {
    const ev = await seed({ deletedAt: new Date() });
    const res = await app.inject({ method: "GET", url: `/api/events/${ev.id}`, headers: { cookie } });
    expect(res.statusCode, "回收站里的事件还能按 id 取出来").toBe(404);
  });
});
