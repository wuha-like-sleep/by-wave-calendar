// 事件邀请与 RSVP 全链路：邀请 → 站内通知 → 回复 → 组织者收到 →
// 提议新时间 → 组织者裁决 → 事件改期 + 全体通知 + 提议人回执。
//
// 判据分工：
//   · 状态机与权限以数据库行 + HTTP 状态码为准（通知是旁路，
//     断言通知到达是为了钉住「组织者能实时看到」这条产品要求）；
//   · 越权用「换一个用户做同样的事」来钉，不测内部函数。

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
vi.mock("../../src/lib/mailer.js", () => ({ sendMail: vi.fn(async () => ({ ok: true })), isMailerEnabled: vi.fn(async () => true) }));
vi.mock("../../src/lib/calendar_sync/queue.js", () => ({ requestCalendarSync: vi.fn(async () => undefined) }));
vi.mock("../../src/lib/apns.js", () => ({ pushEventChanged: vi.fn(async () => undefined) }));
vi.mock("../../src/lib/webhooks.js", () => ({ dispatchWebhook: vi.fn(async () => undefined), eventToWebhookPayload: (event: unknown) => event }));

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import view from "@fastify/view";
import ejs from "ejs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { ensureSchema, resetDb, db, schema, makeUser, makeCalendar, loginAs } from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";

const { webRoutes } = await import("../../src/web/index.js");
const { eventRoutes } = await import("../../src/routes/events.js");
const { makeT, LOCALES, SITE_LOCALE_OPTIONS } = await import("../../src/lib/i18n.js");
const { env } = await import("../../src/env.js");
const { jsonForScript } = await import("../../src/lib/script_json.js");

let app: FastifyInstance;
let organizer: Awaited<ReturnType<typeof makeUser>>;
let invitee: Awaited<ReturnType<typeof makeUser>>;
let secondInvitee: Awaited<ReturnType<typeof makeUser>>;
let stranger: Awaited<ReturnType<typeof makeUser>>;
let calendar: Awaited<ReturnType<typeof makeCalendar>>;
let organizerAuth: string;
let inviteeAuth: string;
let strangerAuth: string;

beforeAll(async () => {
  await ensureSchema();
  app = Fastify({ logger: false });
  await app.register(cookie, { secret: env.SESSION_SECRET });
  await app.register(formbody);
  await app.register(view, {
    engine: { ejs }, root: path.resolve("src/views"), propertyName: "view", options: { async: false },
    defaultContext: {
      t: makeT("zh-CN"), siteName: "ByWave", siteLogoUrl: null, icpNumber: null, icpUrl: "",
      assetVersion: "t", jsBasePath: "/static/js", cspNonce: "n", currentLocale: "zh-CN", locales: LOCALES,
      siteLocaleOptions: SITE_LOCALE_OPTIONS, siteDefaultLocale: "zh-CN",
      sitePalette: "indigo", siteDensity: "comfortable", themeMode: "system", currentUser: null,
      registrationOpen: true, registrationMode: "open", ssoEnabled: false, ssoLabel: "", ssoProviders: [],
      themePalette: "indigo", themeDensity: "comfortable", currentPath: "/app", jsonForScript,
    },
  });
  await app.register(webRoutes);
  await app.register(eventRoutes, { prefix: "/api" });
  await app.ready();
});
afterAll(async () => { await app.close(); });

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDb();
  organizer = await makeUser("organizer@example.com");
  invitee = await makeUser("invitee@example.com");
  secondInvitee = await makeUser("second@example.com");
  stranger = await makeUser("stranger@example.com");
  calendar = await makeCalendar(organizer.id, "Team");
  organizerAuth = await loginAs(app, organizer.id);
  inviteeAuth = await loginAs(app, invitee.id);
  strangerAuth = await loginAs(app, stranger.id);
});

/** 建一个带三位参与者（两位注册 + 一位纯邮箱）的事件，返回 id 与各人的 token。 */
async function makeInvitedEvent() {
  const res = await app.inject({
    method: "POST", url: "/api/events",
    headers: { cookie: organizerAuth },
    payload: {
      calendarId: calendar.id, summary: "季度规划会",
      startsAt: "2026-11-21T01:00:00.000Z", endsAt: "2026-11-21T02:00:00.000Z",
      extra: { attendees: ["invitee@example.com", "second@example.com", "external@example.com"] },
    },
  });
  expect([200, 201], `建事件失败: ${res.body.slice(0, 300)}`).toContain(res.statusCode);
  const event = JSON.parse(res.body) as { id: string };
  const tokens = await db.select().from(schema.eventInviteTokens)
    .where(eq(schema.eventInviteTokens.sourceEventId, event.id));
  const byEmail = new Map(tokens.map((t) => [t.recipientEmail, t]));
  return { eventId: event.id, byEmail };
}

async function notifTypesFor(userId: string): Promise<string[]> {
  const rows = await db.select().from(schema.notifications)
    .where(eq(schema.notifications.userId, userId));
  return rows.map((r) => r.type);
}

async function tokenRow(eventId: string, email: string) {
  const [row] = await db.select().from(schema.eventInviteTokens)
    .where(and(eq(schema.eventInviteTokens.sourceEventId, eventId), eq(schema.eventInviteTokens.recipientEmail, email)));
  return row;
}

describe("邀请到达", () => {
  it("注册受邀者收到站内 event_invitation；纯邮箱参与者不写站内通知", async () => {
    const { eventId } = await makeInvitedEvent();
    expect(await notifTypesFor(invitee.id)).toContain("event_invitation");
    expect(await notifTypesFor(secondInvitee.id)).toContain("event_invitation");
    // 组织者本人不该收到自己发的邀请
    expect(await notifTypesFor(organizer.id)).not.toContain("event_invitation");
    // 三个人都有 token 行（外部参与者靠邮件 + token 页）
    expect(await tokenRow(eventId, "external@example.com")).toBeTruthy();
  });

  it("GET /api/invitations 只列自己的邀请，带组织者与事件信息", async () => {
    await makeInvitedEvent();
    const mine = await app.inject({ method: "GET", url: "/api/invitations", headers: { cookie: inviteeAuth } });
    expect(mine.statusCode).toBe(200);
    const body = JSON.parse(mine.body) as { invitations: { organizer: { email: string } | null; event: { summary: string } }[] };
    expect(body.invitations).toHaveLength(1);
    expect(body.invitations[0]!.event.summary).toBe("季度规划会");
    expect(body.invitations[0]!.organizer?.email).toBe("organizer@example.com");
    const none = await app.inject({ method: "GET", url: "/api/invitations", headers: { cookie: strangerAuth } });
    expect(JSON.parse(none.body).invitations).toHaveLength(0);
  });
});

describe("RSVP 回复", () => {
  it("网页回应页提交 → 状态落库，组织者收到 rsvp_response", async () => {
    const { eventId, byEmail } = await makeInvitedEvent();
    const tok = byEmail.get("invitee@example.com")!;
    const res = await app.inject({
      method: "POST", url: `/event-invite/${tok.token}/respond`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ status: "accepted" }).toString(),
    });
    expect(res.statusCode).toBe(302);
    expect((await tokenRow(eventId, "invitee@example.com"))?.responseStatus).toBe("accepted");
    expect(await notifTypesFor(organizer.id)).toContain("rsvp_response");
  });

  it("API 回应可改口；乱编的 token 回应被拒且不写任何东西", async () => {
    const { eventId, byEmail } = await makeInvitedEvent();
    const tok = byEmail.get("second@example.com")!;
    const ok = await app.inject({
      method: "POST", url: `/api/invitations/${tok.token}/respond`,
      payload: { status: "declined" },
    });
    expect(ok.statusCode).toBe(200);
    expect((await tokenRow(eventId, "second@example.com"))?.responseStatus).toBe("declined");
    const before = (await db.select().from(schema.notifications)).length;
    const bad = await app.inject({
      method: "POST", url: "/api/invitations/not-a-real-token-000000/respond",
      payload: { status: "accepted" },
    });
    expect(bad.statusCode).toBe(410);
    expect((await db.select().from(schema.notifications)).length).toBe(before);
  });

  it("组织者的参与者接口能看到每个人的回复状态", async () => {
    const { eventId, byEmail } = await makeInvitedEvent();
    const tok = byEmail.get("invitee@example.com")!;
    await app.inject({ method: "POST", url: `/api/invitations/${tok.token}/respond`, payload: { status: "tentative" } });
    const res = await app.inject({ method: "GET", url: `/api/events/${eventId}/attendees`, headers: { cookie: organizerAuth } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { tokens: { recipientEmail: string; responseStatus: string }[] };
    expect(body.tokens.find((t) => t.recipientEmail === "invitee@example.com")?.responseStatus).toBe("tentative");
    // 非组织者看不到名单细节
    const denied = await app.inject({ method: "GET", url: `/api/events/${eventId}/attendees`, headers: { cookie: strangerAuth } });
    expect(denied.statusCode).toBe(404);
  });
});

describe("提议新时间闭环", () => {
  async function propose(token: string, startsAt: string, endsAt: string) {
    return app.inject({ method: "POST", url: `/api/invitations/${token}/propose`, payload: { startsAt, endsAt } });
  }

  it("提议 → 组织者收到通知；再提一次，旧提议被 superseded", async () => {
    const { byEmail } = await makeInvitedEvent();
    const tok = byEmail.get("invitee@example.com")!;
    const first = await propose(tok.token, "2026-11-21T03:00:00.000Z", "2026-11-21T04:00:00.000Z");
    expect(first.statusCode).toBe(200);
    expect(await notifTypesFor(organizer.id)).toContain("time_proposal");
    const second = await propose(tok.token, "2026-11-21T05:00:00.000Z", "2026-11-21T06:00:00.000Z");
    expect(second.statusCode).toBe(200);
    const rows = await db.select().from(schema.eventTimeProposals)
      .where(eq(schema.eventTimeProposals.inviteToken, tok.token));
    expect(rows.filter((r) => r.status === "pending")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "superseded")).toHaveLength(1);
    // 时间倒置直接 400，不落新行
    const bad = await propose(tok.token, "2026-11-21T06:00:00.000Z", "2026-11-21T05:00:00.000Z");
    expect(bad.statusCode).toBe(400);
    expect((await db.select().from(schema.eventTimeProposals)
      .where(eq(schema.eventTimeProposals.inviteToken, tok.token)))).toHaveLength(2);
  });

  it("接受提议 → 事件改期、提议人收到回执、其他参与者收到 event_updated", async () => {
    const { eventId, byEmail } = await makeInvitedEvent();
    const tok = byEmail.get("invitee@example.com")!;
    const created = await propose(tok.token, "2026-11-21T03:00:00.000Z", "2026-11-21T04:00:00.000Z");
    const proposalId = (JSON.parse(created.body) as { proposal: { id: string } }).proposal.id;
    const res = await app.inject({
      method: "POST", url: `/api/events/${eventId}/proposals/${proposalId}/accept`,
      headers: { cookie: organizerAuth },
    });
    expect(res.statusCode).toBe(200);
    const [event] = await db.select().from(schema.events).where(eq(schema.events.id, eventId));
    expect(event!.startsAt.toISOString()).toBe("2026-11-21T03:00:00.000Z");
    expect(event!.endsAt.toISOString()).toBe("2026-11-21T04:00:00.000Z");
    const [proposal] = await db.select().from(schema.eventTimeProposals)
      .where(eq(schema.eventTimeProposals.id, proposalId));
    expect(proposal!.status).toBe("accepted");
    expect(await notifTypesFor(invitee.id)).toContain("time_proposal_result");
    expect(await notifTypesFor(secondInvitee.id)).toContain("event_updated");
    // 重复裁决 → 409
    const again = await app.inject({
      method: "POST", url: `/api/events/${eventId}/proposals/${proposalId}/accept`,
      headers: { cookie: organizerAuth },
    });
    expect(again.statusCode).toBe(409);
  });

  it("拒绝提议 → 事件时间不变，提议人收到回执", async () => {
    const { eventId, byEmail } = await makeInvitedEvent();
    const tok = byEmail.get("invitee@example.com")!;
    const created = await propose(tok.token, "2026-11-21T03:00:00.000Z", "2026-11-21T04:00:00.000Z");
    const proposalId = (JSON.parse(created.body) as { proposal: { id: string } }).proposal.id;
    const res = await app.inject({
      method: "POST", url: `/api/events/${eventId}/proposals/${proposalId}/decline`,
      headers: { cookie: organizerAuth },
    });
    expect(res.statusCode).toBe(200);
    const [event] = await db.select().from(schema.events).where(eq(schema.events.id, eventId));
    expect(event!.startsAt.toISOString()).toBe("2026-11-21T01:00:00.000Z");
    const [proposal] = await db.select().from(schema.eventTimeProposals)
      .where(eq(schema.eventTimeProposals.id, proposalId));
    expect(proposal!.status).toBe("declined");
    expect(await notifTypesFor(invitee.id)).toContain("time_proposal_result");
  });

  it("非组织者裁决别人的提议 → 404，提议保持 pending", async () => {
    const { eventId, byEmail } = await makeInvitedEvent();
    const tok = byEmail.get("invitee@example.com")!;
    const created = await propose(tok.token, "2026-11-21T03:00:00.000Z", "2026-11-21T04:00:00.000Z");
    const proposalId = (JSON.parse(created.body) as { proposal: { id: string } }).proposal.id;
    const res = await app.inject({
      method: "POST", url: `/api/events/${eventId}/proposals/${proposalId}/accept`,
      headers: { cookie: strangerAuth },
    });
    expect(res.statusCode).toBe(404);
    const [proposal] = await db.select().from(schema.eventTimeProposals)
      .where(eq(schema.eventTimeProposals.id, proposalId));
    expect(proposal!.status).toBe("pending");
  });

  it("事件取消后：提议与回复都被拒", async () => {
    const { eventId, byEmail } = await makeInvitedEvent();
    const tok = byEmail.get("invitee@example.com")!;
    await db.update(schema.events).set({ deletedAt: new Date() }).where(eq(schema.events.id, eventId));
    const p = await propose(tok.token, "2026-11-21T03:00:00.000Z", "2026-11-21T04:00:00.000Z");
    expect(p.statusCode).toBe(410);
    const r = await app.inject({ method: "POST", url: `/api/invitations/${tok.token}/respond`, payload: { status: "accepted" } });
    expect(r.statusCode).toBe(410);
    expect((await tokenRow(eventId, "invitee@example.com"))?.responseStatus).toBe("pending");
  });

  it("网页提议表单按事件时区（本夹具为 UTC）解释墙上时间", async () => {
    const { byEmail } = await makeInvitedEvent();
    const tok = byEmail.get("external@example.com")!;
    const res = await app.inject({
      method: "POST", url: `/event-invite/${tok.token}/propose`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ start: "2026-11-22T10:00", end: "2026-11-22T11:00", note: "这个时间我更方便" }).toString(),
    });
    expect(res.statusCode).toBe(302);
    const [proposal] = await db.select().from(schema.eventTimeProposals)
      .where(eq(schema.eventTimeProposals.inviteToken, tok.token));
    expect(proposal!.proposedStartsAt.toISOString()).toBe("2026-11-22T10:00:00.000Z");
    expect(proposal!.note).toBe("这个时间我更方便");
    expect(proposal!.proposerEmail).toBe("external@example.com");
  });
});
