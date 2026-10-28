// 导出一份备份、再恢复回去，东西还在不在。
//
// ── 这条的形状 ────────────────────────────────────────────────────────
//
// 恢复是「整库替换」：先按表清单倒序清空，再按正序插回去。清空里包含
// users，而库里几乎每张表都以 ON DELETE CASCADE 挂在它下面。
// 于是**任何没被写进那张清单的用户数据，都会在清空那一步被连带删掉，
// 而插回去那一步根本不会碰它**。
//
// 漏掉的是：预约链接和已收到的预约、三端 App 的登录凭据、SSO 绑定、
// 网页推送订阅。站长为了回滚一次误操作去恢复昨天的备份，结果：
// 客人约好的时间全没了、所有手机和桌面端被登出且再也不在「我的设备」里、
// 用第三方登录的人进不来。页面只说了一句「恢复完成」。
//
// 还有一条更狠的：导出时把软删的事件滤掉了，而指向它们的邀请令牌
//（外键 NOT NULL）照样导出 —— 恢复插到那一步外键报错、整个事务回滚，
// **这份备份根本恢复不了**，而站长是在真要用它的那天才发现。
//
// 判据必须是**真的走一遍 export → import**，不能只断言清单长度：
// 清单里多写一张名字、而表其实没被恢复，长度断言照样绿。

import { vi, beforeAll, beforeEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

import { ensureSchema, resetDb, db, schema, makeUser, makeCalendar } from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";

const { exportData, importData, RestoreNeedsConfirmationError } = await import("../../src/lib/backup.js");

beforeAll(async () => { await ensureSchema(); });

let user: Awaited<ReturnType<typeof makeUser>>;
let cal: Awaited<ReturnType<typeof makeCalendar>>;

/** 种一份「有人在用」的库：每一类用户数据都放一行。 */
async function seed() {
  user = await makeUser("owner@example.com");
  cal = await makeCalendar(user.id);
  const [ev] = await db.insert(schema.events).values({
    calendarId: cal.id, uid: "e1@example.com", summary: "季度复盘",
    startsAt: new Date("2026-07-14T01:00:00Z"), endsAt: new Date("2026-07-14T02:00:00Z"),
  }).returning();
  const [link] = await db.insert(schema.bookingLinks).values({
    userId: user.id, calendarId: cal.id, slug: "chat", title: "聊一聊", weeklyAvailability: {},
  }).returning();
  await db.insert(schema.bookings).values({
    linkId: link!.id, eventId: ev!.id, guestEmail: "g@example.com", guestName: "访客",
    startsAt: ev!.startsAt, endsAt: ev!.endsAt, cancelToken: "tok-cancel-1",
  });
  await db.insert(schema.devices).values({
    userId: user.id, label: "我的 iPhone", kind: "ios",
    refreshTokenHash: "hash-1", refreshTokenPrefix: "bwd_abc12345_",
    lastSeenAt: new Date(),
  });
  await db.insert(schema.userIdentities).values({
    userId: user.id, provider: "keycloak", subject: "sub-1", email: null,
  });
  await db.insert(schema.pushSubscriptions).values({
    userId: user.id, endpoint: "https://push.example.com/x", p256dh: "k1", auth: "a1",
  });
  return { ev: ev!, link: link! };
}

async function counts() {
  const n = async (t: never) => (await db.select().from(t)).length;
  return {
    users: await n(schema.users as never),
    calendars: await n(schema.calendars as never),
    events: await n(schema.events as never),
    bookingLinks: await n(schema.bookingLinks as never),
    bookings: await n(schema.bookings as never),
    devices: await n(schema.devices as never),
    userIdentities: await n(schema.userIdentities as never),
    pushSubscriptions: await n(schema.pushSubscriptions as never),
  };
}

/** 模拟真实流程：导出 → 存成文件 → 再读回来。JSON 往返会把 Date 变成字符串。 */
async function roundTrip() {
  const bundle = JSON.parse(JSON.stringify(await exportData()));
  return await importData(bundle);
}

beforeEach(async () => { await resetDb(); });

describe("备份能原样恢复", () => {
  it("恢复得动（presence）", async () => {
    await seed();
    const before = await counts();
    expect(before.users, "种数据就失败了").toBeGreaterThan(0);
    const r = await roundTrip();
    expect(r.ok).toBe(true);
    expect((await counts()).users, "用户都没恢复回来").toBe(before.users);
  });

  it("**预约链接和已收到的预约还在**", async () => {
    await seed();
    const before = await counts();
    await roundTrip();
    const after = await counts();
    expect(after.bookingLinks, "预约链接没了 —— 公开预约页变 404").toBe(before.bookingLinks);
    expect(
      after.bookings,
      "客人已经约好的时间全没了，而且他们手上的取消链接也失效了 —— " +
        "站长只是想回滚一次误操作，页面还说「恢复完成」",
    ).toBe(before.bookings);
  });

  it("**三端 App 的登录凭据还在**", async () => {
    await seed();
    const before = await counts();
    await roundTrip();
    expect(
      (await counts()).devices,
      "所有手机和桌面端被登出，而且再也不在「我的设备」里 —— 只能重新扫码配对",
    ).toBe(before.devices);
  });

  it("**SSO 绑定和推送订阅还在**", async () => {
    await seed();
    const before = await counts();
    await roundTrip();
    const after = await counts();
    expect(after.userIdentities, "第三方登录绑定断了").toBe(before.userIdentities);
    expect(after.pushSubscriptions, "网页推送静默失效，而设置页还显示「已开启」").toBe(before.pushSubscriptions);
  });

  it("**有软删事件时这份备份仍然恢复得了**（否则整份文件是废的）", async () => {
    const { ev } = await seed();
    // 给它挂一个邀请令牌，再把事件软删 —— 这正是线上会出现的形状。
    await db.insert(schema.eventInviteTokens).values({
      token: "tok-invite-1", sourceEventId: ev.id, recipientEmail: "b@example.com",
      expiresAt: new Date(Date.now() + 86400_000),
    });
    await db.update(schema.events).set({ deletedAt: new Date() });

    const r = await roundTrip();
    expect(
      r.ok,
      "导出时把软删的事件滤掉了，而指向它的邀请令牌照样导出 —— " +
        "恢复到那一步外键报错、整个事务回滚，这份备份根本用不了。" +
        "站长是在真要用它的那天才发现。",
    ).toBe(true);
    const toks = await db.select().from(schema.eventInviteTokens);
    expect(toks.length, "邀请令牌没恢复").toBe(1);
  });

  it("回收站里的事件跟着备份走（用户随时可能撤销删除）", async () => {
    await seed();
    await db.update(schema.events).set({ deletedAt: new Date() });
    await roundTrip();
    const rows = await db.select().from(schema.events);
    expect(rows.length, "回收站被备份清空了 —— 恢复之后撤销删除没东西可撤").toBe(1);
    expect(rows[0]!.deletedAt, "恢复之后它不该跑回日历里，应该还在回收站").toBeTruthy();
  });

  it("旧版本导出的备份：确认清空之后，缺哪些表、清空了什么都要明说", async () => {
    await seed();
    const bundle = JSON.parse(JSON.stringify(await exportData()));
    // 模拟旧版本的文件：整张表都没有（不是「有但是空的」）。
    delete bundle.tables.bookings;
    delete bundle.tables.devices;
    const r = await importData(bundle, { confirmEmptying: ["bookings", "devices"] });
    expect(r.missingTables, "缺表没被报出来，站长得到的只有「恢复完成」").toEqual(
      expect.arrayContaining(["bookings", "devices"]),
    );
    expect(r.emptiedTables.map((x) => x.table).sort(), "清空了哪些有数据的表没报出来").toEqual(["bookings", "devices"]);
  });

  it("表都在、只是空的，不算缺表", async () => {
    // 少了这条，上面那条在「把所有表都当成缺失」的实现下也会绿。
    await seed();
    const bundle = JSON.parse(JSON.stringify(await exportData()));
    bundle.tables.bookings = [];
    const r = await importData(bundle);
    expect(r.missingTables).not.toContain("bookings");
  });
});

describe("旧备份缺表：没确认就一行都不删", () => {
  // 以前是先清空、恢复完再提示「这些表现在是空的」—— 那时数据已经没了。
  // 1.7.3 之前导出的备份缺预约、预约链接、App 设备、SSO 绑定、推送订阅、OAuth……
  // 拿它恢复，这些全没，页面上那句提示挽回不了任何东西。

  async function oldBundle() {
    const bundle = JSON.parse(JSON.stringify(await exportData()));
    delete bundle.tables.bookings;
    delete bundle.tables.devices;
    return bundle;
  }

  it("**没确认 → 抛 RestoreNeedsConfirmationError，库里一行不少**", async () => {
    await seed();
    const before = await counts();
    const bundle = await oldBundle();
    // 恢复前先往库里多塞一个用户：真恢复了的话这一行会被换掉。
    await makeUser("added-after-export@example.com");
    const beforeWithExtra = await counts();
    expect(beforeWithExtra.users, "种数据失败").toBe(before.users + 1);

    let caught: unknown = null;
    try { await importData(bundle); } catch (e) { caught = e; }
    expect(caught, "缺表的旧备份没被拦下，直接恢复了").toBeInstanceOf(RestoreNeedsConfirmationError);
    const atRisk = (caught as InstanceType<typeof RestoreNeedsConfirmationError>).atRisk;
    expect(atRisk.map((x) => x.table).sort()).toEqual(["bookings", "devices"]);
    expect(atRisk.every((x) => x.rows === 1), `行数报错了：${JSON.stringify(atRisk)}`).toBe(true);

    expect(await counts(), "拦下来了，可库已经被动过 —— 清空那一步在检查之前跑了").toEqual(beforeWithExtra);
  });

  it("只确认了一部分 → 照样拦，什么都不动", async () => {
    await seed();
    const before = await counts();
    await expect(importData(await oldBundle(), { confirmEmptying: ["devices"] }))
      .rejects.toBeInstanceOf(RestoreNeedsConfirmationError);
    expect(await counts()).toEqual(before);
  });

  it("缺的表库里本来就没数据 → 不拦，直接恢复（没东西可丢）", async () => {
    // 少了这条，「凡是缺表就拦」的实现也能让上面两条绿 —— 而那会把每一份
    // 旧备份都卡住，哪怕它什么都不会丢。
    await seed();
    const bundle = JSON.parse(JSON.stringify(await exportData()));
    delete bundle.tables.webhooks;          // seed 里没建过 webhook
    delete bundle.tables.oauth_clients;     // 也没建过 OAuth 应用
    const r = await importData(bundle);
    expect(r.ok).toBe(true);
    expect(r.missingTables).toEqual(expect.arrayContaining(["webhooks", "oauth_clients"]));
    expect(r.emptiedTables).toEqual([]);
  });

  it("那张表的值不是数组（坏文件）也按缺失算，照样拦", async () => {
    await seed();
    const before = await counts();
    const bundle = JSON.parse(JSON.stringify(await exportData()));
    bundle.tables.devices = null;
    await expect(importData(bundle)).rejects.toBeInstanceOf(RestoreNeedsConfirmationError);
    expect(await counts()).toEqual(before);
  });
});

