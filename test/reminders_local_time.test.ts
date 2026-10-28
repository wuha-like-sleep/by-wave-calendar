import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// 重复事件的提醒要跟着日历上画出来的那一次响：「每周一 9:30、提前 15 分钟」就是
// 墨尔本每周一 9:15 响 —— 不是 UTC 周一（= 墨尔本周二）、也不是夏令时之后的 10:15。
//
// 和 reminders_dispatch.test.ts 一样跑在纯逻辑档：外部依赖全挡掉，用假 store。
// 从真库（SQL 那一层，含「原文 DTSTART 是 UTC」那个布尔）打进去的版本在
// test/integration/recurrence_local_time.int.test.ts。

vi.mock("../src/db/client.js", () => ({ db: {}, schema: {} }));
vi.mock("../src/env.js", () => ({ env: { PUBLIC_BASE_URL: "https://cal.example.com", NODE_ENV: "test" } }));
vi.mock("../src/lib/site_settings.js", () => ({ getSettings: async () => ({ defaultLocale: "en" }) }));
vi.mock("../src/lib/push.js", () => ({ pushToUser: vi.fn(async () => ({ sent: 0, failed: 0 })) }));
vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn(async () => ({ ok: true as boolean, reason: undefined as string | undefined })) }));

import { dispatchDueReminders, type ReminderStore, type SentKey } from "../src/lib/reminders.js";
import { sendMail } from "../src/lib/mailer.js";

const mockSendMail = vi.mocked(sendMail);

type Row = Awaited<ReturnType<ReminderStore["loadEvents"]>>[number];

function store(events: Row[], calTz: string): { store: ReminderStore; sent: SentKey[] } {
  const sent: SentKey[] = [];
  return {
    sent,
    store: {
      async loadEvents() { return events; },
      async loadCalendars(ids) { return ids.map((id) => ({ id, ownerId: "user-1", timezone: calTz, name: "Cal" })); },
      async loadMembers() { return []; },
      async loadUsers(ids) { return ids.map((id) => ({ id, email: `${id}@example.com`, displayName: "U", disabledAt: null, locale: "en" })); },
      async loadSent() { return new Set(); },
      async markSent(k) { sent.push(k); return true; },
    },
  };
}

function weekly(rrule: string, startsAt: string, over: Partial<Row> = {}): Row {
  const s = new Date(startsAt);
  return {
    id: "ev-1", summary: "周会", startsAt: s, endsAt: new Date(s.getTime() + 3600_000),
    location: null, extra: { alarms: [{ trigger: "-PT15M" }] }, calendarId: "cal-1",
    rrule, exdates: null, allDay: false, ...over,
  };
}

const log = { warn: () => undefined };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  mockSendMail.mockReset();
  mockSendMail.mockResolvedValue({ ok: true });
});
afterEach(() => { vi.useRealTimers(); });

describe("提醒按日历上那一次的时刻响", () => {
  // 2026-09-28 周一 09:30 AEST = 2026-09-27T23:30Z；日历时区墨尔本，事件没写自己的时区。
  const mondays = weekly("FREQ=WEEKLY;BYDAY=MO", "2026-09-27T23:30:00Z");

  it("墨尔本 10-12 周一 9:15 响，这一次的开始时刻是墨尔本周一 9:30", async () => {
    vi.setSystemTime(new Date("2026-10-11T22:15:00Z"));   // 周一 09:15 AEDT
    const h = store([mondays], "Australia/Melbourne");
    const r = await dispatchDueReminders(log, h.store);
    expect(r.sent, "该响的没响").toBe(1);
    expect(h.sent[0]!.instanceStart.toISOString()).toBe("2026-10-11T22:30:00.000Z");
  });

  it("墨尔本周二 9:15（以前按 UTC 周一算出来的那个时刻）不响", async () => {
    // 旧算法：UTC 周一 23:30 = 墨尔本周二 10:30，提醒在 23:15Z
    vi.setSystemTime(new Date("2026-10-12T23:15:00Z"));
    const h = store([mondays], "Australia/Melbourne");
    const r = await dispatchDueReminders(log, h.store);
    expect(r.sent, "按 UTC 的周一响了一次").toBe(0);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("夏令时之后：每周 9:30 的提醒在 9:15 响，不是 10:15", async () => {
    const plain = weekly("FREQ=WEEKLY", "2026-09-20T23:30:00Z");   // 每周一 09:30，起于夏令时之前
    const at915 = store([plain], "Australia/Melbourne");
    vi.setSystemTime(new Date("2026-10-18T22:15:00Z"));            // 10-19 周一 09:15 AEDT
    expect((await dispatchDueReminders(log, at915.store)).sent).toBe(1);

    const at1015 = store([plain], "Australia/Melbourne");
    vi.setSystemTime(new Date("2026-10-18T23:15:00Z"));            // 10:15 AEDT
    expect((await dispatchDueReminders(log, at1015.store)).sent).toBe(0);
  });

  it("事件自己的时区优先于日历时区；手机原文 DTSTART 是 UTC 的按 UTC", async () => {
    // 事件写了北京时区，日历是纽约：北京周一 07:00 = 2026-10-04T23:00Z = 纽约周日 19:00，
    // 提醒是北京周一 06:45。拿日历时区展开的话「每周一」会变成纽约的周一（= 北京周二）。
    const bj = weekly("FREQ=WEEKLY;BYDAY=MO", "2026-10-04T23:00:00Z", {
      extra: { alarms: [{ trigger: "-PT15M" }], timezone: "Asia/Shanghai" },
    });
    vi.setSystemTime(new Date("2026-10-11T22:45:00Z"));   // 10-12 周一 06:45 北京
    expect((await dispatchDueReminders(log, store([bj], "America/New_York").store)).sent).toBe(1);

    // 同一个时刻、同样的规则，但这条是手机用 UTC 写上来的：按 UTC 周一展开，
    // 10-12 06:45 北京（UTC 周日 22:45）不是它的提醒时刻。
    const rawUtc = weekly("FREQ=WEEKLY;BYDAY=MO", "2026-10-04T23:00:00Z", { rawStartIsUtc: true });
    expect((await dispatchDueReminders(log, store([rawUtc], "Asia/Shanghai").store)).sent).toBe(0);
    vi.setSystemTime(new Date("2026-10-12T22:45:00Z"));   // UTC 周一 22:45 = 它按 UTC 算的提醒时刻
    expect((await dispatchDueReminders(log, store([rawUtc], "Asia/Shanghai").store)).sent).toBe(1);
  });
});
