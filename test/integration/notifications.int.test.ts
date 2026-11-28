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
import { desc, eq } from "drizzle-orm";
import { ensureSchema, resetDb, db, schema, makeUser, makeCalendar, loginAs } from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://u:p@127.0.0.1:1/db";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";

const { webRoutes } = await import("../../src/web/index.js");
const { notificationRoutes } = await import("../../src/routes/notifications.js");
const { availableSlots, bookSlot, cancelBooking } = await import("../../src/lib/booking.js");
const { makeT, localeOptionLabel, LOCALES, SITE_LOCALE_OPTIONS } = await import("../../src/lib/i18n.js");
const { env } = await import("../../src/env.js");
const { jsonForScript } = await import("../../src/lib/script_json.js");

let app: FastifyInstance;
let owner: Awaited<ReturnType<typeof makeUser>>;
let invitee: Awaited<ReturnType<typeof makeUser>>;
let calendar: Awaited<ReturnType<typeof makeCalendar>>;
let link: typeof schema.bookingLinks.$inferSelect;
let ownerAuth: string;
let inviteeAuth: string;

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
      localeLabel: (entry: (typeof LOCALES)[number], gloss = false) => localeOptionLabel(entry, "zh-CN", gloss),
      siteLocaleOptions: SITE_LOCALE_OPTIONS, siteDefaultLocale: "zh-CN",
      sitePalette: "indigo", siteDensity: "comfortable", themeMode: "system", currentUser: null,
      registrationOpen: true, registrationMode: "open", ssoEnabled: false, ssoLabel: "", ssoProviders: [],
      themePalette: "indigo", themeDensity: "comfortable", currentPath: "/app/notifications", jsonForScript,
    },
  });
  await app.register(webRoutes);
  await app.register(notificationRoutes, { prefix: "/api" });
  await app.ready();
});
afterAll(async () => { await app.close(); });

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDb();
  owner = await makeUser("notif-owner@example.com");
  invitee = await makeUser("notif-invitee@example.com");
  calendar = await makeCalendar(owner.id, "Team Cal");
  const everyDay: Record<string, string[][]> = {};
  for (let d = 0; d <= 6; d++) everyDay[String(d)] = [["00:00", "23:30"]];
  [link] = await db.insert(schema.bookingLinks).values({
    userId: owner.id, calendarId: calendar.id, slug: "chat", title: "Intro Call",
    durationMinutes: 30, minNoticeHours: 0, maxDaysAhead: 14, weeklyAvailability: everyDay,
  }).returning() as [typeof schema.bookingLinks.$inferSelect];
  ownerAuth = await loginAs(app, owner.id);
  inviteeAuth = await loginAs(app, invitee.id);
});

async function rowsFor(userId: string) {
  return db.select().from(schema.notifications)
    .where(eq(schema.notifications.userId, userId))
    .orderBy(desc(schema.notifications.createdAt));
}
async function unreadCount(cookieHeader: string) {
  const res = await app.inject({ url: "/api/notifications/unread-count", headers: { cookie: cookieHeader } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { count: number };
}
async function csrfFrom(url: string, cookieHeader: string): Promise<string> {
  const res = await app.inject({ url, headers: { cookie: cookieHeader } });
  expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
  const m = res.body.match(/name="_csrf" value="([^"]+)"/);
  expect(m, `no csrf token on ${url}`).not.toBeNull();
  return m![1]!;
}

describe("站内通知", () => {
  it("未读数接口未登录返回 401", async () => {
    const res = await app.inject({ url: "/api/notifications/unread-count" });
    expect(res.statusCode).toBe(401);
  });

  it("新预约给所有者写一条通知，计数与 ETag 随状态变化", async () => {
    expect(await unreadCount(ownerAuth)).toEqual({ count: 0 });

    const slot = (await availableSlots(link, new Date(), 14))[0]!;
    const created = await bookSlot({ link, ...slot, guestName: "Guest", guestEmail: "guest@example.com" });

    const rows = await rowsFor(owner.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("booking_created");
    expect(rows[0]!.readAt).toBeNull();
    expect(rows[0]!.url).toBe(`/app?event=${created.event.id}&cal=${calendar.id}`);
    expect(rows[0]!.title).toContain("Intro Call");

    const first = await app.inject({ url: "/api/notifications/unread-count", headers: { cookie: ownerAuth } });
    expect(first.json()).toEqual({ count: 1 });
    const etag = first.headers.etag;
    expect(etag).toBeTruthy();

    // 没变化时带上 ETag 应命中 304，角标轮询不下载正文。
    const cached = await app.inject({
      url: "/api/notifications/unread-count",
      headers: { cookie: ownerAuth, "if-none-match": etag as string },
    });
    expect(cached.statusCode).toBe(304);
    expect(cached.body).toBe("");

    // 全部标已读后计数归零，ETag 也随之变化。
    const csrf = await csrfFrom("/app/notifications", ownerAuth);
    const readAll = await app.inject({
      method: "POST", url: "/app/notifications/read-all",
      headers: { cookie: ownerAuth }, payload: { _csrf: csrf },
    });
    expect(readAll.statusCode).toBe(302);
    expect(await unreadCount(ownerAuth)).toEqual({ count: 0 });
    const after = await app.inject({
      url: "/api/notifications/unread-count",
      headers: { cookie: ownerAuth, "if-none-match": etag as string },
    });
    expect(after.statusCode).toBe(200);
    expect(after.headers.etag).not.toBe(etag);
  });

  it("取消预约再写一条；重复取消不重复写", async () => {
    const slot = (await availableSlots(link, new Date(), 14))[0]!;
    const created = await bookSlot({ link, ...slot, guestName: "Guest", guestEmail: "guest@example.com" });
    const first = await cancelBooking(created.booking.cancelToken);
    expect(first).toEqual({ found: true, alreadyCancelled: false });

    let rows = await rowsFor(owner.id);
    expect(rows.map((r) => r.type)).toEqual(["booking_cancelled", "booking_created"]);
    // 事件已经删了，取消通知不能深链到它，落到预约管理页。
    expect(rows[0]!.url).toBe("/app/booking-links");

    const again = await cancelBooking(created.booking.cancelToken);
    expect(again.alreadyCancelled).toBe(true);
    rows = await rowsFor(owner.id);
    expect(rows).toHaveLength(2);
  });

  it("日历邀请除邮件外也给已注册的被邀者写站内通知，点开跳邀请页并标已读", async () => {
    const csrf = await csrfFrom("/app/settings/notifications", ownerAuth);
    const res = await app.inject({
      method: "POST", url: `/app/calendars/${calendar.id}/invitations`,
      headers: { cookie: ownerAuth },
      payload: { _csrf: csrf, email: invitee.email, role: "viewer" },
    });
    expect(res.statusCode).toBe(302);

    const rows = await rowsFor(invitee.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("calendar_invitation");
    expect(rows[0]!.url).toMatch(/^\/invite\/[A-Za-z0-9_-]{16,}$/);
    expect(await unreadCount(inviteeAuth)).toEqual({ count: 1 });

    // 通知页能打开并列出这条
    const page = await app.inject({ url: "/app/notifications", headers: { cookie: inviteeAuth } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(rows[0]!.title);

    // 点开：标已读 + 只跳到通知自己存的地址
    const csrf2 = await csrfFrom("/app/notifications", inviteeAuth);
    const open = await app.inject({
      method: "POST", url: `/app/notifications/${rows[0]!.id}/open`,
      headers: { cookie: inviteeAuth }, payload: { _csrf: csrf2 },
    });
    expect(open.statusCode).toBe(302);
    expect(open.headers.location).toBe(rows[0]!.url);
    expect(await unreadCount(inviteeAuth)).toEqual({ count: 0 });

    // 别人的通知不能通过 open 端点碰
    const foreign = await app.inject({
      method: "POST", url: `/app/notifications/${rows[0]!.id}/open`,
      headers: { cookie: ownerAuth }, payload: { _csrf: csrf },
    });
    expect(foreign.statusCode).toBe(302);
    expect(foreign.headers.location).toBe("/app/notifications");
  });

  it("邀请未注册的邮箱不写站内通知（没有收件人）", async () => {
    const csrf = await csrfFrom("/app/settings/notifications", ownerAuth);
    const res = await app.inject({
      method: "POST", url: `/app/calendars/${calendar.id}/invitations`,
      headers: { cookie: ownerAuth },
      payload: { _csrf: csrf, email: "stranger@example.com", role: "editor" },
    });
    expect(res.statusCode).toBe(302);
    expect(await rowsFor(owner.id)).toHaveLength(0);
    expect(await db.select().from(schema.notifications)).toHaveLength(0);
  });

  it("通知偏好保存：没勾的渠道落为关，勾上的落为开", async () => {
    const csrf = await csrfFrom("/app/settings/notifications", ownerAuth);
    const off = await app.inject({
      method: "POST", url: "/app/settings/notification-prefs",
      headers: { cookie: ownerAuth },
      payload: { _csrf: csrf, reminderPush: "on" },
    });
    expect(off.statusCode).toBe(302);
    let [u] = await db.select().from(schema.users).where(eq(schema.users.id, owner.id));
    expect(u!.notifyReminderEmail).toBe(false);
    expect(u!.notifyReminderPush).toBe(true);

    const csrf2 = await csrfFrom("/app/settings/notifications", ownerAuth);
    const on = await app.inject({
      method: "POST", url: "/app/settings/notification-prefs",
      headers: { cookie: ownerAuth },
      payload: { _csrf: csrf2, reminderEmail: "on", reminderPush: "on" },
    });
    expect(on.statusCode).toBe(302);
    [u] = await db.select().from(schema.users).where(eq(schema.users.id, owner.id));
    expect(u!.notifyReminderEmail).toBe(true);
    expect(u!.notifyReminderPush).toBe(true);

    // 第二轮新增的两个开关（事件变更 / 收件箱推送）同表单同口径。
    const csrf3 = await csrfFrom("/app/settings/notifications", ownerAuth);
    const both = await app.inject({
      method: "POST", url: "/app/settings/notification-prefs",
      headers: { cookie: ownerAuth },
      payload: { _csrf: csrf3, reminderEmail: "on", reminderPush: "on", eventChanges: "on", inboxPush: "on" },
    });
    expect(both.statusCode).toBe(302);
    [u] = await db.select().from(schema.users).where(eq(schema.users.id, owner.id));
    expect(u!.notifyEventChanges).toBe(true);
    expect(u!.notifyInboxPush).toBe(true);

    const csrf4 = await csrfFrom("/app/settings/notifications", ownerAuth);
    const neither = await app.inject({
      method: "POST", url: "/app/settings/notification-prefs",
      headers: { cookie: ownerAuth },
      payload: { _csrf: csrf4, reminderEmail: "on", reminderPush: "on", eventChanges: "on" },
    });
    expect(neither.statusCode).toBe(302);
    [u] = await db.select().from(schema.users).where(eq(schema.users.id, owner.id));
    expect(u!.notifyEventChanges).toBe(true);
    expect(u!.notifyInboxPush).toBe(false);
  });
});
