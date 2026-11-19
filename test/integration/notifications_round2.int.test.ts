// 通知第二轮的集成断言：
//   · 事件被改（有意义的变更）→ 共享成员与已注册参与者收到 event_updated；
//     只改描述不发；30 分钟内连环修改合并成一条；event_updated 永不推 Push。
//   · 事件被删 → event_cancelled（带 Push 镜像）；关掉事件变更偏好的人
//     两类都不收；关掉收件箱推送的人只收站内、不推。
//   · 安全事件（自助创建 Token）→ 本人收到 security_alert，正文只有名字
//     与权限，绝不含明文 Token。
//
// 事件侧的生产者在路由里是 fire-and-forget 的旁路，断言统一走轮询等行落库。

import { vi, beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
vi.mock("../../src/lib/mailer.js", () => ({ sendMail: vi.fn(async () => ({ ok: true })), isMailerEnabled: vi.fn(async () => true) }));
vi.mock("../../src/lib/calendar_sync/queue.js", () => ({ requestCalendarSync: vi.fn(async () => undefined) }));
vi.mock("../../src/lib/apns.js", () => ({ pushEventChanged: vi.fn(async () => undefined) }));
vi.mock("../../src/lib/webhooks.js", () => ({ dispatchWebhook: vi.fn(async () => undefined), eventToWebhookPayload: (event: unknown) => event }));

const pushCalls: { userId: string; payload: { title: string; tag?: string } }[] = [];
vi.mock("../../src/lib/push.js", () => ({
  pushToUser: vi.fn(async (userId: string, payload: { title: string; tag?: string }) => {
    pushCalls.push({ userId, payload });
    return { sent: 1, pruned: 0 };
  }),
}));

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://u:p@127.0.0.1:1/db";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import { desc, eq } from "drizzle-orm";
import {
  ensureSchema, resetDb, db, schema,
  makeUser, makeCalendar, makeMembership, buildRoutedApp, loginAs,
} from "./harness.js";

const { eventRoutes } = await import("../../src/routes/events.js");
const { webRoutes } = await import("../../src/web/index.js");
const { csrfTokenFor } = await import("../../src/lib/csrf.js");
const { getSettings, reloadSettings, updateSettings } = await import("../../src/lib/site_settings.js");
const { hashPassword } = await import("../../src/lib/password.js");

const REAL_PASSWORD = "Correct-Horse-42!";
const FULL_TOKEN_SHAPE = /bwc_[A-Za-z0-9]{8}_[A-Za-z0-9]{24}/;

beforeAll(async () => { await ensureSchema(); });

async function rowsFor(userId: string) {
  return db.select().from(schema.notifications)
    .where(eq(schema.notifications.userId, userId))
    .orderBy(desc(schema.notifications.createdAt));
}

/** 旁路是异步的：轮询等行出现（或等满超时后返回现状，交给断言报错）。 */
async function waitRows(userId: string, min: number, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let rows = await rowsFor(userId);
  while (rows.length < min && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    rows = await rowsFor(userId);
  }
  return rows;
}

async function settle(ms = 400) {
  await new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------- 事件侧
let app: FastifyInstance;
let owner: Awaited<ReturnType<typeof makeUser>>;
let member: Awaited<ReturnType<typeof makeUser>>;
let attendee: Awaited<ReturnType<typeof makeUser>>;
let cal: Awaited<ReturnType<typeof makeCalendar>>;
let ownerCookie: string;

beforeEach(async () => {
  await resetDb();
  pushCalls.length = 0;
  app = await buildRoutedApp(eventRoutes, { prefix: "/api" });
  owner = await makeUser("n2-owner@example.com");
  member = await makeUser("n2-member@example.com");
  attendee = await makeUser("n2-attendee@example.com");
  cal = await makeCalendar(owner.id, "Shared Cal");
  await makeMembership(cal.id, member.id);
  ownerCookie = await loginAs(app, owner.id);
});
afterEach(async () => { await app.close(); });

async function createEvent(extra?: unknown): Promise<{ id: string }> {
  const res = await app.inject({
    method: "POST", url: "/api/events", headers: { cookie: ownerCookie },
    payload: {
      calendarId: cal.id, summary: "项目例会",
      startsAt: "2026-07-14T01:00:00.000Z", endsAt: "2026-07-14T02:00:00.000Z",
      ...(extra === undefined ? {} : { extra }),
    },
  });
  expect([200, 201], `建事件失败: ${res.body.slice(0, 300)}`).toContain(res.statusCode);
  return JSON.parse(res.body) as { id: string };
}

function patchEvent(id: string, payload: Record<string, unknown>) {
  return app.inject({ method: "PATCH", url: `/api/events/${id}`, headers: { cookie: ownerCookie }, payload });
}

describe("事件变更站内通知", () => {
  it("改时间 → 成员与已注册参与者各收到一条 event_updated，操作者本人没有，且不推 Push", async () => {
    const ev = await createEvent({ attendees: [attendee.email] });
    // 建事件时受邀者先收到一条 event_invitation（邀请线站内通知），
    // 它是邀请类、带 Push —— 先等它落库并把推送计数快照下来，
    // 下面断言的是「改时间这一步」的净效果，不把邀请算进来。
    const inviteRows = await waitRows(attendee.id, 1);
    expect(inviteRows[0]!.type).toBe("event_invitation");
    const pushesAfterInvite = pushCalls.length;

    const res = await patchEvent(ev.id, { startsAt: "2026-07-14T03:00:00.000Z", endsAt: "2026-07-14T04:00:00.000Z" });
    expect([200, 204], `改事件失败: ${res.body.slice(0, 300)}`).toContain(res.statusCode);

    const memberRows = await waitRows(member.id, 1);
    expect(memberRows).toHaveLength(1);
    expect(memberRows[0]!.type).toBe("event_updated");
    expect(memberRows[0]!.title).toContain("项目例会");
    expect(memberRows[0]!.body).toContain("03:00");
    expect(memberRows[0]!.url).toBe(`/app?event=${ev.id}&cal=${cal.id}`);

    const attendeeUpdated = (await waitRows(attendee.id, 2)).filter((r) => r.type === "event_updated");
    expect(attendeeUpdated).toHaveLength(1);

    expect(await rowsFor(owner.id)).toHaveLength(0);
    // event_updated 是高频低急迫类：只进收件箱，永不推 Push。
    expect(pushCalls).toHaveLength(pushesAfterInvite);
  });

  it("只改描述 → 谁都不通知", async () => {
    const ev = await createEvent();
    const res = await patchEvent(ev.id, { description: "补充说明" });
    expect([200, 204], `改事件失败: ${res.body.slice(0, 300)}`).toContain(res.statusCode);
    await settle();
    expect(await rowsFor(member.id)).toHaveLength(0);
    expect(await rowsFor(attendee.id)).toHaveLength(0);
  });

  it("30 分钟内连续改两次 → 合并成一条，正文是最新时间", async () => {
    const ev = await createEvent();
    await patchEvent(ev.id, { startsAt: "2026-07-14T03:00:00.000Z", endsAt: "2026-07-14T04:00:00.000Z" });
    const first = await waitRows(member.id, 1);
    expect(first).toHaveLength(1);

    await patchEvent(ev.id, { startsAt: "2026-07-14T11:00:00.000Z", endsAt: "2026-07-14T12:00:00.000Z" });
    // 等正文刷新成最新状态（合并是原地更新，不是新增一行）。
    const deadline = Date.now() + 3000;
    let rows = await rowsFor(member.id);
    while (!(rows[0]?.body ?? "").includes("11:00") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      rows = await rowsFor(member.id);
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toContain("11:00");
  });

  it("删事件 → 成员收到 event_cancelled 并推一份 Push；关了事件变更偏好的人两类都不收", async () => {
    const ev = await createEvent();
    const res = await app.inject({ method: "DELETE", url: `/api/events/${ev.id}`, headers: { cookie: ownerCookie } });
    expect([200, 204], `删事件失败: ${res.body.slice(0, 300)}`).toContain(res.statusCode);

    const rows = await waitRows(member.id, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("event_cancelled");
    expect(rows[0]!.title).toContain("项目例会");
    // 取消值得推：pushToUser 被以这条通知的 tag 调用一次。
    const mine = pushCalls.filter((c) => c.userId === member.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.payload.tag).toMatch(/^inbox-/);

    // 偏好关掉后：改也不收、删也不收。
    await db.update(schema.users).set({ notifyEventChanges: false }).where(eq(schema.users.id, member.id));
    const ev2 = await createEvent();
    await patchEvent(ev2.id, { startsAt: "2026-07-15T03:00:00.000Z", endsAt: "2026-07-15T04:00:00.000Z" });
    await app.inject({ method: "DELETE", url: `/api/events/${ev2.id}`, headers: { cookie: ownerCookie } });
    await settle(600);
    const after = await rowsFor(member.id);
    expect(after).toHaveLength(1); // 还是偏好关闭前那一条
    expect(pushCalls.filter((c) => c.userId === member.id)).toHaveLength(1);
  });

  it("关了收件箱推送的人：取消通知照常进收件箱，但不推 Push", async () => {
    await db.update(schema.users).set({ notifyInboxPush: false }).where(eq(schema.users.id, member.id));
    const ev = await createEvent();
    await app.inject({ method: "DELETE", url: `/api/events/${ev.id}`, headers: { cookie: ownerCookie } });
    const rows = await waitRows(member.id, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("event_cancelled");
    expect(pushCalls.filter((c) => c.userId === member.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- 安全侧
describe("安全事件站内镜像", () => {
  let web: FastifyInstance;

  beforeEach(async () => {
    web = Fastify({ logger: false });
    await web.register(cookie, { secret: "test-cookie-secret-at-least-32-characters" });
    await web.register(formbody);
    web.decorateReply("view", function (template: string, locals: object) {
      return this.send({ template, locals });
    });
    web.get("/test/csrf", (req) => ({ token: csrfTokenFor(req) }));
    await web.register(webRoutes);
    await web.ready();
    reloadSettings();
    await getSettings();
    await updateSettings({ apiEnabled: true });
  });
  afterEach(async () => { await web.close(); });

  it("自助创建 Token → 本人收到 security_alert（只有名字与权限，无明文），并推 Push", async () => {
    const user = await makeUser("n2-sec@example.com");
    await db.update(schema.users)
      .set({ passwordHash: await hashPassword(REAL_PASSWORD) })
      .where(eq(schema.users.id, user.id));
    const sess = await loginAs(web, user.id);
    const csrf = (await web.inject({ url: "/test/csrf", headers: { cookie: sess } })).json().token as string;
    const res = await web.inject({
      method: "POST", url: "/app/settings/api-tokens",
      headers: { cookie: sess },
      payload: { _csrf: csrf, label: "n8n 同步", scope: "read", expiresInDays: "365", currentPassword: REAL_PASSWORD },
    });
    expect(res.statusCode, res.body.slice(0, 200)).toBe(302);

    const rows = await waitRows(user.id, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("security_alert");
    expect(rows[0]!.body).toContain("n8n 同步");
    expect(rows[0]!.body).toContain("只读");
    // 文案里的每个占位符都必须被填掉 —— 残留的 {xxx} 会原样印给用户看。
    expect(rows[0]!.body).not.toContain("{");
    expect(`${rows[0]!.title} ${rows[0]!.body}`).not.toMatch(FULL_TOKEN_SHAPE);
    expect(rows[0]!.url).toBe("/app/settings/security");
    expect(pushCalls.filter((c) => c.userId === user.id)).toHaveLength(1);
  });
});
