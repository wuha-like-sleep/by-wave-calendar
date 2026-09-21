// 存量 extra 形状在**真实路由**上的行为：老行是 CalDAV / .ics 那一路写进去的，
// 形状和网页那一路对不上，而这三个 bug 的症状全是「没人报错，东西就是不对」。
//
// 为什么非得从 HTTP 打进去：这三处的错都不在函数里，在**调用点**——
//   ① zod schema 收得比库里存的严（`z.string().optional()` 不收 null），
//      只有真的把请求体喂给路由才看得见那个 400；
//   ② 参与者是 `Array.isArray(extra.attendees) ? … : []` 一路当字符串用，
//      直调 lib 函数的测试里没人会拿对象数组去喂它；
//   ③ 「读到的是什么」取决于路由发出去的响应体，不是库里那一行。
// 所以一律：真 Fastify + 真路由 + 真会话 cookie + 真 PGlite，断言读响应体和库里那一行。
import { vi, beforeAll, beforeEach, afterEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  ensureSchema, resetDb, db, schema,
  makeUser, makeCalendar, buildRoutedApp, loginAs,
} from "./harness.js";

// routes/events.ts 一路拉到 lib/mailer → env.ts，env 解析不过是 process.exit(1)：
// 整个 vitest 进程当场消失，连一条红都留不下。CI 上没有 .env，先兜底再动态 import。
process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const { eventRoutes } = await import("../../src/routes/events.js");

beforeAll(async () => { await ensureSchema(); });

let app: FastifyInstance;
let cookie: string;
let user: Awaited<ReturnType<typeof makeUser>>;
let cal: Awaited<ReturnType<typeof makeCalendar>>;

beforeEach(async () => {
  await resetDb();
  app = await buildRoutedApp(eventRoutes, { prefix: "/api" });   // 前缀和生产一致
  user = await makeUser("owner@example.com");
  cal = await makeCalendar(user.id);
  cookie = await loginAs(app, user.id);
});

afterEach(async () => { await app.close(); });

type Json = Record<string, unknown>;

function send(method: "POST" | "PATCH" | "GET" | "DELETE", url: string, payload?: Json) {
  return app.inject({
    method, url, headers: { cookie },
    ...(payload === undefined ? {} : { payload }),
  });
}

/**
 * 直接往库里塞一行「存量事件」——不能用 POST /api/events 造，那条路会把 extra 洗一遍，
 * 洗完就不是存量形状了，这套断言也就照不出任何东西。
 */
async function seedLegacyEvent(extra: unknown, uid = "legacy@example.com") {
  const [row] = await db.insert(schema.events).values({
    calendarId: cal.id,
    uid,
    summary: "季度复盘",
    startsAt: new Date("2026-07-14T01:00:00.000Z"),
    endsAt: new Date("2026-07-14T02:00:00.000Z"),
    extra: extra as object | null,
  }).returning();
  return row!;
}

/** 网页详情页读事件走的就是这条（GET /api/calendars/:id/events?eventId=…）。 */
async function fetchEvent(id: string): Promise<Json | undefined> {
  const res = await send("GET", `/api/calendars/${cal.id}/events?eventId=${id}`);
  expect(res.statusCode).toBe(200);
  return (res.json() as Json[])[0];
}

async function storedExtra(id: string): Promise<Record<string, unknown> | null> {
  const [row] = await db.select().from(schema.events).where(eq(schema.events.id, id)).limit(1);
  return (row?.extra ?? null) as Record<string, unknown> | null;
}

const extraOf = (row: Json | undefined) => (row?.extra ?? null) as Record<string, unknown> | null;

// CalDAV / .ics 存进去的提醒形状：老的 ical.ts parseEvent 取不到属性时写的是 null。
const LEGACY_ALARMS = [
  { trigger: "-PT15M", action: "DISPLAY", description: "提醒" },
  { trigger: "-P1D", action: null, description: null },
];
// CalDAV 存进去的参与者形状。
const LEGACY_ATTENDEES = [
  { email: "alice@example.com", cn: "Alice", role: "REQ-PARTICIPANT", partstat: "ACCEPTED" },
  { email: "bob@example.com", cn: null, role: null, partstat: null },
];

// ---------------------------------------------------------------------------

describe("问题一 · 存量事件在网页上一保存就 400", () => {
  it("action / description 是 null 的提醒，原样回传能存下去", async () => {
    const row = await seedLegacyEvent({ alarms: LEGACY_ALARMS, timezone: "Asia/Shanghai" });

    // 网页打开这个事件、只改了标题：extra 里的 alarms 是从 GET 里拿到的那份，原样回传。
    const before = extraOf(await fetchEvent(row.id));
    const res = await send("PATCH", `/api/events/${row.id}`, {
      summary: "季度复盘（改期）",
      extra: { ...before, alarms: before?.alarms },
    });

    expect(res.statusCode).toBe(200);
    // 两条提醒都还在，null 的那两个字段被洗掉（normalizeAlarms 本来就会丢）。
    expect((await storedExtra(row.id))?.alarms).toEqual([
      { trigger: "-PT15M", action: "DISPLAY", description: "提醒" },
      { trigger: "-P1D" },
    ]);
  });

  it("老口径存进去的垃圾 trigger 也不再把用户锁在门外，但新设的垃圾照旧 400", async () => {
    // trigger 以前是「max(50) 的任意字符串」，"banana" 一路 200 存进去过。
    const row = await seedLegacyEvent({ alarms: [{ trigger: "banana" }, { trigger: "-PT15M" }] });

    const ok = await send("PATCH", `/api/events/${row.id}`, {
      summary: "改个标题",
      extra: { alarms: [{ trigger: "banana" }, { trigger: "-PT15M" }] },
    });
    expect(ok.statusCode).toBe(200);
    expect((await storedExtra(row.id))?.alarms).toEqual([{ trigger: "-PT15M" }]);

    // 这次是客户端**新设**的一条认不出来的提醒 —— 口径没松，照旧 400。
    const bad = await send("PATCH", `/api/events/${row.id}`, {
      extra: { alarms: [{ trigger: "-PT15M" }, { trigger: "durian" }] },
    });
    expect(bad.statusCode).toBe(400);
    expect(String((bad.json() as Json).message)).toContain("durian");
  });
});

describe("问题三 · 参与者在网页和 CalDAV 之间的两种形状", () => {
  it("手机上加的参与者，网页读到的是邮箱列表（而不是一串 [object Object]）", async () => {
    const row = await seedLegacyEvent({ attendees: LEGACY_ATTENDEES, category: "工作" });

    const extra = extraOf(await fetchEvent(row.id));
    expect(extra?.attendees).toEqual(["alice@example.com", "bob@example.com"]);
    // 别把不相干的键弄丢了。
    expect(extra?.category).toBe("工作");
  });

  it("网页保存一次不会把参与者弄没 —— 而且顺手把这一行的形状收口了", async () => {
    const row = await seedLegacyEvent({ attendees: LEGACY_ATTENDEES });

    // 网页拿到什么就回传什么（这正是修好之后的真实请求体）。
    const before = extraOf(await fetchEvent(row.id));
    const res = await send("PATCH", `/api/events/${row.id}`, {
      summary: "季度复盘（改期）",
      extra: before,
    });
    expect(res.statusCode).toBe(200);
    expect((await storedExtra(row.id))?.attendees).toEqual(["alice@example.com", "bob@example.com"]);
  });

  it("这次请求压根没提参与者时也收口（任何一次写入都是一次就地迁移）", async () => {
    const row = await seedLegacyEvent({ attendees: LEGACY_ATTENDEES });
    const res = await send("PATCH", `/api/events/${row.id}`, {
      summary: "只改标题", extra: { category: "工作" },
    });
    expect(res.statusCode).toBe(200);
    expect((await storedExtra(row.id))?.attendees).toEqual(["alice@example.com", "bob@example.com"]);
  });

  it("客户端把缓存里那份对象形状原样回传也存得下去，落库仍是邮箱数组", async () => {
    // 老版本 App / 还没重新拉过的网页手上就是这份形状。schema 放行两种写法，
    // 但库里只留一种 —— 否则它就是「存得进去、下一个读的人读不出来」。
    const row = await seedLegacyEvent({ attendees: LEGACY_ATTENDEES });
    const res = await send("PATCH", `/api/events/${row.id}`, {
      summary: "改个标题",
      extra: { attendees: LEGACY_ATTENDEES },
    });
    expect(res.statusCode).toBe(200);
    expect((await storedExtra(row.id))?.attendees).toEqual(["alice@example.com", "bob@example.com"]);
  });

  it("PATCH 的响应体本身也是收口后的 —— 客户端拿它当新状态用", async () => {
    // 只改标题、压根不提 extra：那一列根本不写，库里那份存量对象数组原样留着，
    // 于是「写入时顺手收口」这条兜不住它。已经发出去的桌面端 / 安卓把 attendees
    // 声明成 List<String>，响应体里是对象数组就是整份反序列化失败。
    const row = await seedLegacyEvent({ attendees: LEGACY_ATTENDEES });
    const res = await send("PATCH", `/api/events/${row.id}`, { summary: "只改标题" });
    expect(res.statusCode).toBe(200);
    expect(extraOf(res.json() as Json)?.attendees).toEqual(["alice@example.com", "bob@example.com"]);
  });

  it("移除参与者：手机同步来的事件也删得掉", async () => {
    const row = await seedLegacyEvent({ attendees: LEGACY_ATTENDEES });

    const res = await send("DELETE", `/api/events/${row.id}/attendees`, { email: "alice@example.com" });
    expect(res.statusCode).toBe(200);
    expect((await storedExtra(row.id))?.attendees).toEqual(["bob@example.com"]);

    // 这一页上也得真的少一个人。
    const listed = await send("GET", `/api/events/${row.id}/attendees`);
    expect((listed.json() as { attendees: string[] }).attendees).toEqual(["bob@example.com"]);
  });

  it("已经在列表里的人再邀请一次是 409，不会重复发一封邀请邮件", async () => {
    const row = await seedLegacyEvent({ attendees: LEGACY_ATTENDEES });

    const res = await send("POST", `/api/events/${row.id}/attendees`, { email: "alice@example.com" });
    expect(res.statusCode).toBe(409);
    expect((res.json() as Json).error).toBe("already_invited");

    // 409 是在发信之前返回的：一行邀请令牌都不该落库（令牌行 = 发过一封信）。
    const tokens = await db.select().from(schema.eventInviteTokens)
      .where(eq(schema.eventInviteTokens.sourceEventId, row.id));
    expect(tokens).toHaveLength(0);
  });

  it("邀请一个新人：存量对象形状的那一行也被收口成邮箱数组", async () => {
    const row = await seedLegacyEvent({ attendees: LEGACY_ATTENDEES });

    const res = await send("POST", `/api/events/${row.id}/attendees`, { email: "carol@example.com" });
    expect(res.statusCode).toBe(200);
    expect((await storedExtra(row.id))?.attendees)
      .toEqual(["alice@example.com", "bob@example.com", "carol@example.com"]);

    const tokens = await db.select().from(schema.eventInviteTokens).where(and(
      eq(schema.eventInviteTokens.sourceEventId, row.id),
      eq(schema.eventInviteTokens.recipientEmail, "carol@example.com"),
    ));
    expect(tokens).toHaveLength(1);
  });
});
