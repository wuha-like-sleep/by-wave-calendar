// 每分钟的提醒扫描：只取设了提醒的事件。Node 单线程，这一跳算多久，别的请求就等多久。
import { vi, beforeAll, beforeEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

import { ensureSchema, resetDb, db, schema } from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const { dispatchDueReminders } = await import("../../src/lib/reminders.js");
const { hashPassword } = await import("../../src/lib/password.js");

beforeAll(async () => { await ensureSchema(); });
beforeEach(async () => { await resetDb(); });

const ALARM = [{ trigger: "-PT15M", action: "DISPLAY", description: "x" }];

describe("提醒扫描只取设了提醒的事件", () => {
  it("没设提醒、提醒是空列表、提醒字段不是数组的都不取；形状不对也不让整轮报错", async () => {
    const [u] = await db.insert(schema.users)
      .values({ email: "scan@example.com", emailVerified: true, passwordHash: await hashPassword("reminder-scan-test-pw-123456"), passwordSet: true })
      .returning();
    const [c] = await db.insert(schema.calendars).values({ ownerId: u!.id, name: "C", color: "#000000", timezone: "UTC" }).returning();
    const startsAt = new Date(Date.now() + 5 * 86400_000);
    const endsAt = new Date(startsAt.getTime() + 3600_000);
    const row = (uid: string, extra: unknown, rrule: string | null = null) =>
      ({ calendarId: c!.id, uid, summary: uid, startsAt, endsAt, rrule, extra });
    await db.insert(schema.events).values([
      row("no-extra", null),
      row("no-alarms", { timezone: "UTC" }),
      row("empty-alarms", { alarms: [] }),
      row("string-alarms", { alarms: "banana" }),
      row("object-alarms", { alarms: { trigger: "-PT15M" } }),
      row("null-alarms", { alarms: null }),
      row("recurring-no-alarms", { timezone: "UTC" }, "FREQ=DAILY"),
      row("with-alarm", { alarms: ALARM }),
      row("recurring-with-alarm", { alarms: ALARM }, "FREQ=DAILY"),
    ] as never);
    const r = await dispatchDueReminders({ warn: () => undefined });
    expect(r.scanned, "没设提醒的也被取回来了").toBe(2);
  });
});
