import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// 这个套件跑在 `npm test` 的纯逻辑档里（没有 Postgres、没有 SMTP），所以把
// 扫描器的四个外部依赖全挡掉：db/client 一 import 就会去建 postgres 连接池，
// env 会校验 DATABASE_URL 之类的必填项。
vi.mock("../src/db/client.js", () => ({ db: {}, schema: {} }));
vi.mock("../src/env.js", () => ({ env: { PUBLIC_BASE_URL: "https://cal.example.com", NODE_ENV: "test" } }));
vi.mock("../src/lib/site_settings.js", () => ({ getSettings: async () => ({ defaultLocale: "en" }) }));
vi.mock("../src/lib/push.js", () => ({ pushToUser: vi.fn(async () => ({ sent: 0, failed: 0 })) }));
vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn(async () => ({ ok: true as boolean, reason: undefined as string | undefined })) }));

import { dispatchDueReminders, sentTriggerFor, type ReminderStore, type SentKey } from "../src/lib/reminders.js";
import { composeCalendarAudience } from "../src/lib/calendar_access.js";
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

type CalRow = { id: string; ownerId: string; timezone: string | null; name: string };

type MemberRow = { calendarId: string; userId: string };

function keyOf(k: SentKey): string {
  return `${k.eventId}\u0000${k.trigger}\u0000${k.instanceStart.toISOString()}`;
}

type Harness = {
  store: ReminderStore;
  sentRows: SentKey[];
  calls: { loadEvents: number; loadSent: number; loadUsers: number; loadCalendars: number; loadMembers: number };
  /** markSent 被调用时先返回 false（模拟别的副本刚抢先落了行） */
  conflictOn: Set<string>;
};

type HarnessOpts = {
  ownerDisabled?: boolean;
  /** calendar_members 里的行 */
  members?: MemberRow[];
  /** 这些 user id 的账号是停用状态 */
  disabledUserIds?: string[];
};

function harness(events: EventRow[], calendars: CalRow[], opts: HarnessOpts = {}): Harness {
  const sentRows: SentKey[] = [];
  const calls = { loadEvents: 0, loadSent: 0, loadUsers: 0, loadCalendars: 0, loadMembers: 0 };
  const disabled = new Set(opts.disabledUserIds ?? []);
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
    async loadMembers(calendarIds) {
      calls.loadMembers++;
      return (opts.members ?? []).filter((m) => calendarIds.includes(m.calendarId));
    },
    async loadUsers(ids) {
      calls.loadUsers++;
      return ids.map((id) => ({
        id, email: `${id}@example.com`, displayName: "U",
        // 所有者的停用开关沿用老参数；成员按 disabledUserIds 单独开。
        disabledAt: (disabled.has(id) || (opts.ownerDisabled && id === "user-1"))
          ? new Date("2026-01-01T00:00:00Z") : null,
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

const CAL: CalRow = { id: "cal-1", ownerId: "user-1", timezone: "Asia/Shanghai", name: "团队日程" };

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
    expect(h.calls.loadUsers).toBe(1);
    expect(h.calls.loadCalendars).toBe(1);
    expect(h.calls.loadMembers).toBe(1);
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
    const h = harness([ev()], [CAL], { ownerDisabled: true });
    at("2026-07-14T01:45:00Z");
    const r = await dispatchDueReminders(logger(), h.store);
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(r.sent).toBe(0);
    expect(h.sentRows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 共享日历的成员
//
// 在这之前扫描器只反查 calendars.owner_id 一个人，被邀请进来的成员一条提醒都收不到。
// 下面这一组钉的是「收件人 = 所有者 + 全部成员，各一次，不多不少」，以及加了这一维
// 之后幂等还站得住（失败只影响失败的那个人，第二轮谁都不重发）。
// ---------------------------------------------------------------------------

/** 本轮真正发出去的收信地址，按发送顺序。 */
function recipients(): string[] {
  return mockSendMail.mock.calls.map((c) => c[0].to);
}

const MEMBERS: MemberRow[] = [
  { calendarId: "cal-1", userId: "user-2" },
  { calendarId: "cal-1", userId: "user-3" },
];

describe("共享日历：成员也收提醒", () => {
  it("共享给 2 个成员的日历上的事件到点 → 所有者 + 2 个成员各一次，不多不少", async () => {
    const h = harness([ev()], [CAL], { members: MEMBERS });
    at("2026-07-14T01:45:00Z");

    const r = await dispatchDueReminders(logger(), h.store);

    // toEqual 卡的是「谁、几封、什么顺序」三件事：少一个人、多一封、
    // 同一个人收两封，都会在这一条上红。
    expect(recipients()).toEqual([
      "user-1@example.com", "user-2@example.com", "user-3@example.com",
    ]);
    expect(r.sent).toBe(3);
    expect(r.deliveries).toBe(3);
    expect(h.sentRows).toHaveLength(3);
  });

  it("幂等行：所有者存 trigger 原文，成员存 trigger#userId", async () => {
    // 这条守的是「不改 schema」那个决定的前提。所有者的键一个字都不能变 ——
    // 线上已经落着的行、以及 0049 那种按 rs.trigger 等值回填的迁移，都指着它。
    const h = harness([ev()], [CAL], { members: MEMBERS });
    at("2026-07-14T01:45:00Z");
    await dispatchDueReminders(logger(), h.store);

    expect(h.sentRows.map((k) => k.trigger)).toEqual([
      "-PT15M", "-PT15M#user-2", "-PT15M#user-3",
    ]);
    expect(sentTriggerFor("-PT15M", { userId: "user-2", isOwner: false })).toBe("-PT15M#user-2");
    expect(sentTriggerFor("-PT15M", { userId: "user-1", isOwner: true })).toBe("-PT15M");
  });

  it("被停用的成员不收，同一个日历上其他人照收", async () => {
    // absence（停用的那个收不到）和 presence（没停用的那两个收得到）在同一条里配齐：
    // 只断言「user-2 没收到」的话，把发信整个改坏它也是绿的。
    const h = harness([ev()], [CAL], { members: MEMBERS, disabledUserIds: ["user-2"] });
    at("2026-07-14T01:45:00Z");

    const r = await dispatchDueReminders(logger(), h.store);

    expect(recipients()).toEqual(["user-1@example.com", "user-3@example.com"]);
    // 不发信的人也不许落幂等行：他哪天被解封，这条提醒还在窗口里就该补得上。
    expect(h.sentRows.map((k) => k.trigger)).toEqual(["-PT15M", "-PT15M#user-3"]);
    expect(r.sent).toBe(2);
    expect(r.failed).toBe(0);      // 停用是「不该发」，不是「发失败」
  });

  it("发给其中一个人失败：只有他那行不落，其余照落，下一轮只补他一个", async () => {
    mockSendMail.mockImplementation(async (args) =>
      args.to === "user-2@example.com" ? { ok: false, reason: "smtp_550" } : { ok: true });
    const h = harness([ev()], [CAL], { members: MEMBERS });
    at("2026-07-14T01:45:00Z");

    const r = await dispatchDueReminders(logger(), h.store);
    expect(r.sent).toBe(2);
    expect(r.failed).toBe(1);
    expect(h.sentRows.map((k) => k.trigger)).toEqual(["-PT15M", "-PT15M#user-3"]);

    // 下一分钟：成功的那两个被幂等行挡住，失败的那个重试。
    mockSendMail.mockReset();
    mockSendMail.mockResolvedValue({ ok: true });
    at("2026-07-14T01:45:30Z");
    const r2 = await dispatchDueReminders(logger(), h.store);

    expect(recipients()).toEqual(["user-2@example.com"]);
    expect(r2.sent).toBe(1);
    expect(h.sentRows.map((k) => k.trigger).sort()).toEqual(
      ["-PT15M", "-PT15M#user-2", "-PT15M#user-3"],
    );
  });

  it("第二轮扫描一个人都不重发", async () => {
    const h = harness([ev()], [CAL], { members: MEMBERS });
    at("2026-07-14T01:45:00Z");
    expect((await dispatchDueReminders(logger(), h.store)).sent).toBe(3);

    mockSendMail.mockClear();
    at("2026-07-14T01:45:30Z");   // 同一条提醒仍在 ±60s 窗口里
    const r2 = await dispatchDueReminders(logger(), h.store);

    expect(mockSendMail).not.toHaveBeenCalled();
    expect(r2.sent).toBe(0);
    expect(h.sentRows).toHaveLength(3);
  });

  it("所有者同时也躺在成员表里，只收一封", async () => {
    const h = harness([ev()], [CAL], {
      members: [{ calendarId: "cal-1", userId: "user-1" }, ...MEMBERS],
    });
    at("2026-07-14T01:45:00Z");
    const r = await dispatchDueReminders(logger(), h.store);

    expect(recipients()).toEqual([
      "user-1@example.com", "user-2@example.com", "user-3@example.com",
    ]);
    expect(r.sent).toBe(3);
  });

  it("两个日历同时到点，各自的成员只收自己那个日历的事件", async () => {
    // 这一条必须**两个日历上都有到点的事件**才立得住。只放一个日历的话，
    // 另一个日历的成员行在 SQL 那层（假 store 里照抄的 WHERE calendar_id IN (...)）
    // 就已经被滤掉了，源码里按日历分组那一步改成「全表拉平」照样是绿的 ——
    // 验红时真踩到过这个假绿。
    const CAL2: CalRow = { id: "cal-2", ownerId: "user-8", timezone: "Asia/Shanghai", name: "招聘" };
    const h = harness(
      [ev(), ev({ id: "ev-2", summary: "面试", calendarId: "cal-2" })],
      [CAL, CAL2],
      {
        members: [
          { calendarId: "cal-1", userId: "user-2" },
          { calendarId: "cal-2", userId: "user-9" },
        ],
      },
    );
    at("2026-07-14T01:45:00Z");
    await dispatchDueReminders(logger(), h.store);

    // 「哪封信、发给谁」成对地钉住：串台时 user-9 会出现在周会那几封里。
    const pairs = mockSendMail.mock.calls.map((c) => [
      c[0].subject.includes("面试") ? "ev-2" : "ev-1",
      c[0].to,
    ]);
    expect(pairs).toEqual([
      ["ev-1", "user-1@example.com"],
      ["ev-1", "user-2@example.com"],
      ["ev-2", "user-8@example.com"],
      ["ev-2", "user-9@example.com"],
    ]);
  });

  it("web push 也发给每个成员，各一次", async () => {
    const h = harness([ev()], [CAL], { members: MEMBERS });
    at("2026-07-14T01:45:00Z");
    await dispatchDueReminders(logger(), h.store);

    expect(mockPush.mock.calls.map((c) => c[0])).toEqual(["user-1", "user-2", "user-3"]);
  });

  it("成员的信写明来自哪个共享日历，所有者的信不写", async () => {
    // 成员收到一封「⏰ 周会」而完全不知道是谁的日历，比不收还费解。
    const h = harness([ev()], [CAL], { members: [{ calendarId: "cal-1", userId: "user-2" }] });
    at("2026-07-14T01:45:00Z");
    await dispatchDueReminders(logger(), h.store);

    const ownerMail = mockSendMail.mock.calls[0]![0];
    const memberMail = mockSendMail.mock.calls[1]![0];
    expect(ownerMail.text).not.toContain("团队日程");
    expect(memberMail.text).toContain("Shared calendar: 团队日程");
    expect(memberMail.html).toContain("团队日程");
  });

  it("查库次数和成员数无关：50 个成员也只多问一次成员表", async () => {
    const many: MemberRow[] = Array.from({ length: 50 }, (_, i) => ({
      calendarId: "cal-1", userId: `m-${i}`,
    }));
    const h = harness([ev()], [CAL], { members: many });
    at("2026-07-14T01:45:00Z");
    const r = await dispatchDueReminders(logger(), h.store);

    expect(r.sent).toBe(51);
    expect(h.calls.loadMembers).toBe(1);
    expect(h.calls.loadUsers).toBe(1);
    expect(h.calls.loadSent).toBe(1);
    expect(h.calls.loadCalendars).toBe(1);
  });
});

describe("composeCalendarAudience — 可见性和提醒共用的收件人定义", () => {
  it("所有者排第一，成员按原顺序跟在后面", () => {
    expect(composeCalendarAudience("o", ["a", "b"])).toEqual([
      { userId: "o", isOwner: true },
      { userId: "a", isOwner: false },
      { userId: "b", isOwner: false },
    ]);
  });

  it("所有者也在成员表里时只出现一次，且仍然算所有者", () => {
    expect(composeCalendarAudience("o", ["a", "o"])).toEqual([
      { userId: "o", isOwner: true },
      { userId: "a", isOwner: false },
    ]);
  });

  it("成员表里重复的行只算一个人", () => {
    expect(composeCalendarAudience("o", ["a", "a"])).toHaveLength(2);
  });

  it("没有成员时就只有所有者", () => {
    expect(composeCalendarAudience("o", [])).toEqual([{ userId: "o", isOwner: true }]);
  });
});
