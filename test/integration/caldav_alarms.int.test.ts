// 提醒在两条第三方写入路径上的端到端行为：CalDAV PUT（从 HTTP 打进去）和 .ics 订阅刷新
// （走真正的 upsert SQL）。
//
// 为什么非得走 HTTP / 真 DB：这两个 bug 的形态都是「函数本身没错，是调用点多做/少做了
// 一件事」——PUT 里那行 `if (parsed.alarms)` 和 upsert 里 insert + onConflictDoUpdate
// 两处各写一遍 `extra: extraVal`。直调 lib 函数的测试结构上看不见这两处。
import { vi, beforeAll, beforeEach, describe, it, expect } from "vitest";

// Point the production `db`/`schema` at the in-memory PGlite instance.
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
import { importIcsText } from "../../src/lib/ics_import.js";

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
  // CalDAV 用的这几个方法 Fastify 默认不认，caldavRoutes 注册路由时会直接抛。
  // 生产里同样是在 server.ts 里先声明（server.ts:100）。
  app.addHttpMethod("PROPFIND", { hasBody: true });
  app.addHttpMethod("REPORT", { hasBody: true });
  // 生产里这条解析器在 server.ts 注册；PUT 的 body 必须原样是字符串。
  app.addContentTypeParser("text/calendar", { parseAs: "string" }, (_req, body, done) => done(null, body as string));
  await app.register(caldavRoutes);
  await app.ready();
  return app;
}

function authHeader(email: string): string {
  return "Basic " + Buffer.from(`${email}:${PASSWORD}`).toString("base64");
}

function icsBody(uid: string, valarmTriggers: string[]): string {
  const alarms = valarmTriggers.flatMap((t) => [
    "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:提醒", t, "END:VALARM",
  ]);
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//test//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "SUMMARY:季度复盘",
    "DTSTART:20260610T090000Z",
    "DTEND:20260610T110000Z",
    ...alarms,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join(CRLF) + CRLF;
}

async function put(
  app: Awaited<ReturnType<typeof buildApp>>,
  user: { id: string; email: string },
  calId: string,
  uid: string,
  triggers: string[],
  ifMatch?: string,
) {
  return app.inject({
    method: "PUT",
    url: `/caldav/${user.id}/${calId}/${uid}.ics`,
    headers: {
      authorization: authHeader(user.email),
      "content-type": "text/calendar; charset=utf-8",
      ...(ifMatch ? { "if-match": ifMatch } : {}),
    },
    payload: icsBody(uid, triggers),
  });
}

/**
 * 先 GET 一次拿当前 etag —— 真实客户端删提醒前就是这么干的（取回资源、改、带
 * If-Match 写回）。**「没有 VALARM = 用户删了提醒」只在带 If-Match 且命中当前 etag 时
 * 成立**：证明不了客户端手上是当前版本的盲写，不再当成删除
 * （见 caldav.ts applyAlarmsFromPut 的注释，以及 caldav_alarm_window.int.test.ts）。
 */
async function currentEtag(app: Awaited<ReturnType<typeof buildApp>>, user: { id: string; email: string }, calId: string, uid: string): Promise<string> {
  const res = await app.inject({
    method: "GET",
    url: `/caldav/${user.id}/${calId}/${uid}.ics`,
    headers: { authorization: authHeader(user.email) },
  });
  expect(res.statusCode).toBe(200);
  return String(res.headers.etag);
}

async function storedExtra(calId: string, uid: string): Promise<Record<string, unknown> | null> {
  const [row] = await db.select().from(schema.events)
    .where(and(eq(schema.events.calendarId, calId), eq(schema.events.uid, uid))).limit(1);
  return (row?.extra ?? null) as Record<string, unknown> | null;
}

describe("CalDAV PUT 的提醒语义", () => {
  it("第二次 PUT 不带任何 VALARM → 库里的提醒被清空", async () => {
    const app = await buildApp();
    const user = await makeAuthedUser("put@example.com");
    const cal = await makeCalendar(user.id);
    const uid = "evt-alarm@example.com";

    const first = await put(app, user, cal.id, uid, ["TRIGGER:-PT15M"]);
    expect(first.statusCode).toBeLessThan(300);
    expect((await storedExtra(cal.id, uid))?.alarms).toEqual([{ trigger: "-PT15M", action: "DISPLAY", description: "提醒" }]);

    // 用户在 iPhone 自带日历里把提醒删掉 → 客户端整份回写，只是没有 VALARM 了。
    const second = await put(app, user, cal.id, uid, [], await currentEtag(app, user, cal.id, uid));
    expect(second.statusCode).toBeLessThan(300);
    const extra = await storedExtra(cal.id, uid);
    expect(extra?.alarms).toBeUndefined();
    await app.close();
  });

  it("RELATED=END 一路存到库里，没被吃成「开始前」", async () => {
    const app = await buildApp();
    const user = await makeAuthedUser("end@example.com");
    const cal = await makeCalendar(user.id);
    const uid = "evt-end@example.com";

    await put(app, user, cal.id, uid, ["TRIGGER;RELATED=END:-PT15M"]);
    const alarms = (await storedExtra(cal.id, uid))?.alarms as Array<{ trigger: string }>;
    expect(alarms?.[0]?.trigger).toMatch(/RELATED=END/i);
    await app.close();
  });

  it("垃圾 TRIGGER 不会让整次 PUT 失败，好的那条照样落库", async () => {
    const app = await buildApp();
    const user = await makeAuthedUser("mixed@example.com");
    const cal = await makeCalendar(user.id);
    const uid = "evt-mixed@example.com";

    const res = await put(app, user, cal.id, uid, ["TRIGGER:banana", "TRIGGER:-PT1H"]);
    expect(res.statusCode).toBeLessThan(300);
    const alarms = (await storedExtra(cal.id, uid))?.alarms as Array<{ trigger: string }>;
    expect(alarms.map((a) => a.trigger)).toEqual(["-PT1H"]);
    await app.close();
  });

  it("网页建的事件 GET 出去要带 VALARM —— 否则手机没见过这条提醒，一回写就删了它", async () => {
    const app = await buildApp();
    const user = await makeAuthedUser("web@example.com");
    const cal = await makeCalendar(user.id);
    const uid = "web-made@example.com";
    // 网页/API 建的事件没有 rawIcs，GET 走的是「按列合成 VEVENT」那条路。
    await db.insert(schema.events).values({
      calendarId: cal.id, uid, summary: "网页建的",
      startsAt: new Date("2026-06-10T09:00:00Z"), endsAt: new Date("2026-06-10T11:00:00Z"),
      extra: { alarms: [{ trigger: "-PT15M" }] },
    });

    const res = await app.inject({
      method: "GET",
      url: `/caldav/${user.id}/${cal.id}/${uid}.ics`,
      headers: { authorization: authHeader(user.email) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("BEGIN:VALARM");
    expect(res.body).toContain("TRIGGER:-PT15M");
    await app.close();
  });

  it("PUT 不碰 extra 里跟提醒无关的键", async () => {
    const app = await buildApp();
    const user = await makeAuthedUser("keep@example.com");
    const cal = await makeCalendar(user.id);
    const uid = "evt-keep@example.com";

    await put(app, user, cal.id, uid, ["TRIGGER:-PT15M"]);
    // 网页那边给这个事件打了个分类。
    await db.update(schema.events)
      .set({ extra: { ...(await storedExtra(cal.id, uid)), categories: ["工作"] } })
      .where(and(eq(schema.events.calendarId, cal.id), eq(schema.events.uid, uid)));

    await put(app, user, cal.id, uid, [], await currentEtag(app, user, cal.id, uid));
    const extra = await storedExtra(cal.id, uid);
    expect(extra?.alarms).toBeUndefined();
    expect(extra?.categories).toEqual(["工作"]);
    await app.close();
  });
});

describe(".ics 订阅刷新的 extra 语义", () => {
  function feed(uid: string, opts: { summary?: string; valarm?: string | null } = {}): string {
    const alarm = opts.valarm
      ? ["BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:提醒", opts.valarm, "END:VALARM"]
      : [];
    return [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//up//stream//EN",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `SUMMARY:${opts.summary ?? "上游日程"}`,
      "DTSTART:20260701T010000Z",
      "DTEND:20260701T020000Z",
      ...alarm,
      "END:VEVENT",
      "END:VCALENDAR",
    ].join(CRLF) + CRLF;
  }

  it("二次刷新不抹掉用户在这个事件上设的其它键", async () => {
    const cal = await makeCalendar((await makeAuthedUser("sub@example.com")).id);
    const uid = "upstream-1@example.com";

    await importIcsText(cal.id, feed(uid), { sourceTag: "sub:s1" });
    // 用户在网页上给这个事件加了提醒和分类。
    await db.update(schema.events)
      .set({ extra: { source: "sub:s1", alarms: [{ trigger: "-PT30M" }], categories: ["课表"] } })
      .where(and(eq(schema.events.calendarId, cal.id), eq(schema.events.uid, uid)));

    // 上游改了标题，触发一次真实的 onConflictDoUpdate。
    await importIcsText(cal.id, feed(uid, { summary: "上游日程（改期）" }), { sourceTag: "sub:s1" });

    const extra = await storedExtra(cal.id, uid);
    expect(extra?.source).toBe("sub:s1");
    expect(extra?.alarms).toEqual([{ trigger: "-PT30M" }]);
    expect(extra?.categories).toEqual(["课表"]);
  });

  it("上游带 VALARM 就落库；上游改了提醒也能跟着变", async () => {
    const cal = await makeCalendar((await makeAuthedUser("sub2@example.com")).id);
    const uid = "upstream-2@example.com";

    await importIcsText(cal.id, feed(uid, { valarm: "TRIGGER:-PT1H" }), { sourceTag: "sub:s2" });
    expect((await storedExtra(cal.id, uid))?.alarms).toEqual([
      { trigger: "-PT1H", action: "DISPLAY", description: "提醒" },
    ]);

    const res = await importIcsText(cal.id, feed(uid, { valarm: "TRIGGER:-P1D" }), { sourceTag: "sub:s2" });
    // 只有提醒变了，别的字段一样 —— 不能被 unchanged 判定 skip 掉。
    expect(res.updated).toBe(1);
    expect((await storedExtra(cal.id, uid))?.alarms).toEqual([
      { trigger: "-P1D", action: "DISPLAY", description: "提醒" },
    ]);
  });

  it("什么都没变的一次刷新仍然 skip（etag 不能白动）", async () => {
    const cal = await makeCalendar((await makeAuthedUser("sub3@example.com")).id);
    const uid = "upstream-3@example.com";
    await importIcsText(cal.id, feed(uid, { valarm: "TRIGGER:-PT1H" }), { sourceTag: "sub:s3" });
    const res = await importIcsText(cal.id, feed(uid, { valarm: "TRIGGER:-PT1H" }), { sourceTag: "sub:s3" });
    expect(res.skipped).toBe(1);
    expect(res.updated).toBe(0);
  });
});
