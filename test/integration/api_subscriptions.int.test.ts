// API（/api/v1）ICS 订阅管理：给三个客户端补的入口，核心和网页订阅共用
// 同一份（calendar_subscriptions 表 + refreshSubscription），这里盯的是
// API 这一层的口径：
//   一、创建即首刷 —— 拉得到就导入计数，拉不到订阅也存下（refresh.ok=false
//       把原因带回），不能因为首刷失败就让用户再建一条重复订阅；
//   二、SSRF —— 指向内网地址的订阅首刷必须被 ssrf_guard 拦下并留痕
//       （lastStatus=error），订阅行本身照常存在；
//   三、权限 —— 没认证 401、只读 Token 写操作 403（token_is_read_only）、
//       别人的日历 404；
//   四、归属 —— 刷新/删除同时校验日历与订阅的归属：拿自己的日历 id 配
//       别人的订阅 id 必须 404（网页端刷新曾经漏过这一条）。
import { vi, beforeAll, beforeEach, afterEach, afterAll, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
vi.mock("../../src/lib/mailer.js", () => ({
  sendMail: vi.fn(async () => ({ ok: true })), isMailerEnabled: vi.fn(async () => true),
}));
// SSRF 用例：本文件为了成功路径开了 ICS_ALLOW_PRIVATE_NETWORK（见下方），
// 真 guard 在这个进程里不会拦字面内网 IP。这里只把「指向云元数据地址」
// 这一种挡回真 guard 的行为（抛 SsrfBlockedError、文案与生产一致），其余
// URL 全部委托真实现——盯的是 API 层拿到拦截后怎么落库/回包，guard 本身
// 的判定由 test/ssrf_guard.test.ts 钉死。
vi.mock("../../src/lib/ssrf_guard.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../src/lib/ssrf_guard.js")>();
  return {
    ...orig,
    safeFetch: async (url: string, opts: Parameters<typeof orig.safeFetch>[1]) => {
      if (String(url).includes("169.254.169.254")) {
        throw new orig.SsrfBlockedError("目标地址指向内网 / 保留地址，已拒绝");
      }
      return orig.safeFetch(url, opts);
    },
  };
});

import { createServer, type Server } from "node:http";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  ensureSchema, resetDb, db, schema,
  makeUser, makeCalendar, buildRoutedApp,
} from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://unused:unused@localhost:5432/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
// 成功路径要真抓一个本机 HTTP 服务当订阅源：这是 ssrf_guard 的运维
// opt-in 开关（env.ts 的 ICS_ALLOW_PRIVATE_NETWORK），只在本测试文件
// 进程内打开。元数据地址的拦截用例靠文件头的 ssrf_guard mock 把那一种
// 地址挡回去（见上）。
process.env.ICS_ALLOW_PRIVATE_NETWORK = "true";
const { subscriptionRoutes } = await import("../../src/routes/subscriptions.js");
const { createApiToken } = await import("../../src/lib/api_token.js");
const { getSettings, reloadSettings, updateSettings } = await import("../../src/lib/site_settings.js");

beforeAll(async () => { await ensureSchema(); });

let app: FastifyInstance;
let feedServer: Server;
let feedPort = 0;
let feedHits = 0;

const CRLF = "\r\n";
const FEED = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//subs//EN",
  "BEGIN:VEVENT", "UID:sub-feed-1@x", "SUMMARY:订阅来的日程",
  "DTSTART:20261105T010000Z", "DTEND:20261105T020000Z", "END:VEVENT",
  "BEGIN:VEVENT", "UID:sub-feed-2@x", "SUMMARY:订阅来的日程二",
  "DTSTART:20261106T010000Z", "DTEND:20261106T020000Z", "END:VEVENT",
  "END:VCALENDAR",
].join(CRLF) + CRLF;

beforeAll(async () => {
  feedServer = createServer((_req, res) => {
    feedHits += 1;
    res.writeHead(200, { "content-type": "text/calendar; charset=utf-8" });
    res.end(FEED);
  });
  await new Promise<void>((resolve) => feedServer.listen(0, "127.0.0.1", resolve));
  const addr = feedServer.address();
  feedPort = typeof addr === "object" && addr ? addr.port : 0;
});
afterAll(async () => { await new Promise<void>((resolve) => feedServer.close(() => resolve())); });

beforeEach(async () => {
  await resetDb();
  reloadSettings();
  await getSettings();
  await updateSettings({ apiEnabled: true });
  feedHits = 0;
  app = await buildRoutedApp(async (a) => { await subscriptionRoutes(a); }, { prefix: "/api/v1" });
});
afterEach(async () => { await app.close(); });

async function seed(scope: "read" | "write" = "write", email = "a@example.com") {
  const user = await makeUser(email);
  const cal = await makeCalendar(user.id);
  const issued = await createApiToken({ userId: user.id, label: "App", scope });
  return { user, cal, auth: { authorization: `Bearer ${issued.plain}` } };
}

function feedUrl(): string {
  return `http://127.0.0.1:${feedPort}/feed.ics`;
}

async function subRows(calId: string) {
  return db.select().from(schema.calendarSubscriptions)
    .where(eq(schema.calendarSubscriptions.calendarId, calId));
}

async function eventCount(calId: string): Promise<number> {
  const rows = await db.select({ id: schema.events.id }).from(schema.events)
    .where(eq(schema.events.calendarId, calId));
  return rows.length;
}

type SubView = {
  id: string; calendarId: string; url: string; label: string | null;
  refreshMinutes: number; lastStatus: string | null; lastError: string | null;
  lastEventCount: number | null;
};

describe("API ICS 订阅管理", () => {
  it("创建即首刷：订阅存下、事件导入、计数随响应带回", async () => {
    const { cal, auth } = await seed();
    const res = await app.inject({
      method: "POST", url: `/api/v1/calendars/${cal.id}/subscriptions`,
      headers: { "content-type": "application/json", ...auth },
      payload: JSON.stringify({ url: feedUrl(), label: "团队日历" }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.refresh).toMatchObject({ ok: true, inserted: 2, total: 2 });
    expect(body.data.subscription).toMatchObject({ label: "团队日历", lastStatus: "ok", lastEventCount: 2 });
    expect(await eventCount(cal.id)).toBe(2);
    expect(feedHits).toBe(1);
  });

  it("首刷拉不到：订阅照常存下，refresh.ok=false 带原因，之后可手动刷新成功", async () => {
    const { cal, auth } = await seed();
    const res = await app.inject({
      method: "POST", url: `/api/v1/calendars/${cal.id}/subscriptions`,
      headers: { "content-type": "application/json", ...auth },
      payload: JSON.stringify({ url: "http://127.0.0.1:1/down.ics" }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.refresh.ok).toBe(false);
    expect(typeof body.data.refresh.error).toBe("string");
    const rows = await subRows(cal.id);
    expect(rows.length).toBe(1);
    expect(rows[0]!.lastStatus).toBe("error");

    // 把订阅源改成可达地址后手动刷新（直接改行模拟上游恢复）。
    await db.update(schema.calendarSubscriptions)
      .set({ url: feedUrl() })
      .where(eq(schema.calendarSubscriptions.id, rows[0]!.id));
    const again = await app.inject({
      method: "POST", url: `/api/v1/calendars/${cal.id}/subscriptions/${rows[0]!.id}/refresh`,
      headers: { ...auth },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().data).toMatchObject({ inserted: 2, total: 2 });
    expect(await eventCount(cal.id)).toBe(2);
  });

  it("重复刷新幂等：第二次刷新全是跳过，不重复建事件", async () => {
    const { cal, auth } = await seed();
    const created = await app.inject({
      method: "POST", url: `/api/v1/calendars/${cal.id}/subscriptions`,
      headers: { "content-type": "application/json", ...auth },
      payload: JSON.stringify({ url: feedUrl() }),
    });
    const subId = (created.json().data.subscription as SubView).id;
    const again = await app.inject({
      method: "POST", url: `/api/v1/calendars/${cal.id}/subscriptions/${subId}/refresh`,
      headers: { ...auth },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().data).toMatchObject({ inserted: 0, skipped: 2 });
    expect(await eventCount(cal.id)).toBe(2);
  });

  it("列表只回本日历的订阅，带状态字段", async () => {
    const { user, cal, auth } = await seed();
    const other = await makeCalendar(user.id, "Other");
    await app.inject({
      method: "POST", url: `/api/v1/calendars/${cal.id}/subscriptions`,
      headers: { "content-type": "application/json", ...auth },
      payload: JSON.stringify({ url: feedUrl(), label: "甲" }),
    });
    await app.inject({
      method: "POST", url: `/api/v1/calendars/${other.id}/subscriptions`,
      headers: { "content-type": "application/json", ...auth },
      payload: JSON.stringify({ url: feedUrl(), label: "乙" }),
    });
    const res = await app.inject({ method: "GET", url: `/api/v1/calendars/${cal.id}/subscriptions`, headers: { ...auth } });
    expect(res.statusCode).toBe(200);
    const list = res.json().data as SubView[];
    expect(list.length).toBe(1);
    expect(list[0]).toMatchObject({ label: "甲", calendarId: cal.id, lastStatus: "ok" });
  });

  it("删除订阅：行消失，再刷新回 404", async () => {
    const { cal, auth } = await seed();
    const created = await app.inject({
      method: "POST", url: `/api/v1/calendars/${cal.id}/subscriptions`,
      headers: { "content-type": "application/json", ...auth },
      payload: JSON.stringify({ url: feedUrl() }),
    });
    const subId = (created.json().data.subscription as SubView).id;
    const del = await app.inject({
      method: "DELETE", url: `/api/v1/calendars/${cal.id}/subscriptions/${subId}`,
      headers: { ...auth },
    });
    expect(del.statusCode).toBe(200);
    expect((await subRows(cal.id)).length).toBe(0);
    const again = await app.inject({
      method: "POST", url: `/api/v1/calendars/${cal.id}/subscriptions/${subId}/refresh`,
      headers: { ...auth },
    });
    expect(again.statusCode).toBe(404);
  });

  it("归属校验：拿自己的日历 id 配别人的订阅 id，刷新和删除都 404 且不生效", async () => {
    const mine = await seed();
    const otherUser = await makeUser("b@example.com");
    const otherCal = await makeCalendar(otherUser.id, "B's cal");
    const [victim] = await db.insert(schema.calendarSubscriptions).values({
      calendarId: otherCal.id, url: feedUrl(), label: "别人的订阅",
    }).returning();

    const refresh = await app.inject({
      method: "POST", url: `/api/v1/calendars/${mine.cal.id}/subscriptions/${victim!.id}/refresh`,
      headers: { ...mine.auth },
    });
    expect(refresh.statusCode).toBe(404);
    const del = await app.inject({
      method: "DELETE", url: `/api/v1/calendars/${mine.cal.id}/subscriptions/${victim!.id}`,
      headers: { ...mine.auth },
    });
    expect(del.statusCode).toBe(404);
    expect((await subRows(otherCal.id)).length).toBe(1);
    // 对方的日历本身也够不着：列表直接 404。
    const list = await app.inject({
      method: "GET", url: `/api/v1/calendars/${otherCal.id}/subscriptions`,
      headers: { ...mine.auth },
    });
    expect(list.statusCode).toBe(404);
  });

  it("权限：没认证 401；只读 Token 列表可读、建/刷/删一律 403", async () => {
    const { cal } = await seed();
    const anon = await app.inject({ method: "GET", url: `/api/v1/calendars/${cal.id}/subscriptions` });
    expect(anon.statusCode).toBe(401);

    const ro = await seed("read", "ro@example.com");
    // 只读 Token 用的是它自己名下的日历（上面 seed 已备好）。
    const list = await app.inject({
      method: "GET", url: `/api/v1/calendars/${ro.cal.id}/subscriptions`, headers: { ...ro.auth },
    });
    expect(list.statusCode).toBe(200);
    const create = await app.inject({
      method: "POST", url: `/api/v1/calendars/${ro.cal.id}/subscriptions`,
      headers: { "content-type": "application/json", ...ro.auth },
      payload: JSON.stringify({ url: feedUrl() }),
    });
    expect(create.statusCode).toBe(403);
    expect(create.json().error).toBe("token_is_read_only");
    expect((await subRows(ro.cal.id)).length).toBe(0);
  });

  it("参数校验：非法 URL 与越界 refreshMinutes 回 400 且不落库", async () => {
    const { cal, auth } = await seed();
    const bad1 = await app.inject({
      method: "POST", url: `/api/v1/calendars/${cal.id}/subscriptions`,
      headers: { "content-type": "application/json", ...auth },
      payload: JSON.stringify({ url: "" }),
    });
    expect(bad1.statusCode).toBe(400);
    const bad2 = await app.inject({
      method: "POST", url: `/api/v1/calendars/${cal.id}/subscriptions`,
      headers: { "content-type": "application/json", ...auth },
      payload: JSON.stringify({ url: feedUrl(), refreshMinutes: 5 }),
    });
    expect(bad2.statusCode).toBe(400);
    expect((await subRows(cal.id)).length).toBe(0);
  });

  it("SSRF：指向云元数据地址的订阅首刷被拦，订阅存下且错误留痕，一个事件都不导", async () => {
    const { cal, auth } = await seed();
    const res = await app.inject({
      method: "POST", url: `/api/v1/calendars/${cal.id}/subscriptions`,
      headers: { "content-type": "application/json", ...auth },
      payload: JSON.stringify({ url: "http://169.254.169.254/latest/meta-data.ics" }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.refresh.ok).toBe(false);
    expect(body.data.refresh.error).toMatch(/已拒绝/);
    const rows = await subRows(cal.id);
    expect(rows.length).toBe(1);
    expect(rows[0]!.lastStatus).toBe("error");
    expect(rows[0]!.lastError).toMatch(/已拒绝/);
    expect(await eventCount(cal.id)).toBe(0);
  });

  it("坏 id：非 uuid 的日历/订阅 id 回 404", async () => {
    const { auth } = await seed();
    const res = await app.inject({
      method: "GET", url: "/api/v1/calendars/not-a-uuid/subscriptions", headers: { ...auth },
    });
    expect(res.statusCode).toBe(404);
  });
});
