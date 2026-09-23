// 公开预约页收到的 startsAt 到底可信不可信 —— 直接调下单函数（它是唯一入口）。
//
// ── 这条的形状 ────────────────────────────────────────────────────────
//
// 店主在预约链接上设了「周一到周五 9:00–18:00、30 分钟一档、至少提前 2 小时、
// 最多约 14 天内」。页面按这些规则画出可选时段。
//
// 但下单那一步**只查了「这个时间有没有和已有事件撞上」** —— 没查它是不是
// 页面放出来的那些时段之一。那张表单是公开的，谁都可以自己拼一个 POST：
// 凌晨三点、周日、去年、五年以后，只要那个时刻恰好没排东西就写得进去。
// 店主第二天打开日历，看到一堆自己从没放出来过的时段被约满了。
//
// CSRF 挡不住这个：访客本来就能打开页面拿到 token，它防的是跨站，不是越权。
//
// 判据直接问 availableSlots —— 页面画可选时段用的就是这一个函数。不另写
// 一份校验：两份判据迟早会各走各的，而那种偏差没人看得见。

import { vi, beforeAll, beforeEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

import { eq } from "drizzle-orm";
import { ensureSchema, resetDb, db, schema, makeUser, makeCalendar } from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";

const { availableSlots, bookSlot, BookingError } = await import("../../src/lib/booking.js");

beforeAll(async () => { await ensureSchema(); });

let user: Awaited<ReturnType<typeof makeUser>>;
let cal: Awaited<ReturnType<typeof makeCalendar>>;
let link: typeof schema.bookingLinks.$inferSelect;

beforeEach(async () => {
  await resetDb();
  user = await makeUser("owner@example.com");
  cal = await makeCalendar(user.id);
  const [l] = await db.insert(schema.bookingLinks).values({
    userId: user.id, calendarId: cal.id, slug: "chat", title: "聊一聊",
    durationMinutes: 30, minNoticeHours: 2, maxDaysAhead: 14,
    // 周一到周五 9:00–18:00（上海墙上时间），周末不开。
    weeklyAvailability: { "1": [["09:00", "18:00"]], "2": [["09:00", "18:00"]],
      "3": [["09:00", "18:00"]], "4": [["09:00", "18:00"]], "5": [["09:00", "18:00"]] },
  }).returning();
  link = l!;
});

async function book(startsAt: Date) {
  return bookSlot({
    link, startsAt,
    endsAt: new Date(startsAt.getTime() + link.durationMinutes * 60_000),
    guestEmail: "guest@example.com", guestName: "访客",
  });
}
async function refuses(startsAt: Date): Promise<boolean> {
  try { await book(startsAt); return false; }
  catch (e) { return e instanceof BookingError; }
}
async function eventCount(): Promise<number> {
  const rows = await db.select().from(schema.events).where(eq(schema.events.calendarId, cal.id));
  return rows.length;
}

describe("公开预约不能往店主日历里写任意时间", () => {
  it("正常时段约得上（presence）", async () => {
    // 少了这条，下面所有「被拒了」的断言在「这条路整个不通」时也全绿。
    const slots = await availableSlots(link, new Date(), link.maxDaysAhead);
    expect(slots.length, "这个链接一个可约时段都算不出来 —— 这组用例什么也测不到").toBeGreaterThan(0);
    const { booking } = await book(slots[0]!.startsAt);
    expect(booking.id).toBeTruthy();
    expect(await eventCount(), "约上了却没往日历里写事件").toBe(1);
  });

  it("**页面上没放出来的时间约不上**（这条是这个文件的核心）", async () => {
    // 凌晨三点：在可用时间窗之外，但那个时刻日历上是空的，
    // 所以「只查冲突」的写法会把它放进去。
    const slots = await availableSlots(link, new Date(), link.maxDaysAhead);
    const day = slots[0]!.startsAt;
    const at3am = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 19, 0, 0)); // 上海次日 03:00
    expect(
      await refuses(at3am),
      "凌晨三点这个时段页面上从来没放出来过，却约得上 —— " +
        "那张表单是公开的，任何人都能自己拼一个 POST 往店主日历里写任意时间的事件",
    ).toBe(true);
    expect(await eventCount(), "被拒了却还是写进了日历").toBe(0);
  });

  it("周末约不上（店主根本没开这天）", async () => {
    const d = new Date();
    // 往后找到第一个周六的上海 10:00
    const sat = new Date(d);
    while (sat.getUTCDay() !== 6) sat.setUTCDate(sat.getUTCDate() + 1);
    const at10 = new Date(Date.UTC(sat.getUTCFullYear(), sat.getUTCMonth(), sat.getUTCDate(), 2, 0, 0));
    expect(await refuses(at10), "周末没开却约得上").toBe(true);
  });

  it("过去的时间约不上", async () => {
    const lastYear = new Date(Date.now() - 365 * 24 * 3600_000);
    expect(await refuses(lastYear), "去年的时间约得上 —— 日历上会多出一条历史记录").toBe(true);
  });

  it("超出「最多约多少天以内」的约不上", async () => {
    const farOut = new Date(Date.now() + (link.maxDaysAhead + 30) * 24 * 3600_000);
    expect(await refuses(farOut), "店主设了最多 14 天，而五十天后也约得上").toBe(true);
  });

  it("没对齐到时段起点的约不上（09:07 这种）", async () => {
    const slots = await availableSlots(link, new Date(), link.maxDaysAhead);
    const off = new Date(slots[0]!.startsAt.getTime() + 7 * 60_000);
    expect(await refuses(off), "09:07 这种没对齐的时间约得上，日历会被切碎").toBe(true);
  });

  it("不满足「至少提前 2 小时」的约不上", async () => {
    // 把提前量调大到 30 天，原本第一个可约时段就变成不满足了。
    await db.update(schema.bookingLinks).set({ minNoticeHours: 24 * 30 }).where(eq(schema.bookingLinks.id, link.id));
    const [fresh] = await db.select().from(schema.bookingLinks).where(eq(schema.bookingLinks.id, link.id));
    const slotsBefore = await availableSlots(link, new Date(), link.maxDaysAhead);
    link = fresh!;
    expect(await refuses(slotsBefore[0]!.startsAt), "店主要求提前 30 天，而明天的时段也约得上").toBe(true);
  });

  it("同一个时段不能被约两次", async () => {
    const slots = await availableSlots(link, new Date(), link.maxDaysAhead);
    await book(slots[0]!.startsAt);
    expect(await refuses(slots[0]!.startsAt), "同一个时段被约了两次").toBe(true);
  });

  it("被拒时给的是可翻译的原因码，不是一句写死的中文", async () => {
    // 路由会把它翻成访客自己的语言。以前这里抛的是硬编码中文，
    // 德语 / 日语访客看到的就是中文。
    try {
      await book(new Date(Date.now() - 365 * 24 * 3600_000));
      throw new Error("本该被拒");
    } catch (e) {
      expect(e).toBeInstanceOf(BookingError);
      expect((e as InstanceType<typeof BookingError>).code).toBe("slotUnavailable");
    }
  });
});
