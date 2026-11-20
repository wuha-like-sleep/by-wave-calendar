// CalDAV PUT 编辑事件 → 站内 event_updated 通知（通知第二轮的遗留缺口）。
//
// 删除早就走 cancelEvent 有通知，PUT 编辑此前不触发任何站内通知。本套件
// 钉住接入后的口径，必须与网页/API 的 notifyEventUpdated 完全一致：
//   · 实质变更（这里用改时间）→ 共享成员与已注册参与者各收到一条；
//   · 只改描述 → 谁都不通知；
//   · 关了 notify_event_changes 的成员 → 不通知（同批其他人照常）；
//   · 30 分钟内连环 PUT → 合并成一条（同步客户端的批量/重试 PUT 不轰炸）。
//
// 生产者在路由里是 fire-and-forget 的旁路，断言统一走轮询等行落库。

import { vi, beforeAll, beforeEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
vi.mock("../../src/lib/mailer.js", () => ({ sendMail: vi.fn(async () => ({ ok: true })), isMailerEnabled: vi.fn(async () => true) }));
vi.mock("../../src/lib/calendar_sync/queue.js", () => ({ requestCalendarSync: vi.fn(async () => undefined) }));
vi.mock("../../src/lib/apns.js", () => ({ pushEventChanged: vi.fn(async () => undefined) }));
vi.mock("../../src/lib/webhooks.js", () => ({ dispatchWebhook: vi.fn(async () => undefined), eventToWebhookPayload: (event: unknown) => event }));
vi.mock("../../src/lib/push.js", () => ({
  pushToUser: vi.fn(async () => ({ sent: 0, pruned: 0 })),
}));

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://u:p@127.0.0.1:1/db";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";

import Fastify, { type FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { ensureSchema, resetDb, db, schema, makeCalendar, makeMembership } from "./harness.js";
import { hashPassword } from "../../src/lib/password.js";
import { invalidateCalDavAuthCache } from "../../src/lib/caldav_auth.js";
import { caldavRoutes } from "../../src/web/caldav.js";

const PASSWORD = "caldav-test-pw-123456";
const CRLF = "\r\n";

let app: FastifyInstance;
let owner: { id: string; email: string };
let member: { id: string; email: string };
let offMember: { id: string; email: string };
let attendee: { id: string; email: string };
let cal: { id: string };

async function makeUserRow(email: string) {
  const [u] = await db
    .insert(schema.users)
    .values({ email, emailVerified: true, passwordHash: await hashPassword(PASSWORD) })
    .returning();
  return u!;
}

beforeAll(async () => {
  await ensureSchema();
  app = Fastify({ logger: false });
  app.addHttpMethod("PROPFIND", { hasBody: true });
  app.addHttpMethod("REPORT", { hasBody: true });
  app.addContentTypeParser("text/calendar", { parseAs: "string" }, (_req, body, done) => done(null, body as string));
  await app.register(caldavRoutes);
  await app.ready();
});

beforeEach(async () => {
  await resetDb();
  invalidateCalDavAuthCache();
  owner = await makeUserRow("put-owner@example.com");
  member = await makeUserRow("put-member@example.com");
  offMember = await makeUserRow("put-offmember@example.com");
  attendee = await makeUserRow("put-attendee@example.com");
  await db.update(schema.users)
    .set({ notifyEventChanges: false })
    .where(eq(schema.users.id, offMember.id));
  cal = await makeCalendar(owner.id, "CalDAV Shared");
  await makeMembership(cal.id, member.id);
  await makeMembership(cal.id, offMember.id);
});

function authHeader(email: string): string {
  return "Basic " + Buffer.from(`${email}:${PASSWORD}`).toString("base64");
}

function icsBody(opts: {
  uid: string;
  summary?: string;
  start: string;
  end: string;
  description?: string;
  attendees?: string[];
}): string {
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//test//EN",
    "BEGIN:VEVENT",
    `UID:${opts.uid}`,
    `SUMMARY:${opts.summary ?? "季度复盘"}`,
    `DTSTART:${opts.start}`,
    `DTEND:${opts.end}`,
  ];
  if (opts.description) lines.push(`DESCRIPTION:${opts.description}`);
  for (const email of opts.attendees ?? []) {
    lines.push(`ATTENDEE;CN=${email};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${email}`);
  }
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.join(CRLF) + CRLF;
}

async function put(uid: string, body: string) {
  return app.inject({
    method: "PUT",
    url: `/caldav/${owner.id}/${cal.id}/${uid}.ics`,
    headers: { authorization: authHeader(owner.email), "content-type": "text/calendar; charset=utf-8" },
    payload: body,
  });
}

async function updatedRows(userId: string) {
  const rows = await db.select().from(schema.notifications)
    .where(eq(schema.notifications.userId, userId))
    .orderBy(schema.notifications.createdAt);
  return rows.filter((r) => r.type === "event_updated");
}

async function waitUpdated(userId: string, min: number, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let rows = await updatedRows(userId);
  while (rows.length < min && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    rows = await updatedRows(userId);
  }
  return rows;
}

async function settle(ms = 600) {
  await new Promise((r) => setTimeout(r, ms));
}

const UID = "put-notify-1";
const BASE = { uid: UID, start: "20260714T010000Z", end: "20260714T020000Z", attendees: ["put-attendee@example.com"] };

describe("CalDAV PUT 事件变更通知", () => {
  it("改时间 → 成员与已注册参与者各收到一条 event_updated，操作者本人没有", async () => {
    const created = await put(UID, icsBody(BASE));
    expect(created.statusCode).toBe(201);
    await settle();
    // 建事件不发「已更新」：成员此时应当一条都没有。
    expect(await updatedRows(member.id)).toHaveLength(0);

    const updated = await put(UID, icsBody({ ...BASE, start: "20260714T030000Z", end: "20260714T040000Z" }));
    expect(updated.statusCode).toBe(204);

    expect(await waitUpdated(member.id, 1)).toHaveLength(1);
    expect(await waitUpdated(attendee.id, 1)).toHaveLength(1);
    await settle();
    expect(await updatedRows(owner.id)).toHaveLength(0);
  });

  it("只改描述 → 谁都不通知", async () => {
    expect((await put(UID, icsBody({ ...BASE, description: "第一版描述" }))).statusCode).toBe(201);
    await settle();
    expect((await put(UID, icsBody({ ...BASE, description: "改了描述，别的没动" }))).statusCode).toBe(204);
    await settle();
    expect(await updatedRows(member.id)).toHaveLength(0);
    expect(await updatedRows(attendee.id)).toHaveLength(0);
  });

  it("关了事件变更偏好的成员不收，其他人照常", async () => {
    expect((await put(UID, icsBody(BASE))).statusCode).toBe(201);
    await settle();
    expect((await put(UID, icsBody({ ...BASE, start: "20260714T050000Z", end: "20260714T060000Z" }))).statusCode).toBe(204);
    expect(await waitUpdated(member.id, 1)).toHaveLength(1);
    await settle();
    expect(await updatedRows(offMember.id)).toHaveLength(0);
  });

  it("30 分钟内连续 PUT 两次实质变更 → 合并成一条", async () => {
    expect((await put(UID, icsBody(BASE))).statusCode).toBe(201);
    await settle();
    expect((await put(UID, icsBody({ ...BASE, start: "20260714T030000Z", end: "20260714T040000Z" }))).statusCode).toBe(204);
    expect(await waitUpdated(member.id, 1)).toHaveLength(1);
    expect((await put(UID, icsBody({ ...BASE, start: "20260714T070000Z", end: "20260714T080000Z" }))).statusCode).toBe(204);
    await settle();
    expect(await updatedRows(member.id)).toHaveLength(1);
    expect(await updatedRows(attendee.id)).toHaveLength(1);
  });
});
