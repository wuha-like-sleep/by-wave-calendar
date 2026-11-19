// GET /events 的缓存协商：private, no-cache + ETag。
//
// 为什么从 no-store 改过来：网页每 30 秒轮询一次当前窗口，绝大多数时候数据没变。
// no-store 让浏览器连存都不许存，每次轮询都是整份 JSON 全量下载；改成
// private, no-cache 后浏览器可以存，但用前必须拿 ETag 回来核对，没变就是一个
// 304 空响应。省的是带宽和解析，不是新鲜度 —— 核对在服务端算令牌那一步，
// 令牌由「这个人能看的日历集合」的内容算出来。
//
// 红线（这组测试存在的理由）：
//   · 304 只能在内容真的没变时回；变了必须 200 带新数据；
//   · 换一个用户拿着上一个用户的 ETag 来问，只能拿到自己的数据（200），
//     绝不能因为令牌「碰巧被拿来核对」就回 304 把人挡在自己数据之外，
//     更不能把前一个人的数据发出去。
import { vi, beforeAll, beforeEach, afterEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  ensureSchema, resetDb, db, schema,
  makeUser, makeCalendar, buildRoutedApp, loginAs,
} from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://unused:unused@localhost:5432/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const { eventRoutes } = await import("../../src/routes/events.js");

beforeAll(async () => { await ensureSchema(); });

const FROM = "2026-07-01T00:00:00Z";
const TO = "2026-07-31T23:59:59Z";
const URL = `/api/events?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`;

let app: FastifyInstance;

beforeEach(async () => {
  await resetDb();
  app = await buildRoutedApp(async (a) => { await eventRoutes(a); }, { prefix: "/api" });
});
afterEach(async () => { await app.close(); });

async function seedUserWithEvent(email: string, summary: string) {
  const user = await makeUser(email);
  const cal = await makeCalendar(user.id);
  const [ev] = await db.insert(schema.events).values({
    calendarId: cal.id,
    uid: `u-${email}`,
    summary,
    startsAt: new Date("2026-07-14T01:00:00.000Z"),
    endsAt: new Date("2026-07-14T02:00:00.000Z"),
  }).returning();
  const cookie = await loginAs(app, user.id);
  return { user, cal, ev: ev!, cookie };
}

type EventsBody = { events: Array<{ summary: string }> };

async function getEvents(cookie: string, ifNoneMatch?: string) {
  return app.inject({
    method: "GET",
    url: URL,
    headers: { cookie, ...(ifNoneMatch ? { "if-none-match": ifNoneMatch } : {}) },
  });
}

describe("GET /events 缓存协商", () => {
  it("响应头是 private, no-cache 并带 ETag（不再是 no-store）", async () => {
    const { cookie } = await seedUserWithEvent("a@example.com", "甲的会");
    const res = await getEvents(cookie);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-cache");
    expect(typeof res.headers.etag).toBe("string");
    expect((res.headers.etag as string).length).toBeGreaterThan(0);
  });

  it("内容没变时带 If-None-Match 回 304、空 body", async () => {
    const { cookie } = await seedUserWithEvent("a@example.com", "甲的会");
    const first = await getEvents(cookie);
    const tag = first.headers.etag as string;
    const second = await getEvents(cookie, tag);
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe("");
  });

  it("内容变了之后旧令牌必须拿到 200 和新数据，不能是 304", async () => {
    const { cookie, ev } = await seedUserWithEvent("a@example.com", "甲的会");
    const first = await getEvents(cookie);
    const tag = first.headers.etag as string;

    await db.update(schema.events)
      .set({ summary: "改过的会", updatedAt: new Date() })
      .where(eq(schema.events.id, ev.id));

    const res = await getEvents(cookie, tag);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as EventsBody;
    expect(body.events.map((e) => e.summary)).toContain("改过的会");
    expect(res.headers.etag).not.toBe(tag);
  });

  it("换用户拿着前一个用户的 ETag 来问：回自己的 200，绝不回 304、绝不串数据", async () => {
    const a = await seedUserWithEvent("a@example.com", "甲的会");
    const b = await seedUserWithEvent("b@example.com", "乙的会");

    const aFirst = await getEvents(a.cookie);
    const aTag = aFirst.headers.etag as string;

    // 同一个「浏览器」里换了账号：缓存里还留着甲的令牌，拿它去核对乙的请求。
    const res = await getEvents(b.cookie, aTag);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as EventsBody;
    expect(body.events.map((e) => e.summary)).toEqual(["乙的会"]);
    expect(body.events.map((e) => e.summary)).not.toContain("甲的会");
    // 乙自己的令牌和甲的不同 —— 两人的令牌由各自的日历集合算出来。
    expect(res.headers.etag).not.toBe(aTag);
  });

  it("弱令牌（代理改写过的 W/ 前缀）也算命中", async () => {
    const { cookie } = await seedUserWithEvent("a@example.com", "甲的会");
    const first = await getEvents(cookie);
    const tag = first.headers.etag as string;
    const res = await getEvents(cookie, `W/${tag}`);
    expect(res.statusCode).toBe(304);
  });
});

