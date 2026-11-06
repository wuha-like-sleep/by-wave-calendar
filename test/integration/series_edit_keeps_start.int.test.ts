// 「所有事件」保存：各端的编辑框显示的是点开的那一次，保存时把那一次的时刻发上来。
// 以前直接写进主事件，系列就变成从那一次才开始：从 11 月 16 日点进去只改个标题，之前几次全没了。
//
// 从 HTTP 打进去，请求体照各端实际发的形状写。
import { vi, beforeAll, beforeEach, afterEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { ensureSchema, resetDb, db, schema, buildRoutedApp, loginAs } from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const { eventRoutes } = await import("../../src/routes/events.js");
const { reloadSettings } = await import("../../src/lib/site_settings.js");
const { hashPassword } = await import("../../src/lib/password.js");

const MEL = "Australia/Melbourne";
const RULE = "FREQ=WEEKLY;BYDAY=MO";
// 墨尔本 10-26 周一 09:30 AEDT（第一次）、11-16 周一 09:30（后面某一次）
const FIRST = "2026-10-25T22:30:00.000Z";
const FIRST_END = "2026-10-25T23:30:00.000Z";
const LATER = "2026-11-15T22:30:00.000Z";
const LATER_END = "2026-11-15T23:30:00.000Z";

beforeAll(async () => { await ensureSchema(); });

let api: FastifyInstance;
let cookie: string;
let calendarId: string;

beforeEach(async () => {
  await resetDb();
  reloadSettings();
  api = await buildRoutedApp(eventRoutes, { prefix: "/api" });
  const [u] = await db.insert(schema.users)
    .values({ email: "series@example.com", emailVerified: true, passwordHash: await hashPassword("series-edit-test-pw-123456"), passwordSet: true })
    .returning();
  cookie = await loginAs(api, u!.id);
  const [c] = await db.insert(schema.calendars)
    .values({ ownerId: u!.id, name: "Cal", color: "#000000", timezone: MEL }).returning();
  calendarId = c!.id;
});
afterEach(async () => { await api.close(); });

async function seed(o: Partial<typeof schema.events.$inferInsert> = {}) {
  const [row] = await db.insert(schema.events).values({
    calendarId, uid: "series-edit-1", summary: "例会",
    startsAt: new Date(FIRST), endsAt: new Date(FIRST_END),
    rrule: RULE, extra: { timezone: MEL }, ...o,
  }).returning();
  return row!;
}
const rowOf = async (id: string) => (await db.select().from(schema.events).where(eq(schema.events.id, id)))[0]!;
const patch = (id: string, body: Record<string, unknown>) => api.inject({
  method: "PATCH", url: `/api/events/${id}`, headers: { cookie, "content-type": "application/json" }, payload: JSON.stringify(body),
});
async function startsOf(id: string): Promise<string[]> {
  const res = await api.inject({
    method: "GET", url: `/api/events?from=${encodeURIComponent("2026-10-01T00:00:00Z")}&to=${encodeURIComponent("2026-12-06T00:00:00Z")}`,
    headers: { cookie },
  });
  return (res.json() as { events: { id: string; startsAt: string }[] }).events.filter((e) => e.id === id).map((e) => e.startsAt);
}
const ALL_SIX = ["2026-10-25", "2026-11-01", "2026-11-08", "2026-11-15", "2026-11-22", "2026-11-29"];

describe("从后面某一次点进去，选「所有事件」", () => {
  it("网页只改标题（带 recurrenceId）：系列开始时间不动，前面几次都在", async () => {
    const ev = await seed();
    const res = await patch(ev.id, { summary: "新标题", startsAt: LATER, endsAt: LATER_END, rrule: RULE, scope: "series", recurrenceId: LATER });
    expect(res.statusCode).toBe(200);
    const row = await rowOf(ev.id);
    expect(row.summary).toBe("新标题");
    expect(row.startsAt.toISOString()).toBe(FIRST);
    expect(row.endsAt.toISOString()).toBe(FIRST_END);
    expect((await startsOf(ev.id)).map((s) => s.slice(0, 10))).toEqual(ALL_SIX);
  });

  it("已发布的 App 只改标题（不带 recurrenceId，发的是那一次的时刻）：同样不动", async () => {
    const ev = await seed();
    const res = await patch(ev.id, { summary: "新标题", startsAt: LATER, endsAt: LATER_END });
    expect(res.statusCode).toBe(200);
    expect((await rowOf(ev.id)).startsAt.toISOString()).toBe(FIRST);
    expect((await startsOf(ev.id)).map((s) => s.slice(0, 10))).toEqual(ALL_SIX);
  });

  it("把时间往后挪 30 分钟：每一次都挪，前面几次还在；时长照改的算", async () => {
    const ev = await seed();
    await patch(ev.id, { startsAt: "2026-11-15T23:00:00.000Z", endsAt: "2026-11-16T01:00:00.000Z", scope: "series", recurrenceId: LATER });
    const row = await rowOf(ev.id);
    expect(row.startsAt.toISOString()).toBe("2026-10-25T23:00:00.000Z");
    expect(row.endsAt.getTime() - row.startsAt.getTime()).toBe(2 * 3600_000);
    expect((await startsOf(ev.id)).map((s) => s.slice(0, 10))).toEqual(ALL_SIX);
  });

  it("挪时间时，以前删掉的那次跟着挪，不会重新冒出来", async () => {
    const ev = await seed({ exdates: ["2026-11-01T22:30:00.000Z"] });
    await patch(ev.id, { startsAt: "2026-11-15T23:00:00.000Z", endsAt: "2026-11-16T00:00:00.000Z", scope: "series", recurrenceId: LATER });
    expect((await rowOf(ev.id)).exdates).toEqual(["2026-11-01T23:00:00.000Z"]);
    const days = (await startsOf(ev.id)).map((s) => s.slice(0, 10));
    expect(days).toHaveLength(5);
    expect(days).not.toContain("2026-11-01");
  });
});

describe("这些情况照发来的存", () => {
  it("改的就是主事件（发来的时刻不是系列里的一次）：开始时间照改", async () => {
    const ev = await seed();
    await patch(ev.id, { startsAt: "2026-10-26T22:30:00.000Z", endsAt: "2026-10-26T23:30:00.000Z" });
    expect((await rowOf(ev.id)).startsAt.toISOString()).toBe("2026-10-26T22:30:00.000Z");
  });

  it("连规则一起改了：开始时间照改（整个系列重新定义）", async () => {
    const ev = await seed();
    await patch(ev.id, { startsAt: LATER, endsAt: LATER_END, rrule: "FREQ=DAILY" });
    expect((await rowOf(ev.id)).startsAt.toISOString()).toBe(LATER);
  });

  it("不重复的事件：照改，不受影响", async () => {
    const ev = await seed({ rrule: null });
    await patch(ev.id, { startsAt: LATER, endsAt: LATER_END });
    expect((await rowOf(ev.id)).startsAt.toISOString()).toBe(LATER);
  });
});

describe("日历接口的响应", () => {
  const url = `/api/events?from=${encodeURIComponent("2026-11-01T00:00:00Z")}&to=${encodeURIComponent("2026-12-01T00:00:00Z")}`;
  const get = (headers: Record<string, string> = {}) => api.inject({ method: "GET", url, headers: { cookie, ...headers } });
  const RAW = "BEGIN:VEVENT\r\nUID:x\r\nDTSTART;TZID=Australia/Melbourne:20261026T093000\r\nATTENDEE:mailto:secret@example.com\r\nEND:VEVENT";

  it("不带手机原文（列表、单条、改完返回都不带），重复事件的每一次也不重复带", async () => {
    const ev = await seed({ rawIcs: RAW });
    const list = await get();
    expect(list.body).not.toContain("secret@example.com");
    expect((list.json() as { events: Record<string, unknown>[] }).events[0]).not.toHaveProperty("rawIcs");
    const single = await api.inject({ method: "GET", url: `/api/events/${ev.id}`, headers: { cookie } });
    expect(single.json()).not.toHaveProperty("rawIcs");
    const byCal = await api.inject({ method: "GET", url: `/api/calendars/${calendarId}/events`, headers: { cookie } });
    expect(byCal.body).not.toContain("secret@example.com");
    const patched = await patch(ev.id, { summary: "改" });
    expect(patched.json()).not.toHaveProperty("rawIcs");
  });

  it("数据没变：带令牌回 304、没有正文；只有客户端带令牌才走这条路", async () => {
    await seed();
    const first = await get();
    expect(first.statusCode).toBe(200);
    const tag = first.headers.etag as string;
    expect(tag).toBeTruthy();
    expect(first.headers["cache-control"]).toBe("no-store");
    const second = await get({ "if-none-match": tag });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe("");
    expect((await get({ "if-none-match": `W/${tag}` })).statusCode, "反向代理开 gzip 会改成弱令牌").toBe(304);
    expect((await get()).statusCode, "不带令牌（App）照常拿全量").toBe(200);
  });

  it("令牌会变的每一种情况：改事件、删事件、新建、日历改名 / 改时区", async () => {
    const ev = await seed();
    const tagNow = async () => (await get()).headers.etag as string;
    let tag = await tagNow();
    const changed = async (what: string) => {
      const next = await tagNow();
      expect(next, `${what}之后令牌没变 —— 网页会一直显示旧数据`).not.toBe(tag);
      expect((await get({ "if-none-match": tag })).statusCode, what).toBe(200);
      tag = next;
    };
    await patch(ev.id, { summary: "改标题" });
    await changed("改标题");
    await api.inject({ method: "POST", url: "/api/events", headers: { cookie, "content-type": "application/json" }, payload: JSON.stringify({ calendarId, summary: "新建", startsAt: "2026-11-10T00:00:00.000Z", endsAt: "2026-11-10T01:00:00.000Z" }) });
    await changed("新建");
    await api.inject({ method: "DELETE", url: `/api/events/${ev.id}`, headers: { cookie } });
    await changed("删除");
    await db.update(schema.calendars).set({ color: "#ff0000" }).where(eq(schema.calendars.id, calendarId));
    await changed("改日历颜色");
    await db.update(schema.calendars).set({ timezone: "Asia/Shanghai" }).where(eq(schema.calendars.id, calendarId));
    await changed("改日历时区");
  });
});
