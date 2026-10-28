// 重复事件按事件自己的时区展开 —— **全部从真实入口打进去**。
//
// 直调 expandEvent 的单元测试（test/rrule_expand_timezone.test.ts）看不见的东西：
//   · 路由有没有把时区真的传进去（日历时区来自另一张表，漏 join 就是 UTC）；
//   · 「删掉这一次」记下的时刻和下一次 GET 展开出来的是不是同一个；
//   · CalDAV / 订阅链接导出的 DTSTART、EXDATE 和服务端展开的是不是同一批日子；
//   · 提醒扫描那条 SQL（含「原文 DTSTART 是 UTC」那个布尔）；
//   · 预约忙闲有没有把每一周的例会都算成忙。
// 所以这里一律：真 Fastify + 真路由 + 真会话 / Basic Auth + 真 PGlite。
import { vi, beforeAll, beforeEach, afterEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
// 提醒扫描真的会发信：挡在发信这一层，断言看「发给谁、哪一次」。
vi.mock("../../src/lib/mailer.js", () => ({ sendMail: vi.fn(async () => ({ ok: true })) }));
vi.mock("../../src/lib/push.js", () => ({ pushToUser: vi.fn(async () => ({ sent: 0, failed: 0 })) }));

import Fastify, { type FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { ensureSchema, resetDb, db, schema, buildRoutedApp, loginAs } from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const { eventRoutes } = await import("../../src/routes/events.js");
const { caldavRoutes } = await import("../../src/web/caldav.js");
const { icsRoutes } = await import("../../src/routes/ics.js");
const { hashPassword } = await import("../../src/lib/password.js");
const { invalidateCalDavAuthCache } = await import("../../src/lib/caldav_auth.js");
const { reloadSettings } = await import("../../src/lib/site_settings.js");
const { dispatchDueReminders } = await import("../../src/lib/reminders.js");
const { availableSlots } = await import("../../src/lib/booking.js");
const { sendMail } = await import("../../src/lib/mailer.js");

const PASSWORD = "recurrence-local-time-pw-123456";
const MEL = "Australia/Melbourne";

beforeAll(async () => { await ensureSchema(); });

let api: FastifyInstance;
let cookie: string;
let user: typeof schema.users.$inferSelect;

beforeEach(async () => {
  await resetDb();
  invalidateCalDavAuthCache();
  reloadSettings();
  vi.mocked(sendMail).mockClear();
  api = await buildRoutedApp(eventRoutes, { prefix: "/api/v1" });
  const [u] = await db.insert(schema.users)
    .values({ email: "mel@example.com", emailVerified: true, passwordHash: await hashPassword(PASSWORD), passwordSet: true })
    .returning();
  user = u!;
  cookie = await loginAs(api, user.id);
});
afterEach(async () => { await api.close(); vi.useRealTimers(); });

async function calendarIn(tz: string, name = "Cal") {
  const [c] = await db.insert(schema.calendars).values({ ownerId: user.id, name, color: "#000000", timezone: tz }).returning();
  return c!;
}

function localOf(iso: string, tz: string): string {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g("year")}-${g("month")}-${g("day")} ${g("weekday")} ${g("hour")}:${g("minute")}`;
}

type Occ = { id: string; startsAt: string; endsAt: string; isOccurrence: boolean };

async function createEvent(payload: Record<string, unknown>): Promise<{ id: string; uid: string }> {
  const res = await api.inject({ method: "POST", url: "/api/v1/events", headers: { cookie }, payload });
  expect(res.statusCode, res.body).toBeLessThan(300);
  return res.json() as { id: string; uid: string };
}

async function listEvents(from: string, to: string): Promise<Occ[]> {
  const res = await api.inject({
    method: "GET",
    url: `/api/v1/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    headers: { cookie },
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { events: Occ[] }).events;
}

describe("/api/v1/events 返回的每一次落在对的日子", () => {
  it("墨尔本日历、事件没写自己的时区：周一 9:30「每周一」12 次全是墨尔本的周一 9:30（跨夏令时）", async () => {
    const cal = await calendarIn(MEL);
    const created = await createEvent({
      calendarId: cal.id, summary: "周会",
      startsAt: "2026-09-27T23:30:00.000Z", endsAt: "2026-09-28T00:30:00.000Z",   // 周一 09:30–10:30 AEST
      rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=12",
    });
    const occ = (await listEvents("2026-09-01T00:00:00Z", "2027-01-31T00:00:00Z")).filter((o) => o.id === created.id);
    expect(occ, "COUNT=12 应该恰好 12 次").toHaveLength(12);
    for (const o of occ) {
      expect(localOf(o.startsAt, MEL), "画到了别的日子 / 别的钟点").toMatch(/ Mon 09:30$/);
      expect(localOf(o.endsAt, MEL)).toMatch(/ Mon 10:30$/);
    }
  });

  it("北京周一 07:00、纽约周一 20:00（事件自己写了时区，日历是 UTC）：都在当地的周一", async () => {
    const cal = await calendarIn("UTC");
    const bj = await createEvent({
      calendarId: cal.id, summary: "北京早会", rrule: "FREQ=WEEKLY;BYDAY=MO",
      startsAt: "2026-10-04T23:00:00.000Z", endsAt: "2026-10-05T00:00:00.000Z",
      extra: { timezone: "Asia/Shanghai" },
    });
    const ny = await createEvent({
      calendarId: cal.id, summary: "纽约晚会", rrule: "FREQ=WEEKLY;BYDAY=MO",
      startsAt: "2026-10-06T00:00:00.000Z", endsAt: "2026-10-06T01:00:00.000Z",
      extra: { timezone: "America/New_York" },
    });
    const all = await listEvents("2026-10-01T00:00:00Z", "2026-11-20T00:00:00Z");
    const bjOcc = all.filter((o) => o.id === bj.id);
    const nyOcc = all.filter((o) => o.id === ny.id);
    expect(bjOcc.length).toBeGreaterThan(4);
    expect(nyOcc.length).toBeGreaterThan(4);
    for (const o of bjOcc) expect(localOf(o.startsAt, "Asia/Shanghai")).toMatch(/ Mon 07:00$/);
    for (const o of nyOcc) expect(localOf(o.startsAt, "America/New_York")).toMatch(/ Mon 20:00$/);
  });

  it("全天重复事件不受日历时区影响：纽约日历里的「每周一（全天）」还是周一那个日期", async () => {
    const cal = await calendarIn("America/New_York");
    const created = await createEvent({
      calendarId: cal.id, summary: "全天", allDay: true, rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=3",
      startsAt: "2026-10-05T00:00:00.000Z", endsAt: "2026-10-05T23:59:59.999Z",
    });
    // 按纽约时区展开的话，UTC 午夜 = 纽约前一天 20:00，「每周一」会落成纽约的周一 20:00 = UTC 周二。
    const occ = (await listEvents("2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z")).filter((o) => o.id === created.id);
    expect(occ.map((o) => o.startsAt)).toEqual([
      "2026-10-05T00:00:00.000Z", "2026-10-12T00:00:00.000Z", "2026-10-19T00:00:00.000Z",
    ]);
  });

  it("「删掉这一次」：用列表里那一次的时刻删，下一次 GET 正好少了那一天", async () => {
    const cal = await calendarIn(MEL);
    const created = await createEvent({
      calendarId: cal.id, summary: "周会", rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=4",
      startsAt: "2026-09-27T23:30:00.000Z", endsAt: "2026-09-28T00:30:00.000Z",
    });
    const before = (await listEvents("2026-09-01T00:00:00Z", "2026-12-01T00:00:00Z")).filter((o) => o.id === created.id);
    const third = before[2]!;
    expect(localOf(third.startsAt, MEL)).toBe("2026-10-12 Mon 09:30");
    const del = await api.inject({
      method: "DELETE",
      url: `/api/v1/events/${created.id}?scope=instance&recurrenceId=${encodeURIComponent(third.startsAt)}`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(204);
    const after = (await listEvents("2026-09-01T00:00:00Z", "2026-12-01T00:00:00Z")).filter((o) => o.id === created.id);
    expect(after.map((o) => localOf(o.startsAt, MEL))).toEqual([
      "2026-09-28 Mon 09:30", "2026-10-05 Mon 09:30", "2026-10-19 Mon 09:30",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 导出：手机系统日历展开的结果要和服务端一致
// ---------------------------------------------------------------------------

async function buildDavApp() {
  const app = Fastify({ logger: false });
  app.addHttpMethod("PROPFIND", { hasBody: true });
  app.addHttpMethod("REPORT", { hasBody: true });
  app.addContentTypeParser(/^(application\/xml|text\/xml|text\/calendar)\b/i, { parseAs: "string" },
    (_req, body, done) => done(null, body as string));
  await app.register(caldavRoutes);
  await app.register(icsRoutes);
  await app.ready();
  return app;
}

/** 墨尔本周一 9:30「每周一」，第 3 次（10-12）删掉了；没写 extra.timezone；带一个参与者。 */
async function seedMelbourneSeries() {
  const cal = await calendarIn(MEL, "墨尔本");
  const created = await createEvent({
    calendarId: cal.id, summary: "周会", rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=12",
    startsAt: "2026-09-27T23:30:00.000Z", endsAt: "2026-09-28T00:30:00.000Z",
  });
  const occ = (await listEvents("2026-09-01T00:00:00Z", "2026-12-01T00:00:00Z")).filter((o) => o.id === created.id);
  const del = await api.inject({
    method: "DELETE",
    url: `/api/v1/events/${created.id}?scope=instance&recurrenceId=${encodeURIComponent(occ[2]!.startsAt)}`,
    headers: { cookie },
  });
  expect(del.statusCode).toBe(204);
  await db.update(schema.events).set({ extra: { attendees: ["guest@example.com"] } }).where(eq(schema.events.id, created.id));
  return { cal, created };
}

/** 只取 VEVENT 里这几行，断言不被别的行干扰。 */
function veventLines(ics: string): string[] {
  const unfolded = ics.replace(/\r\n[ \t]/g, "");
  return unfolded.split("\r\n").filter((l) => /^(DTSTART|DTEND|EXDATE|RRULE|ATTENDEE|ORGANIZER|X-WR-TIMEZONE)[;:]/.test(l));
}

describe("CalDAV 导出：没有 extra.timezone 的重复事件带日历时区", () => {
  it("DTSTART / DTEND 写成墨尔本墙上时间，EXDATE 是被删那一次（10-12 09:30，夏令时之后）", async () => {
    const { cal, created } = await seedMelbourneSeries();
    const dav = await buildDavApp();
    const res = await dav.inject({
      method: "GET",
      url: `/caldav/${user.id}/${cal.id}/${created.uid}.ics`,
      headers: { authorization: "Basic " + Buffer.from(`${user.email}:${PASSWORD}`).toString("base64") },
    });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    const lines = veventLines(res.body);
    expect(lines).toContain("DTSTART;TZID=Australia/Melbourne:20260928T093000");
    expect(lines).toContain("DTEND;TZID=Australia/Melbourne:20260928T103000");
    expect(lines).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=12");
    expect(lines.filter((l) => l.startsWith("EXDATE")), "EXDATE 和服务端删掉的那一次对不上").toEqual([
      "EXDATE;TZID=Australia/Melbourne:20261012T093000",
    ]);
    await dav.close();
  });
});

describe("订阅链接（/ics/:token）导出", () => {
  it("和 CalDAV 同一套 DTSTART / EXDATE；不带参与者邮箱（公开链接）", async () => {
    const { cal } = await seedMelbourneSeries();
    await db.insert(schema.shareTokens).values({ token: "share-token-0123456789", calendarId: cal.id });
    const dav = await buildDavApp();
    const res = await dav.inject({ method: "GET", url: "/ics/share-token-0123456789.ics" });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    const lines = veventLines(res.body);
    expect(lines).toContain("DTSTART;TZID=Australia/Melbourne:20260928T093000");
    expect(lines).toContain("DTEND;TZID=Australia/Melbourne:20260928T103000");
    expect(lines).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=12");
    expect(lines.filter((l) => l.startsWith("EXDATE")), "订阅的人那里，删掉的那一次还在").toEqual([
      "EXDATE;TZID=Australia/Melbourne:20261012T093000",
    ]);
    expect(lines.filter((l) => /^(ATTENDEE|ORGANIZER)/.test(l)), "公开链接把参与者邮箱带出去了").toEqual([]);
    expect(res.body).not.toContain("guest@example.com");
    await dav.close();
  });

  it("全天事件写成日期（纽约日历里也是那一天），不重复的定时事件写成确定的 UTC 时刻（以前是不带时区的浮动时间）", async () => {
    const cal = await calendarIn("America/New_York", "纽约");
    await createEvent({
      calendarId: cal.id, summary: "全天", allDay: true, rrule: "FREQ=WEEKLY",
      startsAt: "2026-10-05T00:00:00.000Z", endsAt: "2026-10-05T23:59:59.999Z",
    });
    await createEvent({
      calendarId: cal.id, summary: "单次", startsAt: "2026-10-06T00:00:00.000Z", endsAt: "2026-10-06T01:00:00.000Z",
    });
    await db.insert(schema.shareTokens).values({ token: "share-token-ny-0123456789", calendarId: cal.id });
    const dav = await buildDavApp();
    const res = await dav.inject({ method: "GET", url: "/ics/share-token-ny-0123456789" });
    const lines = veventLines(res.body);
    expect(lines).toContain("DTSTART;VALUE=DATE:20261005");
    expect(lines).toContain("DTEND;VALUE=DATE:20261006");
    expect(lines).toContain("DTSTART:20261006T000000Z");
    await dav.close();
  });
});

// ---------------------------------------------------------------------------
// 提醒：真库里的 SQL（含「原文 DTSTART 是 UTC」那个布尔）
// ---------------------------------------------------------------------------

describe("提醒扫描（真库）按对的时刻触发", () => {
  async function seedWithAlarm(cal: { id: string }, over: Partial<typeof schema.events.$inferInsert> = {}) {
    const [e] = await db.insert(schema.events).values({
      calendarId: cal.id, uid: `u-${Math.random()}`, summary: "周会",
      startsAt: new Date("2026-09-27T23:30:00Z"), endsAt: new Date("2026-09-28T00:30:00Z"),
      rrule: "FREQ=WEEKLY;BYDAY=MO", extra: { alarms: [{ trigger: "-PT15M" }] },
      ...over,
    }).returning();
    return e!;
  }
  const log = { warn: () => undefined };

  it("墨尔本周一 9:15 响、周二 9:15（旧算法的时刻）不响", async () => {
    const cal = await calendarIn(MEL);
    const e = await seedWithAlarm(cal);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-12T23:15:00Z"));   // 周二 10:15 AEDT（旧算法：UTC 周一 23:30 前 15 分钟）
    expect((await dispatchDueReminders(log)).sent, "按 UTC 的周一响了").toBe(0);
    vi.setSystemTime(new Date("2026-10-11T22:15:00Z"));   // 周一 09:15 AEDT
    const r = await dispatchDueReminders(log);
    expect(r.sent).toBe(1);
    const [row] = await db.select().from(schema.remindersSent).where(eq(schema.remindersSent.eventId, e.id));
    expect(row!.instanceStart.toISOString()).toBe("2026-10-11T22:30:00.000Z");
  });

  it("手机用 UTC 写上来的原文（DTSTART:…Z）：按 UTC 展开，和手机自己算的一样", async () => {
    const cal = await calendarIn(MEL);
    await seedWithAlarm(cal, {
      rawIcs: "BEGIN:VEVENT\r\nUID:raw\r\nSUMMARY:周会\r\nDTSTART:20260927T233000Z\r\nDTEND:20260928T003000Z\r\nRRULE:FREQ=WEEKLY;BYDAY=MO\r\nEND:VEVENT",
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-11T22:15:00Z"));   // 墨尔本周一 09:15 —— 不是这条的时刻
    expect((await dispatchDueReminders(log)).sent).toBe(0);
    vi.setSystemTime(new Date("2026-10-12T23:15:00Z"));   // UTC 周一 23:15 —— 是
    expect((await dispatchDueReminders(log)).sent).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 预约忙闲
// ---------------------------------------------------------------------------

describe("预约：每一周的例会都算忙，按事件时区的那一天", () => {
  it("纽约周一 21:00 的周会（= 上海周二 10:00）挡住两周的周二 10:00，不挡周一 10:00；删掉的那周放出来", async () => {
    const cal = await calendarIn("America/New_York");
    const [link] = await db.insert(schema.bookingLinks).values({
      userId: user.id, calendarId: cal.id, slug: "chat", title: "聊一聊",
      durationMinutes: 30, minNoticeHours: 0, maxDaysAhead: 14,
      weeklyAvailability: { "1": [["09:00", "12:00"]], "2": [["09:00", "12:00"]] },
    }).returning();
    // 2026-11-02 周一 21:00 EST = 2026-11-03T02:00Z = 上海周二 10:00
    await db.insert(schema.events).values({
      calendarId: cal.id, uid: "weekly-ny", summary: "周会",
      startsAt: new Date("2026-11-03T02:00:00Z"), endsAt: new Date("2026-11-03T03:00:00Z"),
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      exdates: ["2026-11-17T02:00:00.000Z"],   // 第三周删掉了
    });
    const slots = (await availableSlots(link!, new Date("2026-11-01T00:00:00Z"), 21)).map((s) => s.startsAt.toISOString());
    expect(slots, "这一周（主事件那一次）没算忙").not.toContain("2026-11-03T02:00:00.000Z");
    expect(slots, "第二周的例会没算忙 —— 以前只挡第一周").not.toContain("2026-11-10T02:00:00.000Z");
    expect(slots, "半小时之后那一格也被会占着").not.toContain("2026-11-10T02:30:00.000Z");
    expect(slots, "按 UTC 的周一算成了忙（= 上海周一 10:00）").toContain("2026-11-09T02:00:00.000Z");
    expect(slots, "会开完了的 11:00 应该能约").toContain("2026-11-10T03:00:00.000Z");
    expect(slots, "删掉的那一周应该放出来").toContain("2026-11-17T02:00:00.000Z");
  });
});
