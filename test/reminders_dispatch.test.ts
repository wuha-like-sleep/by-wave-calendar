import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// 这个套件跑在 `npm test` 的纯逻辑档里（没有 Postgres、没有 SMTP），所以把
// 扫描器的四个外部依赖全挡掉：db/client 一 import 就会去建 postgres 连接池，
// env 会校验 DATABASE_URL 之类的必填项。
vi.mock("../src/db/client.js", () => ({ db: {}, schema: {} }));
vi.mock("../src/env.js", () => ({ env: { PUBLIC_BASE_URL: "https://cal.example.com", NODE_ENV: "test" } }));
vi.mock("../src/lib/site_settings.js", () => ({ getSettings: async () => ({ defaultLocale: "en" }) }));
vi.mock("../src/lib/push.js", () => ({ pushToUser: vi.fn(async () => ({ sent: 0, failed: 0 })) }));
vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn(async () => ({ ok: true as boolean, reason: undefined as string | undefined })) }));

import { dispatchDueReminders, type ReminderStore, type SentKey } from "../src/lib/reminders.js";
import { sendMail } from "../src/lib/mailer.js";
import { pushToUser } from "../src/lib/push.js";

const mockSendMail = vi.mocked(sendMail);
const mockPush = vi.mocked(pushToUser);

// ---------------------------------------------------------------------------
// 假 store
//
// loadEvents 故意**照抄 dbStore 里那条 SQL 的过滤口径**（非重复事件按 master 的
// startsAt 卡在 [from, to] 内，重复事件一律放行）。不照抄的话取数窗口那几条断言
// 就是假绿 —— 窗口是 SQL 那一层收的，假 store 里无脑全返回等于把它绕过去了。
// ---------------------------------------------------------------------------

type EventRow = {
  id: string; summary: string; startsAt: Date; endsAt: Date;
  location: string | null; extra: unknown; calendarId: string;
  rrule: string | null; exdates: unknown; allDay: boolean;
};

type CalRow = { id: string; ownerId: string; timezone: string | null };

function keyOf(k: SentKey): string {
  return `${k.eventId}\u0000${k.trigger}\u0000${k.instanceStart.toISOString()}`;
}

type Harness = {
  store: ReminderStore;
  sentRows: SentKey[];
  calls: { loadEvents: number; loadSent: number; loadOwners: number; loadCalendars: number };
  /** markSent 被调用时先返回 false（模拟别的副本刚抢先落了行） */
  conflictOn: Set<string>;
};

function harness(events: EventRow[], calendars: CalRow[], ownerDisabled = false): Harness {
  const sentRows: SentKey[] = [];
  const calls = { loadEvents: 0, loadSent: 0, loadOwners: 0, loadCalendars: 0 };
  const conflictOn = new Set<string>();
  const store: ReminderStore = {
    async loadEvents(from, to) {
      calls.loadEvents++;
      return events.filter((e) => (e.rrule ? true : e.startsAt >= from && e.startsAt <= to));
    },
    async loadCalendars(ids) {
      calls.loadCalendars++;
      return calendars.filter((c) => ids.includes(c.id));
    },
    async loadOwners(ids) {
      calls.loadOwners++;
      return ids.map((id) => ({
        id, email: `${id}@example.com`, displayName: "Owner",
        disabledAt: ownerDisabled ? new Date("2026-01-01T00:00:00Z") : null,
        locale: "en",
      }));
    },
    async loadSent(keys) {
      calls.loadSent++;
      const want = new Set(keys.map(keyOf));
      return new Set(sentRows.map(keyOf).filter((k) => want.has(k)));
    },
    async markSent(k) {
      const key = keyOf(k);
      if (conflictOn.has(key)) return false;
      if (sentRows.some((r) => keyOf(r) === key)) return false;
      sentRows.push(k);
      return true;
    },
  };
  return { store, sentRows, calls, conflictOn };
}

const CAL: CalRow = { id: "cal-1", ownerId: "user-1", timezone: "Asia/Shanghai" };

function ev(over: Partial<EventRow> = {}): EventRow {
  return {
    id: "ev-1", summary: "周会", startsAt: new Date("2026-07-14T02:00:00Z"),
    endsAt: new Date("2026-07-14T03:00:00Z"), location: null,
    extra: { alarms: [{ trigger: "-PT15M" }] }, calendarId: "cal-1",
    rrule: null, exdates: null, allDay: false, ...over,
  };
}

function at(iso: string) { vi.setSystemTime(new Date(iso)); }

function logger() {
  const warns: unknown[] = [];
  return { warn: (m: unknown) => { warns.push(m); }, warns };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  mockSendMail.mockReset();
  mockSendMail.mockResolvedValue({ ok: true });
  mockPush.mockReset();
  mockPush.mockResolvedValue({ sent: 0, failed: 0 });
});
afterEach(() => { vi.useRealTimers(); });

// ---------------------------------------------------------------------------

describe("C5 — 发信失败不许记成已发", () => {
  it("sendMail 返回 { ok:false } 时不落幂等行、sent 为 0", async () => {
    mockSendMail.mockResolvedValue({ ok: false, reason: "mailer_disabled" });
    const h = harness([ev()], [CAL]);
    const log = logger();
    at("2026-07-14T01:45:00Z"); // -PT15M 相对 02:00Z

    const r = await dispatchDueReminders(log, h.store);

    expect(mockSendMail).toHaveBeenCalledTimes(1);   // 确实试着发了
    expect(h.sentRows).toEqual([]);                   // reminders_sent 里没有这一行
    expect(r.sent).toBe(0);
    expect(r.failed).toBe(1);
    expect(log.warns).toContainEqual(expect.objectContaining({
      msg: "[reminders] send failed", eventId: "ev-1", trigger: "-PT15M", reason: "mailer_disabled",
    }));
  });

  it("这一分钟失败了，下一分钟还会再试一次（没被幂等行永久挡住）", async () => {
    mockSendMail.mockResolvedValue({ ok: false, reason: "ECONNREFUSED" });
    const h = harness([ev()], [CAL]);
    at("2026-07-14T01:45:00Z");
    await dispatchDueReminders(logger(), h.store);
    expect(h.sentRows).toEqual([]);

    mockSendMail.mockResolvedValue({ ok: true });
    at("2026-07-14T01:45:30Z");
    const r2 = await dispatchDueReminders(logger(), h.store);
    expect(r2.sent).toBe(1);
    expect(h.sentRows).toHaveLength(1);
  });

  it("sendMail 抛异常也不落行", async () => {
    mockSendMail.mockRejectedValue(new Error("boom"));
    const h = harness([ev()], [CAL]);
    at("2026-07-14T01:45:00Z");
    const r = await dispatchDueReminders(logger(), h.store);
    expect(h.sentRows).toEqual([]);
    expect(r.sent).toBe(0);
    expect(r.failed).toBe(1);
  });

  it("web push 失败不影响判定：push 挂了、邮件成功，仍然算已发", async () => {
    // push 那一发是 fire-and-forget 的：用户没订阅、VAPID 没配都是常态，
    // 拿它当失败会把本来发出去了的邮件一起判成没发。
    mockPush.mockRejectedValue(new Error("vapid missing"));
    const h = harness([ev()], [CAL]);
    at("2026-07-14T01:45:00Z");
    const r = await dispatchDueReminders(logger(), h.store);
    expect(r.sent).toBe(1);
    expect(r.failed).toBe(0);
    expect(h.sentRows).toHaveLength(1);
  });
});

describe("C4 — 全天事件的时区链", () => {
  const allDay = (extra: unknown) => ev({
    id: "ev-allday", summary: "年假", allDay: true,
    startsAt: new Date("2026-07-14T00:00:00Z"),
    endsAt: new Date("2026-07-15T00:00:00Z"),   // 全天 DTEND 是开区间
    extra,
  });

  it("PT9H 落在事件时区的当天 09:00（Asia/Shanghai → 01:00Z）", async () => {
    const rows = [allDay({ alarms: [{ trigger: "PT9H" }], timezone: "Asia/Shanghai" })];

    // 不是 01:00Z 的时刻一律不发 —— 00:00Z 是「按 startsAt 算」的错误答案，
    // 09:00Z 是「锚到 UTC 午夜」的错误答案。
    for (const t of ["2026-07-14T00:00:00Z", "2026-07-14T09:00:00Z"]) {
      const h = harness(rows, [CAL]);
      at(t);
      expect((await dispatchDueReminders(logger(), h.store)).sent).toBe(0);
    }

    const h = harness(rows, [CAL]);
    at("2026-07-14T01:00:00Z");
    const r = await dispatchDueReminders(logger(), h.store);
    expect(r.sent).toBe(1);
    expect(h.sentRows[0]!.instanceStart.toISOString()).toBe("2026-07-14T00:00:00.000Z");
  });

  it("extra.timezone 缺失时回落到日历的 timezone（America/New_York → 13:00Z）", async () => {
    const rows = [allDay({ alarms: [{ trigger: "PT9H" }] })];   // extra 里没有 timezone
    const cal: CalRow = { ...CAL, timezone: "America/New_York" };

    const early = harness(rows, [cal]);
    at("2026-07-14T01:00:00Z");   // 上海的答案，不该在纽约发
    expect((await dispatchDueReminders(logger(), early.store)).sent).toBe(0);

    const h = harness(rows, [cal]);
    at("2026-07-14T13:00:00Z");
    expect((await dispatchDueReminders(logger(), h.store)).sent).toBe(1);
  });

  it("extra.timezone 优先于日历 timezone", async () => {
    const rows = [allDay({ alarms: [{ trigger: "PT9H" }], timezone: "America/New_York" })];
    const h = harness(rows, [CAL]);   // 日历是 Asia/Shanghai
    at("2026-07-14T13:00:00Z");
    expect((await dispatchDueReminders(logger(), h.store)).sent).toBe(1);
  });

  it("两处时区都拿不到 → 不发、不落行、记一条 no_timezone 的 skip", async () => {
    const rows = [allDay({ alarms: [{ trigger: "PT9H" }] })];
    const log = logger();
    // 一整天里每小时扫一遍：不管服务器本地时区是什么，都不许有任何一刻发出去。
    // 回落到本地时区的实现会在某一个整点上把它发出来。
    let totalSent = 0;
    for (let hour = 0; hour < 24; hour++) {
      const h = harness(rows, [{ ...CAL, timezone: null }]);
      at(`2026-07-14T${String(hour).padStart(2, "0")}:00:00Z`);
      const r = await dispatchDueReminders(log, h.store);
      totalSent += r.sent;
      expect(h.sentRows).toEqual([]);
    }
    expect(totalSent).toBe(0);
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(log.warns).toContainEqual(expect.objectContaining({
      msg: "[reminders] skip", eventId: "ev-allday", trigger: "PT9H", reason: "no_timezone",
    }));
  });

  it("时区名非法（不是 IANA 名）也跳过，reason 区分得开", async () => {
    const rows = [allDay({ alarms: [{ trigger: "PT9H" }], timezone: "Mars/Olympus" })];
    const log = logger();
    const h = harness(rows, [CAL]);
    at("2026-07-14T01:00:00Z");
    const r = await dispatchDueReminders(log, h.store);
    expect(r.sent).toBe(0);
    expect(h.sentRows).toEqual([]);
    expect(log.warns).toContainEqual(expect.objectContaining({ reason: "invalid_timezone" }));
  });
});

describe("幂等", () => {
  it("同一 occurrence 第二次扫描不重发", async () => {
    const h = harness([ev()], [CAL]);
    at("2026-07-14T01:45:00Z");
    expect((await dispatchDueReminders(logger(), h.store)).sent).toBe(1);

    at("2026-07-14T01:45:30Z");   // 同一条提醒仍在 ±60s 窗口里
    const r2 = await dispatchDueReminders(logger(), h.store);
    expect(r2.sent).toBe(0);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(h.sentRows).toHaveLength(1);
  });

  it("markSent 撞唯一索引（别的副本抢先）不计进 sent，也不算失败", async () => {
    const h = harness([ev()], [CAL]);
    h.conflictOn.add(keyOf({ eventId: "ev-1", trigger: "-PT15M", instanceStart: new Date("2026-07-14T02:00:00Z") }));
    at("2026-07-14T01:45:00Z");
    const r = await dispatchDueReminders(logger(), h.store);
    expect(r.sent).toBe(0);
    expect(r.failed).toBe(0);
  });

  it("重复事件的每个 occurrence 各自独立提醒", async () => {
    const rows = [ev({ rrule: "FREQ=DAILY" })];
    const h = harness(rows, [CAL]);
    at("2026-07-14T01:45:00Z");
    expect((await dispatchDueReminders(logger(), h.store)).sent).toBe(1);
    at("2026-07-15T01:45:00Z");
    expect((await dispatchDueReminders(logger(), h.store)).sent).toBe(1);
    expect(h.sentRows.map((r) => r.instanceStart.toISOString())).toEqual([
      "2026-07-14T02:00:00.000Z", "2026-07-15T02:00:00.000Z",
    ]);
  });
});

describe("批量查重", () => {
  it("一个事件上多条提醒同时到点，只问一次已发集合", async () => {
    // 三条 trigger 都指向 02:00Z 前后同一分钟，一轮里全是候选。
    const rows = [
      ev({ id: "a", extra: { alarms: [{ trigger: "-PT15M" }, { trigger: "-PT0M" }] } }),
      ev({ id: "b", startsAt: new Date("2026-07-14T01:45:00Z"), endsAt: new Date("2026-07-14T02:45:00Z"), extra: { alarms: [{ trigger: "-PT0M" }] } }),
    ];
    const h = harness(rows, [CAL]);
    at("2026-07-14T01:45:00Z");
    const r = await dispatchDueReminders(logger(), h.store);
    expect(r.sent).toBe(2);                  // a 的 -PT15M + b 的 -PT0M
    expect(h.calls.loadSent).toBe(1);
    expect(h.calls.loadOwners).toBe(1);
    expect(h.calls.loadCalendars).toBe(1);
  });

  it("同一事件被取回两次（join 复制行）也只发一封", async () => {
    // 幂等行是发完才落的，所以同一轮里的重复候选挡不住 —— 唯一索引只能保证
    // 表里不多一行，邮件已经出去两封了。这一层去重就是为了这个。
    const h = harness([ev(), ev()], [CAL]);
    at("2026-07-14T01:45:00Z");
    const r = await dispatchDueReminders(logger(), h.store);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(r.sent).toBe(1);
  });

  it("解析不了的 trigger 只丢它自己，同一事件上合法的那条照发", async () => {
    const rows = [ev({ extra: { alarms: [{ trigger: "banana" }, { trigger: "-PT15M" }] } })];
    const log = logger();
    const h = harness(rows, [CAL]);
    at("2026-07-14T01:45:00Z");
    const r = await dispatchDueReminders(log, h.store);
    expect(r.sent).toBe(1);
    expect(h.sentRows[0]!.trigger).toBe("-PT15M");
    expect(log.warns).toContainEqual(expect.objectContaining({
      reason: "unparsable_trigger", trigger: "banana",
    }));
  });
});

describe("取数窗口", () => {
  it("-P1W（提前一周）的事件仍在取数窗口内", async () => {
    const rows = [ev({
      startsAt: new Date("2026-07-21T02:00:00Z"), endsAt: new Date("2026-07-21T03:00:00Z"),
      extra: { alarms: [{ trigger: "-P1W" }] },
    })];
    const h = harness(rows, [CAL]);
    at("2026-07-14T02:00:00Z");
    expect((await dispatchDueReminders(logger(), h.store)).sent).toBe(1);
  });

  it("正数触发：全天 PT9H 在 UTC-12 比 startsAt 晚 21 小时，仍要取得回来", async () => {
    // 这一条打的是窗口往前那一头。旧代码只取 startsAt >= now-60s，
    // 到 21:00Z 时这个事件的 startsAt（当天 00:00Z）早被 SQL 滤掉了。
    const rows = [ev({
      id: "ev-far-west", allDay: true,
      startsAt: new Date("2026-07-14T00:00:00Z"), endsAt: new Date("2026-07-15T00:00:00Z"),
      extra: { alarms: [{ trigger: "PT9H" }], timezone: "Etc/GMT+12" },
    })];
    const h = harness(rows, [CAL]);
    at("2026-07-14T21:00:00Z");
    const r = await dispatchDueReminders(logger(), h.store);
    expect(r.sent).toBe(1);
    expect(h.sentRows[0]!.instanceStart.toISOString()).toBe("2026-07-14T00:00:00.000Z");
  });

  it("定时事件的正数触发（事件之后提醒）不会被当成提前提醒", async () => {
    const rows = [ev({ extra: { alarms: [{ trigger: "PT30M" }] } })];   // 02:00Z 之后 30 分钟

    const wrong = harness(rows, [CAL]);
    at("2026-07-14T01:30:00Z");   // 符号被吃掉时会在这里发
    expect((await dispatchDueReminders(logger(), wrong.store)).sent).toBe(0);

    const h = harness(rows, [CAL]);
    at("2026-07-14T02:30:00Z");
    expect((await dispatchDueReminders(logger(), h.store)).sent).toBe(1);
  });
});

describe("邮件正文", () => {
  it("全天事件写日期，日期按 UTC 渲染，不写「还有多久」", async () => {
    // 全天的 startsAt 是 UTC 午夜。拿事件时区（这里是 UTC-4）去渲染会写成 07/13，
    // 而用户在日历上看到的是 14 号。
    const rows = [ev({
      allDay: true, startsAt: new Date("2026-07-14T00:00:00Z"), endsAt: new Date("2026-07-15T00:00:00Z"),
      extra: { alarms: [{ trigger: "PT9H" }], timezone: "America/New_York" },
    })];
    const h = harness(rows, [CAL]);
    at("2026-07-14T13:00:00Z");
    await dispatchDueReminders(logger(), h.store);

    const mail = mockSendMail.mock.calls[0]![0];
    expect(mail.subject).toContain("07/14/2026");
    expect(mail.subject).not.toContain("07/13/2026");
    expect(mail.subject).not.toMatch(/hours? ago|in \d+ hours?/);
  });

  it("定时事件照旧写「还有多久」", async () => {
    const h = harness([ev()], [CAL]);
    at("2026-07-14T01:45:00Z");
    await dispatchDueReminders(logger(), h.store);
    expect(mockSendMail.mock.calls[0]![0].subject).toContain("in 15 minutes");
  });
});

describe("收件人", () => {
  it("被封禁的账号不发信、不落行", async () => {
    const h = harness([ev()], [CAL], true);
    at("2026-07-14T01:45:00Z");
    const r = await dispatchDueReminders(logger(), h.store);
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(r.sent).toBe(0);
    expect(h.sentRows).toEqual([]);
  });
});
