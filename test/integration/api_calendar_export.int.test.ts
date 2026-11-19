// API（/api/v1）单日历 ICS 导出：给三个客户端补的一次性下载入口。
// 盯的口径：
//   一、属主鉴权 —— 走 bearer（API Token / 会话），绝不经 share-token
//       公开链接；没认证 401、别人的日历 404、坏 id 404；
//   二、只读 Token 可导（这是读操作），且导出内容与网页导出同源
//       （buildIcsFeed）：含事件标题/uid，软删事件绝不出现在导出里；
//   三、下载语义 —— text/calendar、attachment 文件名（按日历名清洗）、
//       Cache-Control: no-store（一份快照不许被缓存成「最新版」）。
import { vi, beforeAll, beforeEach, afterEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
vi.mock("../../src/lib/mailer.js", () => ({
  sendMail: vi.fn(async () => ({ ok: true })), isMailerEnabled: vi.fn(async () => true),
}));

import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  ensureSchema, resetDb, db, schema,
  makeUser, makeCalendar, makeEvent, buildRoutedApp, loginAs,
} from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://unused:unused@localhost:5432/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const { exportRoutes } = await import("../../src/routes/export.js");
const { createApiToken } = await import("../../src/lib/api_token.js");
const { getSettings, reloadSettings, updateSettings } = await import("../../src/lib/site_settings.js");

beforeAll(async () => { await ensureSchema(); });

let app: FastifyInstance;

beforeEach(async () => {
  await resetDb();
  reloadSettings();
  await getSettings();
  await updateSettings({ apiEnabled: true });
  app = await buildRoutedApp(async (a) => { await exportRoutes(a); }, { prefix: "/api/v1" });
});
afterEach(async () => { await app.close(); });

async function seed(scope: "read" | "write" = "read") {
  const user = await makeUser("a@example.com");
  const cal = await makeCalendar(user.id, "工作 / Work");
  const issued = await createApiToken({ userId: user.id, label: "App", scope });
  return { user, cal, auth: { authorization: `Bearer ${issued.plain}` } };
}

describe("API 单日历 ICS 导出", () => {
  it("导出含事件、是合法 VCALENDAR，文件名按日历名清洗", async () => {
    const { cal, auth } = await seed();
    await makeEvent(cal.id, "exp-1@x");
    const ev2 = await makeEvent(cal.id, "exp-2@x");
    await db.update(schema.events).set({ summary: "导出可见的会" }).where(eq(schema.events.id, ev2.id));

    const res = await app.inject({ method: "GET", url: `/api/v1/calendars/${cal.id}/export.ics`, headers: { ...auth } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/calendar");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain(".ics");
    expect(res.body).toContain("BEGIN:VCALENDAR");
    expect(res.body).toContain("UID:exp-1@x");
    expect(res.body).toContain("导出可见的会");
  });

  it("软删事件不进导出；别的日历的事件不串进来", async () => {
    const { user, cal, auth } = await seed();
    const alive = await makeEvent(cal.id, "alive@x");
    const gone = await makeEvent(cal.id, "gone@x");
    await db.update(schema.events)
      .set({ summary: "活着的", deletedAt: new Date() })
      .where(eq(schema.events.id, gone.id));
    await db.update(schema.events).set({ summary: "活着的" }).where(eq(schema.events.id, alive.id));
    const otherCal = await makeCalendar(user.id, "Other");
    const foreign = await makeEvent(otherCal.id, "foreign@x");
    await db.update(schema.events).set({ summary: "别的日历的" }).where(eq(schema.events.id, foreign.id));

    const res = await app.inject({ method: "GET", url: `/api/v1/calendars/${cal.id}/export.ics`, headers: { ...auth } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("UID:alive@x");
    expect(res.body).not.toContain("gone@x");
    expect(res.body).not.toContain("foreign@x");
  });

  it("只读 Token 可导（读操作）；没认证 401；假 Token 401", async () => {
    const { cal, auth } = await seed("read");
    const okRes = await app.inject({ method: "GET", url: `/api/v1/calendars/${cal.id}/export.ics`, headers: { ...auth } });
    expect(okRes.statusCode).toBe(200);

    const anon = await app.inject({ method: "GET", url: `/api/v1/calendars/${cal.id}/export.ics` });
    expect(anon.statusCode).toBe(401);
    const fake = await app.inject({
      method: "GET", url: `/api/v1/calendars/${cal.id}/export.ics`,
      headers: { authorization: "Bearer bwc_deadbeef_notreal" },
    });
    expect(fake.statusCode).toBe(401);
  });

  it("别人的日历 404（不泄露存在性）；坏 id 404", async () => {
    const { auth } = await seed();
    const otherUser = await makeUser("b@example.com");
    const otherCal = await makeCalendar(otherUser.id, "B");
    const res = await app.inject({ method: "GET", url: `/api/v1/calendars/${otherCal.id}/export.ics`, headers: { ...auth } });
    expect(res.statusCode).toBe(404);
    const bad = await app.inject({ method: "GET", url: "/api/v1/calendars/not-a-uuid/export.ics", headers: { ...auth } });
    expect(bad.statusCode).toBe(404);
  });

  it("会话 cookie 也能导（网页外壳/内嵌场景与 API 同口径）", async () => {
    const { user, cal } = await seed();
    await makeEvent(cal.id, "cookie@x");
    const cookie = await loginAs(app, user.id);
    const res = await app.inject({
      method: "GET", url: `/api/v1/calendars/${cal.id}/export.ics`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("UID:cookie@x");
  });
});
