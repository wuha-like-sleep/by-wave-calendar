// CalDAV 冲突模型，从 HTTP 真实打进去。模型两层：
//
// ① 客户端明示的前置条件（If-Match / If-None-Match）严格执行——这一层
//    以前有两个洞：If-None-Match 根本不查（带 `If-None-Match: *` 来更新
//    会被当普通更新静默覆盖），带 If-Match 来新建会照样插入。本文件把
//    这两个洞和其余前置条件语义逐条钉住。
// ② 没带前置条件的写（盲写）照常接受——这不是疏漏，是和 alarm_window
//    同一条线的刻意口径：客户端手里可能存着旧年代的副本，对它回 412，
//    Apple 会弹「无法更新日历」并丢掉本地修改。盲写的数据安全由合并层
//    兜底（EXDATE 并集、VALARM 无证据不删……），不在这一层解决。
//
// 多 VEVENT：一资源一 UID，主事件 + RECURRENCE-ID 覆盖实例整体存取；
// 多 UID 载荷 403 valid-calendar-object-resource。
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

function icsBody(uid: string, opts: { summary?: string; start?: string; end?: string } = {}): string {
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//conflicts//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "DTSTAMP:20260601T000000Z",
    `SUMMARY:${opts.summary ?? "季度复盘"}`,
    `DTSTART:${opts.start ?? "20260610T090000Z"}`,
    `DTEND:${opts.end ?? "20260610T110000Z"}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join(CRLF) + CRLF;
}

type App = Awaited<ReturnType<typeof buildApp>>;
type User = { id: string; email: string };

function put(app: App, user: User, calId: string, uid: string, body: string, headers: Record<string, string> = {}) {
  return app.inject({
    method: "PUT",
    url: `/caldav/${user.id}/${calId}/${uid}.ics`,
    headers: { authorization: authHeader(user.email), "content-type": "text/calendar; charset=utf-8", ...headers },
    payload: body,
  });
}

function get(app: App, user: User, calId: string, uid: string) {
  return app.inject({
    method: "GET",
    url: `/caldav/${user.id}/${calId}/${uid}.ics`,
    headers: { authorization: authHeader(user.email) },
  });
}

function del(app: App, user: User, calId: string, uid: string, headers: Record<string, string> = {}) {
  return app.inject({
    method: "DELETE",
    url: `/caldav/${user.id}/${calId}/${uid}.ics`,
    headers: { authorization: authHeader(user.email), ...headers },
  });
}

async function storedRow(calId: string, uid: string) {
  const [row] = await db.select().from(schema.events)
    .where(and(eq(schema.events.calendarId, calId), eq(schema.events.uid, uid))).limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------

describe("If-Match（更新一侧）", () => {
  it("过期的 If-Match → 412，原数据一字未动，412 还带回当前 etag", async () => {
    const app = await buildApp();
    const user = await makeAuthedUser("stale-put@example.com");
    const cal = await makeCalendar(user.id);
    const uid = "conflict-1";
    expect((await put(app, user, cal.id, uid, icsBody(uid))).statusCode).toBe(201);
    const before = await get(app, user, cal.id, uid);
    const etag = String(before.headers.etag);

    const res = await put(app, user, cal.id, uid,
      icsBody(uid, { summary: "被人抢先改掉的版本", start: "20260611T090000Z", end: "20260611T110000Z" }),
      { "if-match": '"0000000000000000000000000000dead"' });
    expect(res.statusCode).toBe(412);
    // 412 带当前 etag：客户端不用再 GET 一次就能恢复。
    expect(String(res.headers.etag)).toBe(etag);

    const after = await get(app, user, cal.id, uid);
    expect(after.body).toContain("SUMMARY:季度复盘");
    expect(String(after.headers.etag)).toBe(etag);
    await app.close();
  });

  it("正确的 If-Match → 成功且 etag 轮换，新 etag 还能接着写", async () => {
    const app = await buildApp();
    const user = await makeAuthedUser("fresh-put@example.com");
    const cal = await makeCalendar(user.id);
    const uid = "conflict-2";
    expect((await put(app, user, cal.id, uid, icsBody(uid))).statusCode).toBe(201);
    const etag1 = String((await get(app, user, cal.id, uid)).headers.etag);

    const res = await put(app, user, cal.id, uid, icsBody(uid, { summary: "第二版" }), { "if-match": etag1 });
    expect(res.statusCode).toBe(204);
    const etag2 = String(res.headers.etag);
    expect(etag2).not.toBe(etag1);
    expect(String((await get(app, user, cal.id, uid)).headers.etag)).toBe(etag2);

    const res2 = await put(app, user, cal.id, uid, icsBody(uid, { summary: "第三版" }), { "if-match": etag2 });
    expect(res2.statusCode).toBe(204);
    expect((await get(app, user, cal.id, uid)).body).toContain("SUMMARY:第三版");
    await app.close();
  });

  it("If-Match: * 更新已存在资源 → 成功；弱 etag（W/ 前缀）也算命中", async () => {
    const app = await buildApp();
    const user = await makeAuthedUser("star-put@example.com");
    const cal = await makeCalendar(user.id);
    const uid = "conflict-3";
    expect((await put(app, user, cal.id, uid, icsBody(uid))).statusCode).toBe(201);

    expect((await put(app, user, cal.id, uid, icsBody(uid, { summary: "星号版" }), { "if-match": "*" })).statusCode).toBe(204);
    // 反向代理开 gzip 会把 etag 改写成弱形式；值一样就不该被打成 412。
    // （etag 已被上一笔写轮换过，先取当前的。）
    const etag = String((await get(app, user, cal.id, uid)).headers.etag);
    expect((await put(app, user, cal.id, uid, icsBody(uid, { summary: "弱 etag 版" }), { "if-match": `W/${etag}` })).statusCode).toBe(204);
    await app.close();
  });

  it("不带任何前置条件的 PUT 更新已存在资源 → 照常成功（盲写是受支持的正常流程）", async () => {
    const app = await buildApp();
    const user = await makeAuthedUser("blind-put@example.com");
    const cal = await makeCalendar(user.id);
    const uid = "conflict-4";
    expect((await put(app, user, cal.id, uid, icsBody(uid))).statusCode).toBe(201);
    const res = await put(app, user, cal.id, uid, icsBody(uid, { summary: "盲写改的" }));
    expect(res.statusCode).toBe(204);
    expect((await get(app, user, cal.id, uid)).body).toContain("SUMMARY:盲写改的");
    await app.close();
  });
});

describe("If-None-Match 与「新建一侧」的前置条件", () => {
  it("If-None-Match: * 更新已存在资源 → 412 且不覆盖（以前会被当普通更新静默盖掉）", async () => {
    const app = await buildApp();
    const user = await makeAuthedUser("inm-update@example.com");
    const cal = await makeCalendar(user.id);
    const uid = "conflict-5";
    expect((await put(app, user, cal.id, uid, icsBody(uid, { summary: "原版" }))).statusCode).toBe(201);

    const res = await put(app, user, cal.id, uid, icsBody(uid, { summary: "想抢建的版本" }), { "if-none-match": "*" });
    expect(res.statusCode).toBe(412);
    expect((await get(app, user, cal.id, uid)).body).toContain("SUMMARY:原版");
    await app.close();
  });

  it("If-None-Match: * 建新资源 → 201（create-only 的标准写法）", async () => {
    const app = await buildApp();
    const user = await makeAuthedUser("inm-create@example.com");
    const cal = await makeCalendar(user.id);
    const uid = "conflict-6";
    const res = await put(app, user, cal.id, uid, icsBody(uid), { "if-none-match": "*" });
    expect(res.statusCode).toBe(201);
    expect((await get(app, user, cal.id, uid)).statusCode).toBe(200);
    await app.close();
  });

  it("带 If-Match 建新资源 → 412 且没有落库（以前会照样插入）", async () => {
    const app = await buildApp();
    const user = await makeAuthedUser("im-create@example.com");
    const cal = await makeCalendar(user.id);
    const uid = "conflict-7";
    const res = await put(app, user, cal.id, uid, icsBody(uid), { "if-match": '"some-etag-the-client-believes"' });
    expect(res.statusCode).toBe(412);
    expect((await get(app, user, cal.id, uid)).statusCode).toBe(404);
    expect(await storedRow(cal.id, uid)).toBeNull();
    await app.close();
  });

  it("If-Match: * 建新资源 → 412（* 的前提就是资源得存在）", async () => {
    const app = await buildApp();
    const user = await makeAuthedUser("im-star-create@example.com");
    const cal = await makeCalendar(user.id);
    const uid = "conflict-8";
    const res = await put(app, user, cal.id, uid, icsBody(uid), { "if-match": "*" });
    expect(res.statusCode).toBe(412);
    expect(await storedRow(cal.id, uid)).toBeNull();
    await app.close();
  });
});

describe("DELETE 的前置条件", () => {
  it("过期的 If-Match → 412 且事件还在；正确的 If-Match → 204 且真的没了", async () => {
    const app = await buildApp();
    const user = await makeAuthedUser("del-match@example.com");
    const cal = await makeCalendar(user.id);
    const uid = "conflict-9";
    expect((await put(app, user, cal.id, uid, icsBody(uid))).statusCode).toBe(201);
    const etag = String((await get(app, user, cal.id, uid)).headers.etag);

    expect((await del(app, user, cal.id, uid, { "if-match": '"0000000000000000000000000000dead"' })).statusCode).toBe(412);
    expect((await get(app, user, cal.id, uid)).statusCode).toBe(200);

    expect((await del(app, user, cal.id, uid, { "if-match": etag })).statusCode).toBe(204);
    expect((await get(app, user, cal.id, uid)).statusCode).toBe(404);
    await app.close();
  });

  it("不带 If-Match 的 DELETE → 照常 204（保持既有语义）", async () => {
    const app = await buildApp();
    const user = await makeAuthedUser("del-blind@example.com");
    const cal = await makeCalendar(user.id);
    const uid = "conflict-10";
    expect((await put(app, user, cal.id, uid, icsBody(uid))).statusCode).toBe(201);
    expect((await del(app, user, cal.id, uid)).statusCode).toBe(204);
    expect((await get(app, user, cal.id, uid)).statusCode).toBe(404);
    await app.close();
  });

  it("软删之后：无条件 PUT 照常复活；带删除前旧 etag 的 If-Match PUT → 412", async () => {
    const app = await buildApp();
    const user = await makeAuthedUser("resurrect@example.com");
    const cal = await makeCalendar(user.id);
    const uid = "conflict-11";
    expect((await put(app, user, cal.id, uid, icsBody(uid))).statusCode).toBe(201);
    expect((await del(app, user, cal.id, uid)).statusCode).toBe(204);
    expect((await get(app, user, cal.id, uid)).statusCode).toBe(404);

    // iOS 的复活流程：本地还有这条，编辑后无条件 PUT 回来 → 复活。
    const resurrect = await put(app, user, cal.id, uid, icsBody(uid, { summary: "复活的" }));
    expect(resurrect.statusCode).toBeLessThan(300);
    const back = await get(app, user, cal.id, uid);
    expect(back.statusCode).toBe(200);
    expect(back.body).toContain("SUMMARY:复活的");
    const etagBeforeSecondDelete = String(back.headers.etag);

    // 再删一次，然后拿删除前的 etag 带 If-Match 写：资源对客户端已经
    // 不存在，If-Match 不成立 → 412，不许把删掉的东西又静默写回来。
    expect((await del(app, user, cal.id, uid)).statusCode).toBe(204);
    const res = await put(app, user, cal.id, uid, icsBody(uid), { "if-match": etagBeforeSecondDelete });
    expect(res.statusCode).toBe(412);
    expect((await get(app, user, cal.id, uid)).statusCode).toBe(404);
    await app.close();
  });
});

describe("多 VEVENT 载荷", () => {
  const seriesBody = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//conflicts//EN",
    "BEGIN:VEVENT",
    "UID:series-1",
    "DTSTAMP:20260601T000000Z",
    "SUMMARY:每周例会",
    "DTSTART:20260610T090000Z",
    "DTEND:20260610T100000Z",
    "RRULE:FREQ=WEEKLY",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:series-1",
    "DTSTAMP:20260601T000000Z",
    "RECURRENCE-ID:20260617T090000Z",
    "SUMMARY:这周改到十点",
    "DTSTART:20260617T100000Z",
    "DTEND:20260617T110000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join(CRLF) + CRLF;

  it("同 UID 主事件 + 覆盖实例 → 201，GET 整体往返（两个 VEVENT 都在）", async () => {
    const app = await buildApp();
    const user = await makeAuthedUser("multi-ok@example.com");
    const cal = await makeCalendar(user.id);

    const res = await put(app, user, cal.id, "series-1", seriesBody);
    expect(res.statusCode).toBe(201);

    // 结构化列由主事件驱动。
    const row = await storedRow(cal.id, "series-1");
    expect(row?.summary).toBe("每周例会");
    expect(row?.rrule).toBe("FREQ=WEEKLY");

    const got = await get(app, user, cal.id, "series-1");
    expect(got.statusCode).toBe(200);
    expect((got.body.match(/BEGIN:VEVENT/g) ?? []).length).toBe(2);
    expect(got.body).toContain("RECURRENCE-ID:20260617T090000Z");
    expect(got.body).toContain("SUMMARY:这周改到十点");
    expect(got.body).toContain("SUMMARY:每周例会");
    await app.close();
  });

  it("多 UID 载荷 → 403，两个 UID 都没落库", async () => {
    const app = await buildApp();
    const user = await makeAuthedUser("multi-uid@example.com");
    const cal = await makeCalendar(user.id);
    const body = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//conflicts//EN",
      "BEGIN:VEVENT",
      "UID:multi-a",
      "DTSTAMP:20260601T000000Z",
      "SUMMARY:甲",
      "DTSTART:20260610T090000Z",
      "DTEND:20260610T100000Z",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:multi-b",
      "DTSTAMP:20260601T000000Z",
      "SUMMARY:乙",
      "DTSTART:20260612T090000Z",
      "DTEND:20260612T100000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join(CRLF) + CRLF;

    const res = await put(app, user, cal.id, "multi-a", body);
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("valid-calendar-object-resource");
    expect((await get(app, user, cal.id, "multi-a")).statusCode).toBe(404);
    expect((await get(app, user, cal.id, "multi-b")).statusCode).toBe(404);
    await app.close();
  });

  it("同 UID 但两个主事件（没有 RECURRENCE-ID 区分）→ 403", async () => {
    const app = await buildApp();
    const user = await makeAuthedUser("multi-master@example.com");
    const cal = await makeCalendar(user.id);
    const body = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//conflicts//EN",
      "BEGIN:VEVENT",
      "UID:two-masters",
      "DTSTAMP:20260601T000000Z",
      "SUMMARY:主一",
      "DTSTART:20260610T090000Z",
      "DTEND:20260610T100000Z",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:two-masters",
      "DTSTAMP:20260601T000000Z",
      "SUMMARY:主二",
      "DTSTART:20260612T090000Z",
      "DTEND:20260612T100000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join(CRLF) + CRLF;

    const res = await put(app, user, cal.id, "two-masters", body);
    expect(res.statusCode).toBe(403);
    expect(await storedRow(cal.id, "two-masters")).toBeNull();
    await app.close();
  });
});
