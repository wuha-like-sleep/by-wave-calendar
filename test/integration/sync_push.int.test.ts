// 同步推送清扫器（增量同步第三批，lib/sync_push.ts）集成测试。
//
// 为什么必须在真库（PGlite）上打：这批的命门全在状态的交界上 ——
//   · 变化来自迁移 0072 的触发器写的 event_changes，绕过它造数据等于
//     没测（所以这里一律真实插/改 events 行，让触发器自己记账）；
//   · 水位只在推送送达后推进、节流期内不重推、失败退避 —— 都是跨
//     多轮清扫的状态机行为，纯函数测不出「第二轮读到的正是第一轮
//     写下的水位」这件事；
//   · 载荷纪律是安全断言：事件标题绝不能出现在推送里。造一个标题
//     极其显眼的事件，断言捕获到的载荷 JSON 里没有它。
import { vi, beforeAll, beforeEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
vi.mock("../../src/lib/mailer.js", () => ({ sendMail: vi.fn(async () => ({ ok: true })), isMailerEnabled: vi.fn(async () => true) }));
vi.mock("../../src/lib/calendar_sync/queue.js", () => ({ requestCalendarSync: vi.fn(async () => undefined) }));
vi.mock("../../src/lib/apns.js", () => ({ pushEventChanged: vi.fn(async () => undefined) }));
vi.mock("../../src/lib/webhooks.js", () => ({ dispatchWebhook: vi.fn(async () => undefined), eventToWebhookPayload: (event: unknown) => event }));

import { eq } from "drizzle-orm";
import {
  ensureSchema, resetDb, db, schema,
  makeUser, makeCalendar, makeMembership,
} from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://localhost:5432/bywave";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";

const { runSyncPushSweep, __resetSyncPushStateForTest } = await import("../../src/lib/sync_push.js");
const { syncWatermark } = await import("../../src/lib/event_sync.js");

type SentPush = { userId: string; payload: Record<string, unknown> };

/** 可控的发送端：记录每次调用，结果可按用例切换。 */
function fakeSend(result: { sent: number; failed: number } = { sent: 1, failed: 0 }) {
  const calls: SentPush[] = [];
  const send = vi.fn(async (userId: string, payload: Record<string, unknown>) => {
    calls.push({ userId, payload });
    return result;
  });
  return { calls, send };
}

async function subscribe(userId: string): Promise<void> {
  await db.insert(schema.pushSubscriptions).values({
    userId,
    endpoint: `https://push.example.test/${userId}`,
    p256dh: "p256dh-key",
    auth: "auth-secret",
  });
}

async function addEvent(calendarId: string, uid: string, summary = "E"): Promise<void> {
  await db.insert(schema.events).values({
    calendarId,
    uid,
    summary,
    startsAt: new Date("2026-03-01T00:00:00Z"),
    endsAt: new Date("2026-03-01T01:00:00Z"),
  });
}

async function stateOf(userId: string) {
  const [row] = await db
    .select()
    .from(schema.syncPushState)
    .where(eq(schema.syncPushState.userId, userId))
    .limit(1);
  return row ?? null;
}

const T0 = new Date("2026-11-24T00:00:00Z");

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  vi.clearAllMocks();
  __resetSyncPushStateForTest();
  await resetDb();
});

describe("sync push sweeper", () => {
  it("首次见到有订阅的用户只立基线，不补推历史", async () => {
    const a = await makeUser("a@example.test");
    const cal = await makeCalendar(a.id);
    await subscribe(a.id);
    await addEvent(cal.id, "e1");

    const { calls, send } = fakeSend();
    const r = await runSyncPushSweep({ now: T0, send });
    expect(calls).toHaveLength(0);
    expect(r.baselined).toBe(1);

    const { high } = await syncWatermark();
    const st = await stateOf(a.id);
    expect(st?.pushedSeq).toBe(high);
    expect(st?.lastPushedAt).toBeNull();
  });

  it("基线之后的变化推一条，载荷只有信号、没有事件数据，水位推进到当前高度", async () => {
    const a = await makeUser("a@example.test");
    const cal = await makeCalendar(a.id);
    await subscribe(a.id);
    await addEvent(cal.id, "e1");
    const { calls, send } = fakeSend();
    await runSyncPushSweep({ now: T0, send });  // 立基线
    expect(calls).toHaveLength(0);

    await addEvent(cal.id, "e2", "绝密会议标题 XYZ123");
    const r = await runSyncPushSweep({ now: T0, send });
    expect(r.pushed).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.userId).toBe(a.id);

    const payload = calls[0]!.payload;
    expect(payload.type).toBe("events_sync");
    expect(payload.tag).toBe("bwc-events-sync");
    const raw = JSON.stringify(payload);
    expect(raw).not.toContain("绝密会议标题");
    expect(raw).not.toContain("XYZ123");
    // 载荷的键就这么几个 —— 多一个都说明有数据开始往推送里渗。
    expect(Object.keys(payload).sort()).toEqual(["body", "tag", "title", "type", "url"]);

    const { high } = await syncWatermark();
    const st = await stateOf(a.id);
    expect(st?.pushedSeq).toBe(high);
    expect(st?.lastPushedAt?.getTime()).toBe(T0.getTime());
  });

  it("最小间隔内不重推（水位不动），过了间隔合并推一条", async () => {
    const a = await makeUser("a@example.test");
    const cal = await makeCalendar(a.id);
    await subscribe(a.id);
    await addEvent(cal.id, "e1");
    const { calls, send } = fakeSend();
    await runSyncPushSweep({ now: T0, send });  // 立基线

    await addEvent(cal.id, "e2");
    await runSyncPushSweep({ now: T0, send });  // 推第一条
    expect(calls).toHaveLength(1);
    const afterFirst = await stateOf(a.id);

    await addEvent(cal.id, "e3");
    const r2 = await runSyncPushSweep({ now: new Date(T0.getTime() + 10_000), send });
    expect(r2.throttled).toBe(1);
    expect(calls).toHaveLength(1);
    expect((await stateOf(a.id))?.pushedSeq).toBe(afterFirst?.pushedSeq);

    const r3 = await runSyncPushSweep({ now: new Date(T0.getTime() + 31_000), send });
    expect(r3.pushed).toBe(1);
    expect(calls).toHaveLength(2);
    const { high } = await syncWatermark();
    expect((await stateOf(a.id))?.pushedSeq).toBe(high);
  });

  it("没有订阅的用户：不推，也不给他建水位行", async () => {
    const b = await makeUser("b@example.test");
    const cal = await makeCalendar(b.id);
    await addEvent(cal.id, "e1");
    await addEvent(cal.id, "e2");

    const { calls, send } = fakeSend();
    const r = await runSyncPushSweep({ now: T0, send });
    expect(r.users).toBe(0);
    expect(calls).toHaveLength(0);
    expect(await stateOf(b.id)).toBeNull();
  });

  it("共享日历：成员收到推送；非成员不收，但水位静默推进", async () => {
    const owner = await makeUser("owner@example.test");
    const member = await makeUser("member@example.test");
    const outsider = await makeUser("outsider@example.test");
    const cal = await makeCalendar(owner.id);
    await makeMembership(cal.id, member.id);
    await subscribe(member.id);
    await subscribe(outsider.id);
    await addEvent(cal.id, "e1");

    const { calls, send } = fakeSend();
    await runSyncPushSweep({ now: T0, send });  // 两人立基线
    expect(calls).toHaveLength(0);

    await addEvent(cal.id, "e2");
    const r = await runSyncPushSweep({ now: T0, send });
    expect(r.pushed).toBe(1);
    expect(r.advanced).toBe(1);
    expect(calls.map((c) => c.userId)).toEqual([member.id]);

    const { high } = await syncWatermark();
    expect((await stateOf(outsider.id))?.pushedSeq).toBe(high);
  });

  it("发送失败不推进水位，退避期内不重试，退避过后重试成功才推进", async () => {
    const a = await makeUser("a@example.test");
    const cal = await makeCalendar(a.id);
    await subscribe(a.id);
    await addEvent(cal.id, "e1");
    const ok = fakeSend();
    await runSyncPushSweep({ now: T0, send: ok.send });  // 立基线

    await addEvent(cal.id, "e2");
    const failing = fakeSend({ sent: 0, failed: 1 });
    const r1 = await runSyncPushSweep({ now: T0, send: failing.send });
    expect(r1.failed).toBe(1);
    expect(failing.calls).toHaveLength(1);
    const stAfterFail = await stateOf(a.id);
    expect(stAfterFail?.lastPushedAt).toBeNull();
    const { high } = await syncWatermark();
    expect(stAfterFail?.pushedSeq).toBeLessThan(high);

    // 退避期内（5 分钟）再扫：连发送都不尝试。
    const r2 = await runSyncPushSweep({ now: new Date(T0.getTime() + 60_000), send: failing.send });
    expect(r2.failed).toBe(1);
    expect(failing.calls).toHaveLength(1);

    // 退避过后恢复发送：这次成功，水位才推进。
    const r3 = await runSyncPushSweep({ now: new Date(T0.getTime() + 6 * 60_000), send: ok.send });
    expect(r3.pushed).toBe(1);
    expect((await stateOf(a.id))?.pushedSeq).toBe(high);
  });

  it("变更日志被裁剪过（同步令牌会吃 410 的那片区间）不影响清扫：新变化照常推", async () => {
    const a = await makeUser("a@example.test");
    const cal = await makeCalendar(a.id);
    await subscribe(a.id);
    await addEvent(cal.id, "e1");
    const { calls, send } = fakeSend();
    await runSyncPushSweep({ now: T0, send });  // 立基线

    // 模拟保留期裁剪把日志清空（客户端手里的旧令牌此时会吃 410 全量
    // 重建 —— 那是同步端点的契约，和清扫器无关：清扫器只认序号水位）。
    await db.delete(schema.eventChanges);
    await addEvent(cal.id, "e2");

    const r = await runSyncPushSweep({ now: T0, send });
    expect(r.pushed).toBe(1);
    expect(calls).toHaveLength(1);
    const { high } = await syncWatermark();
    expect((await stateOf(a.id))?.pushedSeq).toBe(high);
  });

  it("别人日历上的变化与自己无关时不推：只有自己能看见的变化才算", async () => {
    const a = await makeUser("a@example.test");
    const other = await makeUser("other@example.test");
    const calA = await makeCalendar(a.id);
    const calOther = await makeCalendar(other.id);
    await subscribe(a.id);
    await addEvent(calA.id, "e1");
    const { calls, send } = fakeSend();
    await runSyncPushSweep({ now: T0, send });  // 立基线

    await addEvent(calOther.id, "x1");
    const r = await runSyncPushSweep({ now: T0, send });
    expect(r.pushed).toBe(0);
    expect(r.advanced).toBe(1);
    expect(calls).toHaveLength(0);
  });
});
