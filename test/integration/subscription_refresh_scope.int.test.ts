// 「立即同步订阅」只能同步**这个日历自己的**订阅 —— 从 HTTP 打进去。
//
// 这条路原来只校验了路径里的日历是自己的，订阅 id 原样交给刷新：拿自己的日历 id
// 配上别人的订阅 id，就能触发别人订阅的导入，还能从返回提示里读到对方上游地址的
// 响应片段。紧挨着的「删除订阅」一直是两个条件一起查的，这条漏了。

import { vi, beforeAll, beforeEach, afterEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
vi.mock("../../src/lib/mailer.js", () => ({
  sendMail: vi.fn(async () => ({ ok: true })), isMailerEnabled: vi.fn(async () => true),
}));
// 真去拉上游 ICS 是外网，而且这里要数的恰恰是「它被调了几次、调的是谁」。
const refreshed: string[] = [];
vi.mock("../../src/lib/ics_import.js", async (orig) => ({
  ...(await orig<object>()),
  refreshSubscription: vi.fn(async (subId: string) => {
    refreshed.push(subId);
    return { ok: true, result: { inserted: 0, updated: 0, skipped: 0 } };
  }),
}));

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import { createHmac } from "node:crypto";
import { ensureSchema, resetDb, db, schema, makeUser, makeCalendar } from "./harness.js";
import { newSessionId } from "../../src/lib/ids.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const { webRoutes } = await import("../../src/web/index.js");
const { env } = await import("../../src/env.js");

beforeAll(async () => { await ensureSchema(); });
let app: FastifyInstance;

beforeEach(async () => {
  await resetDb();
  refreshed.length = 0;
  app = Fastify({ logger: false });
  await app.register(cookie, { secret: env.SESSION_SECRET });
  await app.register(formbody);
  await app.register(webRoutes);
  await app.ready();
});
afterEach(async () => { await app.close(); });

async function sessionFor(userId: string) {
  const sid = newSessionId();
  await db.insert(schema.sessions).values({ id: sid, userId, mfaSatisfied: true, expiresAt: new Date(Date.now() + 86400_000) });
  return {
    cookie: `bwc_sid=${encodeURIComponent(app.signCookie(sid))}`,
    csrf: createHmac("sha256", env.SESSION_SECRET).update(sid).digest("hex"),
  };
}
async function refresh(s: { cookie: string; csrf: string }, calId: string, subId: string) {
  return app.inject({
    method: "POST", url: `/app/calendars/${calId}/subscriptions/${subId}/refresh`,
    headers: { cookie: s.cookie, "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ _csrf: s.csrf }).toString(),
  });
}

describe("立即同步订阅", () => {
  it("同步自己日历上的订阅（presence）", async () => {
    const a = await makeUser("a@example.com");
    const calA = await makeCalendar(a.id);
    const [subA] = await db.insert(schema.calendarSubscriptions)
      .values({ calendarId: calA.id, url: "https://a.example/cal.ics" }).returning();
    const res = await refresh(await sessionFor(a.id), calA.id, subA!.id);
    expect([302, 303]).toContain(res.statusCode);
    expect(refreshed, "连自己的订阅都没同步 —— 下面那条什么也没测到").toEqual([subA!.id]);
  });

  it("**拿自己的日历配别人的订阅 → 什么都不做**", async () => {
    const a = await makeUser("a@example.com");
    const calA = await makeCalendar(a.id);
    const b = await makeUser("b@example.com");
    const calB = await makeCalendar(b.id);
    const [subB] = await db.insert(schema.calendarSubscriptions)
      .values({ calendarId: calB.id, url: "https://private.example/secret.ics" }).returning();

    const res = await refresh(await sessionFor(a.id), calA.id, subB!.id);
    expect([302, 303]).toContain(res.statusCode);
    expect(
      refreshed,
      "别人的订阅被触发了同步 —— 还能从返回提示里读到对方上游地址的响应片段",
    ).toEqual([]);
  });
});
