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

  it("老版桌面端只改标题（不带 recurrenceId，发的是那一次的时刻）：同样不动", async () => {
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

describe("重发不能平移两遍（网页发送队列超时会重发）", () => {
  it("同一个请求发两次：09:30 → 10:30，不是 11:30；删过的那次也只挪一遍", async () => {
    const ev = await seed({ exdates: ["2026-11-01T22:30:00.000Z"] });
    const body = {
      startsAt: "2026-11-15T23:30:00.000Z", endsAt: "2026-11-16T00:30:00.000Z",
      scope: "series", recurrenceId: LATER, seriesBase: FIRST,
    };
    expect((await patch(ev.id, { ...body, summary: "第一次" })).statusCode).toBe(200);
    expect((await patch(ev.id, { ...body, summary: "重发" })).statusCode).toBe(200);
    const row = await rowOf(ev.id);
    expect(row.startsAt.toISOString()).toBe("2026-10-25T23:30:00.000Z");
    expect(row.exdates).toEqual(["2026-11-01T23:30:00.000Z"]);
    expect(row.summary, "别的字段照写").toBe("重发");
  });
});

describe("全天重复事件（存的是 UTC 午夜）", () => {
  const ALL_DAY = { startsAt: new Date("2026-10-26T00:00:00.000Z"), endsAt: new Date("2026-10-26T23:59:59.999Z"), allDay: true, rrule: "FREQ=WEEKLY", extra: {} };

  it("网页只改标题，存几遍都不漂（recurrenceId 是那一天的 UTC 午夜）", async () => {
    const ev = await seed(ALL_DAY);
    for (let i = 0; i < 3; i++) {
      await patch(ev.id, { summary: `第 ${i} 次`, allDay: true, startsAt: "2026-11-16T00:00:00.000Z", endsAt: "2026-11-16T23:59:59.999Z", scope: "series", recurrenceId: "2026-11-16T00:00:00.000Z" });
    }
    expect((await rowOf(ev.id)).startsAt.toISOString()).toBe("2026-10-26T00:00:00.000Z");
  });

  for (const [zone, localMidnight] of [["上海", "2026-11-15T16:00:00.000Z"], ["墨尔本", "2026-11-15T13:00:00.000Z"], ["纽约", "2026-11-16T05:00:00.000Z"]] as const) {
    it(`老页面发来本地午夜（${zone}）：差值里混的时区偏移不算数，存几遍都不漂`, async () => {
      const ev = await seed(ALL_DAY);
      for (let i = 0; i < 3; i++) {
        await patch(ev.id, { summary: "改", allDay: true, startsAt: "2026-11-16T00:00:00.000Z", endsAt: "2026-11-16T23:59:59.999Z", scope: "series", recurrenceId: localMidnight });
      }
      const row = await rowOf(ev.id);
      expect(row.startsAt.toISOString()).toBe("2026-10-26T00:00:00.000Z");
      expect(row.endsAt.toISOString()).toBe("2026-10-26T23:59:59.999Z");
    });
  }

  it("往后挪两天：整天平移（跨夏令时差值是 47 小时也算 2 天）", async () => {
    const ev = await seed(ALL_DAY);
    await patch(ev.id, { allDay: true, startsAt: "2026-11-18T00:00:00.000Z", endsAt: "2026-11-18T23:59:59.999Z", scope: "series", recurrenceId: "2026-11-16T01:00:00.000Z" });
    expect((await rowOf(ev.id)).startsAt.toISOString()).toBe("2026-10-28T00:00:00.000Z");
  });
});

describe("拉伸（只发结束时刻）", () => {
  it("每一次的时长跟着改，不会变成几周长", async () => {
    const ev = await seed();
    await patch(ev.id, { endsAt: "2026-11-16T00:30:00.000Z", scope: "series", recurrenceId: LATER });
    const row = await rowOf(ev.id);
    expect(row.startsAt.toISOString()).toBe(FIRST);
    expect(row.endsAt.getTime() - row.startsAt.getTime()).toBe(2 * 3600_000);
  });
});

describe("跨夏令时、跨天、带结束日期", () => {
  it("把 09-28 09:00 拖到 10-05 09:00（中间进了夏令时）：时间不变，整体往后一周", async () => {
    const start = "2026-09-27T23:00:00.000Z";   // 墨尔本 09-28 周一 09:00 AEST
    const ev = await seed({ startsAt: new Date(start), endsAt: new Date("2026-09-28T00:00:00.000Z"), rrule: "FREQ=WEEKLY" });
    await patch(ev.id, { startsAt: "2026-10-04T22:00:00.000Z", endsAt: "2026-10-04T23:00:00.000Z", scope: "series", recurrenceId: start });
    expect((await rowOf(ev.id)).startsAt.toISOString(), "主事件应是 10-05 09:00 AEDT").toBe("2026-10-04T22:00:00.000Z");
  });

  it("把周一拖到周二：规则跟着变成每周二，第一次和删过的那次都跟着挪", async () => {
    const ev = await seed({ exdates: ["2026-11-01T22:30:00.000Z"] });
    await patch(ev.id, { startsAt: "2026-11-16T22:30:00.000Z", endsAt: "2026-11-16T23:30:00.000Z", scope: "series", recurrenceId: LATER });
    const row = await rowOf(ev.id);
    expect(row.rrule).toBe("FREQ=WEEKLY;BYDAY=TU");
    expect(row.startsAt.toISOString()).toBe("2026-10-26T22:30:00.000Z");
    expect(row.exdates).toEqual(["2026-11-02T22:30:00.000Z"]);
    const wd = (await startsOf(ev.id)).map((s) => new Intl.DateTimeFormat("en-US", { timeZone: MEL, weekday: "short" }).format(new Date(s)));
    expect(new Set(wd)).toEqual(new Set(["Tue"]));
    expect(wd).toHaveLength(5);   // 10-27、11-10、11-17、11-24、12-01 中去掉删过的 11-03，窗口到 12-06
  });

  it("「每月第一个周一」跨天拖：日子挪不了，删过的那次也不动", async () => {
    const ex = "2026-11-01T22:30:00.000Z";
    const ev = await seed({ rrule: "FREQ=MONTHLY;BYDAY=1MO", startsAt: new Date("2026-10-04T22:30:00.000Z"), endsAt: new Date("2026-10-04T23:30:00.000Z"), exdates: [ex] });
    await patch(ev.id, { startsAt: "2026-12-08T22:30:00.000Z", endsAt: "2026-12-08T23:30:00.000Z", scope: "series", recurrenceId: "2026-12-06T22:30:00.000Z" });
    const row = await rowOf(ev.id);
    expect(row.rrule).toBe("FREQ=MONTHLY;BYDAY=1MO");
    expect(row.exdates).toEqual([ex]);
  });

  it("带 UNTIL 的系列往后挪 1 小时：最后一次还在", async () => {
    const rrule = "FREQ=WEEKLY;BYDAY=MO;UNTIL=20261129T223000Z";
    const ev = await seed({ rrule });
    const before = await startsOf(ev.id);
    await patch(ev.id, { startsAt: "2026-11-15T23:30:00.000Z", endsAt: "2026-11-16T00:30:00.000Z", scope: "series", recurrenceId: LATER });
    const after = await startsOf(ev.id);
    expect(after).toHaveLength(before.length);
    expect((await rowOf(ev.id)).rrule).toBe("FREQ=WEEKLY;BYDAY=MO;UNTIL=20261129T233000Z");
  });

  it("桌面端把规则重建了（UNTIL 改成当天末尾、INTERVAL=1）：不算换规则，库里那条不变", async () => {
    const rrule = "FREQ=WEEKLY;BYDAY=MO;UNTIL=20261129T223000Z";
    const ev = await seed({ rrule });
    await patch(ev.id, { summary: "只改标题", startsAt: LATER, endsAt: LATER_END, rrule: "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO;UNTIL=20261129T235959Z" });
    const row = await rowOf(ev.id);
    expect(row.startsAt.toISOString()).toBe(FIRST);
    expect(row.rrule).toBe(rrule);
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
