// 第二梯队读接口的条件请求：/invitations、/calendars、/ics/:token。
//
// 这三个接口原来没有任何 ETag：邀请徽章被三端每次加载全量拉、
// 日历列表每次打开全量拉、ICS 订阅源每轮轮询全量重下。补上之后
// 判据要钉住三件事，缺一不可：
//   · 内容没变时，带上次的 ETag 回来 → 304（且响应头口径对）；
//   · 拿着旧 ETag 回来 → 200（不能把新数据挡在门外）；
//   · 每条会改动正文的写路走完，ETag 必须变（邀请的新建/回应/撤销、
//     日历的建/改/删、订阅源日历里事件的增删改与日历改名）。
// 第三条是这类功能的命门：ETag 算漏一摊数据，就是「数据变了、
// 令牌没变、客户端永远看不到新数据」，比没有 ETag 还糟。

import { vi, beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
vi.mock("../../src/lib/mailer.js", () => ({ sendMail: vi.fn(async () => ({ ok: true })), isMailerEnabled: vi.fn(async () => true) }));
vi.mock("../../src/lib/calendar_sync/queue.js", () => ({ requestCalendarSync: vi.fn(async () => undefined) }));
vi.mock("../../src/lib/apns.js", () => ({ pushEventChanged: vi.fn(async () => undefined) }));
vi.mock("../../src/lib/webhooks.js", () => ({ dispatchWebhook: vi.fn(async () => undefined), eventToWebhookPayload: (event: unknown) => event }));

import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import {
  ensureSchema, resetDb, db, schema,
  makeUser, makeCalendar, buildRoutedApp, loginAs,
} from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://u:p@127.0.0.1:1/db";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";

const { eventRoutes } = await import("../../src/routes/events.js");
const { calendarRoutes } = await import("../../src/routes/calendars.js");
const { icsRoutes } = await import("../../src/routes/ics.js");

let app: FastifyInstance;
let organizer: Awaited<ReturnType<typeof makeUser>>;
let invitee: Awaited<ReturnType<typeof makeUser>>;
let cal: Awaited<ReturnType<typeof makeCalendar>>;
let orgAuth: string;
let invAuth: string;

beforeAll(async () => {
  await ensureSchema();
  app = await buildRoutedApp(async (scoped) => {
    await scoped.register(eventRoutes, { prefix: "/api" });
    await scoped.register(calendarRoutes, { prefix: "/api" });
    await scoped.register(icsRoutes);
  });
});
afterAll(async () => { await app.close(); });

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDb();
  organizer = await makeUser("etag-owner@example.com");
  invitee = await makeUser("etag-invitee@example.com");
  cal = await makeCalendar(organizer.id, "Team");
  orgAuth = await loginAs(app, organizer.id);
  invAuth = await loginAs(app, invitee.id);
});

type InjectRes = Awaited<ReturnType<FastifyInstance["inject"]>>;

function get(url: string, cookie: string, etag?: string): Promise<InjectRes> {
  return app.inject({
    method: "GET", url,
    headers: { cookie, ...(etag ? { "if-none-match": etag } : {}) },
  });
}

/** 取一次 200 并把它的 ETag 拿出来；顺手钉住响应头口径。 */
async function etagOf(url: string, cookie: string, cacheControl: string): Promise<string> {
  const res = await get(url, cookie);
  expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
  expect(res.headers["cache-control"]).toBe(cacheControl);
  const tag = res.headers.etag;
  expect(typeof tag).toBe("string");
  return tag as string;
}

async function expect304(url: string, cookie: string, etag: string) {
  const res = await get(url, cookie, etag);
  expect(res.statusCode, res.body.slice(0, 200)).toBe(304);
  expect(res.headers.etag).toBe(etag);
}

async function expect200WithOldTag(url: string, cookie: string, oldTag: string): Promise<string> {
  const res = await get(url, cookie, oldTag);
  expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
  const tag = res.headers.etag as string;
  expect(tag).toBeTruthy();
  expect(tag).not.toBe(oldTag);
  return tag;
}

async function makeEventWithInvitee(): Promise<{ id: string }> {
  const res = await app.inject({
    method: "POST", url: "/api/events", headers: { cookie: orgAuth },
    payload: {
      calendarId: cal.id, summary: "评审会",
      startsAt: "2026-12-01T01:00:00.000Z", endsAt: "2026-12-01T02:00:00.000Z",
      extra: { attendees: [invitee.email] },
    },
  });
  expect([200, 201], res.body.slice(0, 300)).toContain(res.statusCode);
  return JSON.parse(res.body) as { id: string };
}

describe("GET /invitations 的 ETag", () => {
  it("没邀请时也稳定：同 ETag 回 304", async () => {
    const tag = await etagOf("/api/invitations", invAuth, "private, no-cache");
    await expect304("/api/invitations", invAuth, tag);
  });

  it("新建邀请 → 旧 ETag 失效；回应 → 再变；撤销 → 再变", async () => {
    const t0 = await etagOf("/api/invitations", invAuth, "private, no-cache");

    const ev = await makeEventWithInvitee();
    const t1 = await expect200WithOldTag("/api/invitations", invAuth, t0);
    await expect304("/api/invitations", invAuth, t1);

    // 受邀者回应（RSVP 写 respondedAt，token 表没有 updatedAt 列）。
    const [tok] = await db.select().from(schema.eventInviteTokens)
      .where(eq(schema.eventInviteTokens.sourceEventId, ev.id));
    expect(tok).toBeTruthy();
    const respond = await app.inject({
      method: "POST", url: `/api/invitations/${tok!.token}/respond`,
      headers: { cookie: invAuth }, payload: { status: "accepted" },
    });
    expect(respond.statusCode, respond.body.slice(0, 200)).toBe(200);
    const t2 = await expect200WithOldTag("/api/invitations", invAuth, t1);
    await expect304("/api/invitations", invAuth, t2);

    // 组织者把人移除（撤销未接受的 token 是删行）。先把状态改回
    // pending 不影响撤销条件（只看 acceptedAt），直接删参与者。
    const revoke = await app.inject({
      method: "DELETE", url: `/api/events/${ev.id}/attendees`,
      headers: { cookie: orgAuth }, payload: { email: invitee.email },
    });
    expect(revoke.statusCode, revoke.body.slice(0, 200)).toBe(200);
    const t3 = await expect200WithOldTag("/api/invitations", invAuth, t2);
    const list = await get("/api/invitations", invAuth);
    expect((list.json() as { invitations: unknown[] }).invitations).toHaveLength(0);
    await expect304("/api/invitations", invAuth, t3);
  });
});

describe("GET /calendars 的 ETag", () => {
  it("建历 / 改历 / 历内写事件 / 删历，每一步都让旧 ETag 失效", async () => {
    const t0 = await etagOf("/api/calendars", orgAuth, "private, no-cache");
    await expect304("/api/calendars", orgAuth, t0);

    const created = await app.inject({
      method: "POST", url: "/api/calendars", headers: { cookie: orgAuth },
      payload: { name: "新日历" },
    });
    expect(created.statusCode, created.body.slice(0, 200)).toBe(201);
    const newCalId = (created.json() as { id: string }).id;
    const t1 = await expect200WithOldTag("/api/calendars", orgAuth, t0);

    const renamed = await app.inject({
      method: "PATCH", url: `/api/calendars/${newCalId}`, headers: { cookie: orgAuth },
      payload: { name: "改了名" },
    });
    expect(renamed.statusCode, renamed.body.slice(0, 200)).toBe(200);
    const t2 = await expect200WithOldTag("/api/calendars", orgAuth, t1);

    // 历没动、只是往历里写了事件 —— 列表令牌汇了每历 ctag，也要变。
    const ev = await app.inject({
      method: "POST", url: "/api/events", headers: { cookie: orgAuth },
      payload: {
        calendarId: newCalId, summary: "历内事件",
        startsAt: "2026-12-02T01:00:00.000Z", endsAt: "2026-12-02T02:00:00.000Z",
      },
    });
    expect([200, 201], ev.body.slice(0, 200)).toContain(ev.statusCode);
    const t3 = await expect200WithOldTag("/api/calendars", orgAuth, t2);

    const removed = await app.inject({
      method: "DELETE", url: `/api/calendars/${newCalId}`, headers: { cookie: orgAuth },
    });
    expect(removed.statusCode, removed.body.slice(0, 200)).toBe(200);
    const t4 = await expect200WithOldTag("/api/calendars", orgAuth, t3);
    await expect304("/api/calendars", orgAuth, t4);
  });
});

describe("GET /ics/:token 的条件请求", () => {
  const token = "cache-etag-token-0123456789";

  async function feed(etag?: string): Promise<InjectRes> {
    return app.inject({
      method: "GET", url: `/ics/${token}`,
      headers: etag ? { "if-none-match": etag } : {},
    });
  }

  it("内容没变回 304；加事件、删事件、改日历名都让旧 ETag 失效", async () => {
    await db.insert(schema.shareTokens).values({ token, calendarId: cal.id });

    const first = await feed();
    expect(first.statusCode, first.body.slice(0, 200)).toBe(200);
    expect(first.headers["cache-control"]).toBe("public, max-age=300");
    const t0 = first.headers.etag as string;
    expect(t0).toBeTruthy();

    const hit = await feed(t0);
    expect(hit.statusCode).toBe(304);
    expect(hit.headers.etag).toBe(t0);

    // 订阅源里多一个事件。
    const [ev] = await db.insert(schema.events).values({
      calendarId: cal.id, uid: "etag-ics-1", summary: "订阅事件",
      startsAt: new Date("2026-12-03T01:00:00.000Z"), endsAt: new Date("2026-12-03T02:00:00.000Z"),
    }).returning();
    const afterAdd = await feed(t0);
    expect(afterAdd.statusCode).toBe(200);
    expect(afterAdd.body).toContain("订阅事件");
    const t1 = afterAdd.headers.etag as string;
    expect(t1).not.toBe(t0);

    // 软删这个事件：正文里消失，令牌也要变（ctag 把软删行算在内）。
    await db.update(schema.events)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.events.id, ev!.id));
    const afterDelete = await feed(t1);
    expect(afterDelete.statusCode).toBe(200);
    expect(afterDelete.body).not.toContain("订阅事件");
    const t2 = afterDelete.headers.etag as string;
    expect(t2).not.toBe(t1);

    // 只改日历名（事件一动不动）：订阅源抬头变了，令牌跟着变。
    const renamed = await app.inject({
      method: "PATCH", url: `/api/calendars/${cal.id}`, headers: { cookie: orgAuth },
      payload: { name: "改名后的历" },
    });
    expect(renamed.statusCode, renamed.body.slice(0, 200)).toBe(200);
    const afterRename = await feed(t2);
    expect(afterRename.statusCode).toBe(200);
    expect(afterRename.headers.etag).not.toBe(t2);

    const finalHit = await feed(afterRename.headers.etag as string);
    expect(finalHit.statusCode).toBe(304);
  });
});
