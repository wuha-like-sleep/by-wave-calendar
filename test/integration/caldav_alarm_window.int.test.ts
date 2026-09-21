// CalDAV PUT 的两条口径，从 HTTP 真实打进去。
//
// ① 「上传里没有 VALARM 就是用户删了提醒」只在**能证明客户端手上是当前版本**时成立。
//    客户端缓存的可能是「服务端还不会合成 VALARM」那个年代抓的副本；上线既不改
//    events.updated_at 也不改行数，etag / ctag 都没变，它不会重新拉。用户第一次在手机上
//    碰这个事件，传上来的正是那份没有 VALARM 的旧副本 —— 他什么都没删，网页上设的提醒没了。
//    唯一的证据是 If-Match 命中当前 etag。
// ② 参与者在库里只存一种形状（邮箱字符串数组），CalDAV 上来的对象数组在写入时就收口。
//
// 为什么非得从 HTTP 打进去：这两处判断都在**调用点**（putEvent 里的 If-Match 分支、
// extraPatch 那几行），直调 applyAlarmsFromPut / attendeeEmails 的测试结构上看不见
// 「路由到底把什么证据喂给了它」。
import { vi, beforeAll, beforeEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

import Fastify from "fastify";
import { and, eq } from "drizzle-orm";
import { ensureSchema, resetDb, db, schema, makeCalendar } from "./harness.js";
import { hashPassword } from "../../src/lib/password.js";
import { invalidateCalDavAuthCache } from "../../src/lib/caldav_auth.js";
import { caldavRoutes } from "../../src/web/caldav.js";

beforeAll(async () => { await ensureSchema(); });
beforeEach(async () => { await resetDb(); invalidateCalDavAuthCache(); });

const PASSWORD = "caldav-test-pw-123456";
const CRLF = "\r\n";

async function makeAuthedUser(email: string) {
  const [u] = await db
    .insert(schema.users)
    .values({ email, emailVerified: true, passwordHash: await hashPassword(PASSWORD) })
    .returning();
  return u!;
}

async function buildApp() {
  const app = Fastify({ logger: false });
  // 这几个方法 Fastify 默认不认，生产里同样在 server.ts 里先声明。
  app.addHttpMethod("PROPFIND", { hasBody: true });
  app.addHttpMethod("REPORT", { hasBody: true });
  app.addContentTypeParser("text/calendar", { parseAs: "string" }, (_req, body, done) => done(null, body as string));
  await app.register(caldavRoutes);
  await app.ready();
  return app;
}

function authHeader(email: string): string {
  return "Basic " + Buffer.from(`${email}:${PASSWORD}`).toString("base64");
}

function icsBody(uid: string, opts: { triggers?: string[]; attendees?: string[] } = {}): string {
  const alarms = (opts.triggers ?? []).flatMap((t) => [
    "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:提醒", t, "END:VALARM",
  ]);
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//test//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "SUMMARY:季度复盘",
    "DTSTART:20260610T090000Z",
    "DTEND:20260610T110000Z",
    ...(opts.attendees ?? []),
    ...alarms,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join(CRLF) + CRLF;
}

type App = Awaited<ReturnType<typeof buildApp>>;
type User = { id: string; email: string };

function put(app: App, user: User, calId: string, uid: string, opts: { triggers?: string[]; attendees?: string[] } = {}, ifMatch?: string) {
  return app.inject({
    method: "PUT",
    url: `/caldav/${user.id}/${calId}/${uid}.ics`,
    headers: {
      authorization: authHeader(user.email),
      "content-type": "text/calendar; charset=utf-8",
      ...(ifMatch ? { "if-match": ifMatch } : {}),
    },
    payload: icsBody(uid, opts),
  });
}

function get(app: App, user: User, calId: string, uid: string) {
  return app.inject({
    method: "GET",
    url: `/caldav/${user.id}/${calId}/${uid}.ics`,
    headers: { authorization: authHeader(user.email) },
  });
}

async function storedExtra(calId: string, uid: string): Promise<Record<string, unknown> | null> {
  const [row] = await db.select().from(schema.events)
    .where(and(eq(schema.events.calendarId, calId), eq(schema.events.uid, uid))).limit(1);
  return (row?.extra ?? null) as Record<string, unknown> | null;
}

/** 造一条「网页建的、带提醒的」事件：没有 rawIcs，GET 走按列合成那条路。 */
async function seedWebEvent(calId: string, uid: string, extra: unknown) {
  await db.insert(schema.events).values({
    calendarId: calId, uid, summary: "网页建的",
    startsAt: new Date("2026-06-10T09:00:00Z"),
    endsAt: new Date("2026-06-10T11:00:00Z"),
    extra: extra as object | null,
  });
}

// ---------------------------------------------------------------------------

describe("问题二 · 「没有 VALARM = 删提醒」要有证据", () => {
  it("带 If-Match 且命中当前 etag：删得掉", async () => {
    const app = await buildApp();
    const user = await makeAuthedUser("fresh@example.com");
    const cal = await makeCalendar(user.id);
    const uid = "web-alarm@example.com";
    await seedWebEvent(cal.id, uid, { alarms: [{ trigger: "-PT15M" }] });

    // 真实客户端的顺序：先取回资源（拿 etag），改完带着 If-Match 写回去。
    const fetched = await get(app, user, cal.id, uid);
    expect(fetched.statusCode).toBe(200);
    expect(fetched.body).toContain("BEGIN:VALARM");

    const res = await put(app, user, cal.id, uid, {}, String(fetched.headers.etag));
    expect(res.statusCode).toBeLessThan(300);
    expect((await storedExtra(cal.id, uid))?.alarms).toBeUndefined();
    await app.close();
  });

  it("不带 If-Match 的盲写：提醒**不**被当成用户删的（存量窗口）", async () => {
    const app = await buildApp();
    const user = await makeAuthedUser("stale@example.com");
    const cal = await makeCalendar(user.id);
    const uid = "web-alarm@example.com";
    await seedWebEvent(cal.id, uid, { alarms: [{ trigger: "-PT15M" }], timezone: "Asia/Shanghai" });

    // 手机上那份副本是上线之前抓的，本来就不带 VALARM；用户只是挪了一下事件。
    const res = await put(app, user, cal.id, uid);
    expect(res.statusCode).toBeLessThan(300);
    const extra = await storedExtra(cal.id, uid);
    expect(extra?.alarms).toEqual([{ trigger: "-PT15M" }]);
    expect(extra?.timezone).toBe("Asia/Shanghai");
    await app.close();
  });

  it("If-Match: * 不算证据 —— 它只说明这个资源存在，不说明客户端手上是哪一版", async () => {
    const app = await buildApp();
    const user = await makeAuthedUser("star@example.com");
    const cal = await makeCalendar(user.id);
    const uid = "web-alarm@example.com";
    await seedWebEvent(cal.id, uid, { alarms: [{ trigger: "-PT15M" }] });

    const res = await put(app, user, cal.id, uid, {}, "*");
    expect(res.statusCode).toBeLessThan(300);
    expect((await storedExtra(cal.id, uid))?.alarms).toEqual([{ trigger: "-PT15M" }]);
    await app.close();
  });

  it("过期的 If-Match 照旧 412，不会顺手改成什么样子", async () => {
    const app = await buildApp();
    const user = await makeAuthedUser("stale-etag@example.com");
    const cal = await makeCalendar(user.id);
    const uid = "web-alarm@example.com";
    await seedWebEvent(cal.id, uid, { alarms: [{ trigger: "-PT15M" }] });

    const res = await put(app, user, cal.id, uid, {}, '"0000000000000000000000000000dead"');
    expect(res.statusCode).toBe(412);
    expect((await storedExtra(cal.id, uid))?.alarms).toEqual([{ trigger: "-PT15M" }]);
    await app.close();
  });

  it("盲写带着 VALARM 时照常整组覆盖（保守的只是「一条都没有」那一种）", async () => {
    const app = await buildApp();
    const user = await makeAuthedUser("overwrite@example.com");
    const cal = await makeCalendar(user.id);
    const uid = "web-alarm@example.com";
    await seedWebEvent(cal.id, uid, { alarms: [{ trigger: "-PT15M" }, { trigger: "-P1D" }] });

    const res = await put(app, user, cal.id, uid, { triggers: ["TRIGGER:-PT1H"] });
    expect(res.statusCode).toBeLessThan(300);
    const alarms = (await storedExtra(cal.id, uid))?.alarms as Array<{ trigger: string }>;
    expect(alarms.map((a) => a.trigger)).toEqual(["-PT1H"]);
    await app.close();
  });
});

describe("问题三 · 参与者形状在 CalDAV 这一侧", () => {
  it("网页存的邮箱字符串数组 GET 出去有 ATTENDEE 行（以前一行都没有）", async () => {
    const app = await buildApp();
    const user = await makeAuthedUser("web-attendee@example.com");
    const cal = await makeCalendar(user.id);
    const uid = "web-guests@example.com";
    await seedWebEvent(cal.id, uid, { attendees: ["alice@example.com", "bob@example.com"] });

    const res = await get(app, user, cal.id, uid);
    expect(res.statusCode).toBe(200);
    // RFC 5545 的折行会把长属性行折成 CRLF + 空格，断言前先展开。
    const ics = res.body.replace(/\r?\n[\t ]/g, "");
    expect(ics).toContain("RSVP=TRUE:mailto:alice@example.com");
    expect(ics).toContain("RSVP=TRUE:mailto:bob@example.com");
    await app.close();
  });

  it("PUT 上来的 ATTENDEE 存进库是邮箱字符串数组（库里只留一种形状）", async () => {
    const app = await buildApp();
    const user = await makeAuthedUser("put-attendee@example.com");
    const cal = await makeCalendar(user.id);
    const uid = "phone-guests@example.com";

    const res = await put(app, user, cal.id, uid, {
      attendees: [
        "ATTENDEE;CN=Alice;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:Alice@Example.com",
        "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:bob@example.com",
      ],
    });
    expect(res.statusCode).toBeLessThan(300);
    expect((await storedExtra(cal.id, uid))?.attendees).toEqual(["alice@example.com", "bob@example.com"]);
    await app.close();
  });

  it("一个能用的邮箱都摊不出来时不动这个键 —— 覆盖成空数组等于替用户把人删了", async () => {
    const app = await buildApp();
    const user = await makeAuthedUser("urn@example.com");
    const cal = await makeCalendar(user.id);
    const uid = "web-guests@example.com";
    await seedWebEvent(cal.id, uid, { attendees: ["alice@example.com"] });

    const res = await put(app, user, cal.id, uid, {
      attendees: ["ATTENDEE;PARTSTAT=NEEDS-ACTION:urn:uuid:8f1c2b3a-0000-4000-8000-000000000000"],
    });
    expect(res.statusCode).toBeLessThan(300);
    expect((await storedExtra(cal.id, uid))?.attendees).toEqual(["alice@example.com"]);
    await app.close();
  });
});
