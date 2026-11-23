// 事件增量同步（GET /api/events/sync，syncToken 模型）回归测试。
//
// 为什么必须从 HTTP 打进去：这套契约的命门全在报文与状态的交界上 ——
//   · 变更日志由数据库触发器写（迁移 0072），任何一条写路径漏记，增量
//     就静默地缺数据。所以这里逐条真实写路径打：JSON API、CalDAV
//     PUT/DELETE、邀请回应（只 bump updatedAt 的那条），外加删日历成员
//     视角的共享日历；
//   · 令牌过期必须回 410 而不是拼一份不完整的增量 —— 用真实的裁剪函数
//     pruneEventChanges 把日志裁掉之后再打；
//   · 隔离靠的是服务端按可见日历过滤，不是令牌本身（令牌只编码序号）：
//     拿着别人的令牌来问，也只能得到自己的变化。
import { vi, beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
vi.mock("../../src/lib/mailer.js", () => ({ sendMail: vi.fn(async () => ({ ok: true })), isMailerEnabled: vi.fn(async () => true) }));
vi.mock("../../src/lib/calendar_sync/queue.js", () => ({ requestCalendarSync: vi.fn(async () => undefined) }));
vi.mock("../../src/lib/apns.js", () => ({ pushEventChanged: vi.fn(async () => undefined) }));
vi.mock("../../src/lib/webhooks.js", () => ({ dispatchWebhook: vi.fn(async () => undefined), eventToWebhookPayload: (event: unknown) => event }));

import Fastify, { type FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  ensureSchema, resetDb, db, schema,
  makeUser, makeCalendar, makeMembership, buildRoutedApp, loginAs,
} from "./harness.js";
import { hashPassword } from "../../src/lib/password.js";
import { invalidateCalDavAuthCache } from "../../src/lib/caldav_auth.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://localhost:5432/bywave";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";

const { eventRoutes } = await import("../../src/routes/events.js");
const { caldavRoutes } = await import("../../src/web/caldav.js");
const { createApiToken } = await import("../../src/lib/api_token.js");
const { updateSettings, reloadSettings, getSettings } = await import("../../src/lib/site_settings.js");
const {
  pruneEventChanges, encodeSyncToken, decodeSyncToken, syncTokenExpired,
} = await import("../../src/lib/event_sync.js");

const FROM = "2026-01-01T00:00:00Z";
const TO = "2027-12-31T23:59:59Z";
const PASSWORD = "sync-token-pw-123456";
const CRLF = "\r\n";

let app: FastifyInstance;
let davApp: FastifyInstance;

beforeAll(async () => {
  await ensureSchema();
  app = await buildRoutedApp(async (scoped) => {
    await scoped.register(eventRoutes, { prefix: "/api" });
    await scoped.register(eventRoutes, { prefix: "/api/v1" });
  });
  davApp = Fastify({ logger: false });
  davApp.addHttpMethod("PROPFIND", { hasBody: true });
  davApp.addHttpMethod("REPORT", { hasBody: true });
  davApp.addContentTypeParser("text/calendar", { parseAs: "string" }, (_req, body, done) => done(null, body as string));
  await davApp.register(caldavRoutes);
  await davApp.ready();
});
afterAll(async () => { await app.close(); await davApp.close(); });

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDb();
  invalidateCalDavAuthCache();
  reloadSettings();
});

type Json = Record<string, any>;

async function sync(cookie: string, token?: string, prefix = "/api"): Promise<{ status: number; body: Json }> {
  const qs = new URLSearchParams({ from: FROM, to: TO });
  if (token !== undefined) qs.set("syncToken", token);
  const res = await app.inject({ method: "GET", url: `${prefix}/events/sync?${qs}`, headers: { cookie } });
  return { status: res.statusCode, body: res.json() as Json };
}

async function createEvent(cookie: string, calendarId: string, summary: string, extra?: Json): Promise<Json> {
  const res = await app.inject({
    method: "POST", url: "/api/events", headers: { cookie },
    payload: {
      calendarId, summary,
      startsAt: "2026-06-10T09:00:00Z", endsAt: "2026-06-10T10:00:00Z",
      ...(extra ?? {}),
    },
  });
  expect(res.statusCode, res.body.slice(0, 200)).toBe(201);
  return res.json() as Json;
}

/** 带真实密码的用户：API 走会话 cookie，CalDAV 走 Basic，两边都认。 */
async function makePasswordUser(email: string) {
  const [u] = await db
    .insert(schema.users)
    .values({ email, emailVerified: true, passwordHash: await hashPassword(PASSWORD), passwordSet: true })
    .returning();
  return u!;
}

function davAuth(email: string): string {
  return "Basic " + Buffer.from(`${email}:${PASSWORD}`).toString("base64");
}

function icsBody(uid: string, summary: string): string {
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//sync//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "DTSTAMP:20260601T000000Z",
    `SUMMARY:${summary}`,
    "DTSTART:20260610T090000Z",
    "DTEND:20260610T110000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join(CRLF) + CRLF;
}

function davPut(user: { id: string; email: string }, calId: string, uid: string, body: string) {
  return davApp.inject({
    method: "PUT", url: `/caldav/${user.id}/${calId}/${uid}.ics`,
    headers: { authorization: davAuth(user.email), "content-type": "text/calendar; charset=utf-8" },
    payload: body,
  });
}

describe("令牌编解码与过期判定（纯逻辑）", () => {
  it("编解码往返；坏令牌解不开", () => {
    expect(decodeSyncToken(encodeSyncToken(0))).toBe(0);
    expect(decodeSyncToken(encodeSyncToken(12345))).toBe(12345);
    expect(decodeSyncToken("not-a-token")).toBeNull();
    expect(decodeSyncToken("")).toBeNull();
  });

  it("过期判定：越过水位、落在裁剪线之下都算过期；恰好贴着裁剪线还有效", () => {
    expect(syncTokenExpired(10, 5, 20)).toBe(false);
    expect(syncTokenExpired(4, 5, 20)).toBe(false);  // 5 是现存最老一条，4 之后的变化都还在
    expect(syncTokenExpired(3, 5, 20)).toBe(true);   // 序号 4 那条已被裁掉
    expect(syncTokenExpired(21, 5, 20)).toBe(true);  // 比水位还大：不是这条日志发的
    expect(syncTokenExpired(0, null, 0)).toBe(false); // 空表
  });
});

describe("GET /events/sync", () => {
  it("初始全量：事件（含重复事件展开）+ 日历 + nextSyncToken；/api/v1 同挂", async () => {
    const user = await makeUser("sync-full@example.com");
    const cal = await makeCalendar(user.id, "Mine");
    const cookie = await loginAs(app, user.id);
    const single = await createEvent(cookie, cal.id, "单次");
    await createEvent(cookie, cal.id, "每周例会", { rrule: "FREQ=WEEKLY;COUNT=4" });

    const { status, body } = await sync(cookie);
    expect(status).toBe(200);
    expect(body.calendars.map((c: Json) => c.id)).toContain(cal.id);
    const ids = (body.events as Json[]).map((e) => e.id);
    expect(ids).toContain(single.id);
    // 重复事件在窗口内展开成 4 次，id 都是主事件的。
    const weekly = (body.events as Json[]).filter((e) => e.summary === "每周例会");
    expect(weekly).toHaveLength(4);
    expect(typeof body.nextSyncToken).toBe("string");
    expect(decodeSyncToken(body.nextSyncToken)).toBeGreaterThan(0);
    // 初始同步不带增量字段。
    expect(body.upsertedIds).toBeUndefined();
    expect(body.deletedIds).toBeUndefined();

    const v1 = await sync(cookie, undefined, "/api/v1");
    expect(v1.status).toBe(200);
    expect(v1.body.nextSyncToken).toBe(body.nextSyncToken);
  });

  it("增量：新建与修改只回变化的那两个，且令牌推进后增量为空", async () => {
    const user = await makeUser("sync-delta@example.com");
    const cal = await makeCalendar(user.id, "Mine");
    const cookie = await loginAs(app, user.id);
    const first = await createEvent(cookie, cal.id, "原标题");
    const base = await sync(cookie);
    const token = base.body.nextSyncToken as string;

    const added = await createEvent(cookie, cal.id, "新事件");
    const patch = await app.inject({
      method: "PATCH", url: `/api/events/${first.id}`, headers: { cookie },
      payload: { summary: "改过的标题" },
    });
    expect(patch.statusCode).toBe(200);

    const delta = await sync(cookie, token);
    expect(delta.status).toBe(200);
    expect(new Set(delta.body.upsertedIds)).toEqual(new Set([first.id, added.id]));
    expect(delta.body.deletedIds).toEqual([]);
    const summaries = (delta.body.events as Json[]).map((e) => e.summary).sort();
    expect(summaries).toEqual(["改过的标题", "新事件"]);

    const empty = await sync(cookie, delta.body.nextSyncToken as string);
    expect(empty.body.events).toEqual([]);
    expect(empty.body.upsertedIds).toEqual([]);
    expect(empty.body.deletedIds).toEqual([]);
  });

  it("增量删除：API 软删只回 deletedIds；恢复后又变回 upsert", async () => {
    const user = await makeUser("sync-del@example.com");
    const cal = await makeCalendar(user.id, "Mine");
    const cookie = await loginAs(app, user.id);
    const ev = await createEvent(cookie, cal.id, "要删的");
    const token = (await sync(cookie)).body.nextSyncToken as string;

    const del = await app.inject({ method: "DELETE", url: `/api/events/${ev.id}`, headers: { cookie } });
    expect(del.statusCode).toBe(204);
    const delta = await sync(cookie, token);
    expect(delta.body.deletedIds).toEqual([ev.id]);
    expect(delta.body.upsertedIds).toEqual([]);
    expect(delta.body.events).toEqual([]);

    const restore = await app.inject({ method: "POST", url: `/api/events/${ev.id}/restore`, headers: { cookie } });
    expect(restore.statusCode).toBe(200);
    const delta2 = await sync(cookie, delta.body.nextSyncToken as string);
    expect(delta2.body.upsertedIds).toEqual([ev.id]);
    expect(delta2.body.deletedIds).toEqual([]);
  });

  it("CalDAV 写路径：PUT 新建/改、DELETE 删，都进增量", async () => {
    const user = await makePasswordUser("sync-dav@example.com");
    const cal = await makeCalendar(user.id, "Dav");
    const cookie = await loginAs(app, user.id);
    const token = (await sync(cookie)).body.nextSyncToken as string;

    const put = await davPut(user, cal.id, "dav-uid-1", icsBody("dav-uid-1", "DAV 建的"));
    expect(put.statusCode).toBe(201);
    const [row] = await db.select().from(schema.events)
      .where(and(eq(schema.events.calendarId, cal.id), eq(schema.events.uid, "dav-uid-1")));
    const evId = row!.id;

    const d1 = await sync(cookie, token);
    expect(d1.body.upsertedIds).toEqual([evId]);

    const put2 = await davPut(user, cal.id, "dav-uid-1", icsBody("dav-uid-1", "DAV 改的"));
    expect([200, 201, 204]).toContain(put2.statusCode);
    const d2 = await sync(cookie, d1.body.nextSyncToken as string);
    expect(d2.body.upsertedIds).toEqual([evId]);
    expect((d2.body.events as Json[])[0]?.summary).toBe("DAV 改的");

    const del = await davApp.inject({
      method: "DELETE", url: `/caldav/${user.id}/${cal.id}/dav-uid-1.ics`,
      headers: { authorization: davAuth(user.email) },
    });
    expect([200, 204]).toContain(del.statusCode);
    const d3 = await sync(cookie, d2.body.nextSyncToken as string);
    expect(d3.body.deletedIds).toEqual([evId]);
  });

  it("邀请回应路径：受邀者回应只 bump 了事件 updatedAt，也必须进组织者的增量", async () => {
    const organizer = await makeUser("sync-rsvp-org@example.com");
    const invitee = await makeUser("sync-rsvp-inv@example.com");
    const cal = await makeCalendar(organizer.id, "Team");
    const orgCookie = await loginAs(app, organizer.id);
    const ev = await createEvent(orgCookie, cal.id, "评审会", { extra: { attendees: [invitee.email] } });
    const token = (await sync(orgCookie)).body.nextSyncToken as string;

    const [tok] = await db.select().from(schema.eventInviteTokens)
      .where(eq(schema.eventInviteTokens.sourceEventId, ev.id));
    expect(tok).toBeDefined();
    const respond = await app.inject({
      method: "POST", url: `/api/invitations/${tok!.token}/respond`,
      payload: { status: "accepted" },
    });
    expect(respond.statusCode, respond.body.slice(0, 200)).toBe(200);

    const delta = await sync(orgCookie, token);
    expect(delta.body.upsertedIds).toEqual([ev.id]);
    expect(delta.body.deletedIds).toEqual([]);
  });

  it("令牌过期：日志被裁剪后回 410；坏令牌、未来令牌同样 410", async () => {
    const user = await makeUser("sync-410@example.com");
    const cal = await makeCalendar(user.id, "Mine");
    const cookie = await loginAs(app, user.id);
    await createEvent(cookie, cal.id, "一");
    const token = (await sync(cookie)).body.nextSyncToken as string;
    await createEvent(cookie, cal.id, "二");

    // 把现有日志整体标成 31 天前，再跑真实的裁剪函数。
    await db.update(schema.eventChanges).set({ at: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) });
    const pruned = await pruneEventChanges();
    expect(pruned.purged).toBeGreaterThan(0);

    const stale = await sync(cookie, token);
    expect(stale.status).toBe(410);
    expect(stale.body.error).toBe("sync_token_expired");

    expect((await sync(cookie, "%%%not-a-token%%%")).status).toBe(410);
    expect((await sync(cookie, encodeSyncToken(999_999_999))).status).toBe(410);
  });

  it("跨账号隔离：别人的变化不进我的增量；拿别人的令牌也只能问出自己的", async () => {
    const a = await makeUser("sync-iso-a@example.com");
    const b = await makeUser("sync-iso-b@example.com");
    const calA = await makeCalendar(a.id, "A");
    const calB = await makeCalendar(b.id, "B");
    const cookieA = await loginAs(app, a.id);
    const cookieB = await loginAs(app, b.id);
    const evB = await createEvent(cookieB, calB.id, "B 的事件");
    const baseB = await sync(cookieB);
    expect((baseB.body.events as Json[]).map((e) => e.id)).toEqual([evB.id]);

    const evA = await createEvent(cookieA, calA.id, "A 的事件");
    // B 用自己的令牌问：A 的新建不出现。
    const deltaB = await sync(cookieB, baseB.body.nextSyncToken as string);
    expect(deltaB.body.upsertedIds).toEqual([]);
    expect(deltaB.body.deletedIds).toEqual([]);
    // B 拿 A 的令牌问：令牌只编码序号，隔离靠服务端过滤 —— 仍然问不出 A 的事件。
    const tokenA = (await sync(cookieA)).body.nextSyncToken as string;
    const cross = await sync(cookieB, tokenA);
    expect(cross.status).toBe(200);
    expect((cross.body.events as Json[]).map((e) => e.id)).not.toContain(evA.id);
  });

  it("共享日历：成员能同步到所有者的新建、修改与删除", async () => {
    const owner = await makeUser("sync-share-owner@example.com");
    const member = await makeUser("sync-share-member@example.com");
    const cal = await makeCalendar(owner.id, "Shared");
    await makeMembership(cal.id, member.id);
    const ownerCookie = await loginAs(app, owner.id);
    const memberCookie = await loginAs(app, member.id);

    const ev = await createEvent(ownerCookie, cal.id, "共享事件");
    const base = await sync(memberCookie);
    expect((base.body.events as Json[]).map((e) => e.id)).toContain(ev.id);

    const patch = await app.inject({
      method: "PATCH", url: `/api/events/${ev.id}`, headers: { cookie: ownerCookie },
      payload: { summary: "共享事件改名" },
    });
    expect(patch.statusCode).toBe(200);
    const d1 = await sync(memberCookie, base.body.nextSyncToken as string);
    expect(d1.body.upsertedIds).toEqual([ev.id]);

    const del = await app.inject({ method: "DELETE", url: `/api/events/${ev.id}`, headers: { cookie: ownerCookie } });
    expect(del.statusCode).toBe(204);
    const d2 = await sync(memberCookie, d1.body.nextSyncToken as string);
    expect(d2.body.deletedIds).toEqual([ev.id]);
  });

  it("只读 API Token：能增量同步；写仍然被 token_is_read_only 挡住", async () => {
    // 个人 API 是站点开关，默认关着时 verifyApiToken 一律拒（与生产同口径）。
    // 先读一次让 loadFromDb 把单例行种下，updateSettings 的 UPDATE 才有行可打。
    await getSettings();
    await updateSettings({ apiEnabled: true } as never);
    reloadSettings();
    const user = await makeUser("sync-token-scope@example.com");
    const cal = await makeCalendar(user.id, "Mine");
    const cookie = await loginAs(app, user.id);
    const ev = await createEvent(cookie, cal.id, "令牌可见");

    const read = await createApiToken({ userId: user.id, label: "reader", scope: "read" });
    const res = await app.inject({
      method: "GET", url: `/api/events/sync?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`,
      headers: { authorization: `Bearer ${read.plain}` },
    });
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
    expect((res.json().events as Json[]).map((e) => e.id)).toContain(ev.id);

    const write = await app.inject({
      method: "POST", url: "/api/events",
      headers: { authorization: `Bearer ${read.plain}` },
      payload: { calendarId: cal.id, summary: "不许写", startsAt: "2026-06-10T09:00:00Z", endsAt: "2026-06-10T10:00:00Z" },
    });
    expect(write.statusCode).toBe(403);
    expect(write.json().error).toBe("token_is_read_only");
  });
});
