// 0056：让手机重新下载一遍「网页 / App 建的全天事件」。
//
// 4c0668b 修好了全天事件导出的 DTEND，但已经同步到 iPhone / DAVx⁵ 上的那份不会
// 自己变 —— 单条 etag 只喂 updated_at，这一版一行数据都没动。这条迁移是纯 SQL，
// 唯一能测的就是「把 .sql 喂给数据库之后，哪些行变了、哪些没变」，以及
// 「从 CalDAV 打进去，客户端读到的 ctag / etag 到底变没变」。
//
// 每条断言都要能红：
//   · 改窄范围（漏掉常量之后编辑过的行）→「常量之后被编辑过的也要 bump」红
//   · 改宽范围（去掉 raw_ics / deleted_at / all_day 条件）→ 对应的「不动」红
//   · 删掉语句二（纪元）→「ctag 必须变」红 —— 这正是 0051 实测过的那个坑
import { vi, beforeAll, beforeEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { ensureSchema, resetDb, pg, db, schema, makeCalendar } from "./harness.js";

// 下面几个模块一加载就校验环境变量，必须先填好再动态 import。
process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const { hashPassword } = await import("../../src/lib/password.js");
const { invalidateCalDavAuthCache } = await import("../../src/lib/caldav_auth.js");
const { caldavRoutes } = await import("../../src/web/caldav.js");
const { reloadSettings, updateSettings } = await import("../../src/lib/site_settings.js");

const MIGRATION = "drizzle/migrations/0056_allday_dtend_resync.sql";
/** 迁移里写死的那个时刻。测试和迁移文件对不上就该红 —— 见「常量没跑偏」那条。 */
const STAMP = "2026-10-28T10:00:00.000Z";
const EPOCH = "2026-10-28-allday-dtend";

beforeAll(async () => { await ensureSchema(); });
beforeEach(async () => {
  await resetDb();
  invalidateCalDavAuthCache();
  // site_settings 被 TRUNCATE 了，但设置缓存是模块级的。
  reloadSettings();
});

/** 按仓库迁移器的方式跑：按 statement-breakpoint 拆开逐条执行。 */
async function runMigration(): Promise<void> {
  for (const stmt of readFileSync(MIGRATION, "utf8").split("--> statement-breakpoint")) {
    const t = stmt.trim();
    if (t) await pg.exec(t);
  }
}

const PASSWORD = "allday-resync-test-pw-123456";
async function makeAuthedUser(email: string) {
  const [u] = await db
    .insert(schema.users)
    .values({ email, emailVerified: true, passwordHash: await hashPassword(PASSWORD) })
    .returning();
  return u!;
}

type SeedOpts = {
  uid: string;
  allDay?: boolean;
  rawIcs?: string | null;
  deletedAt?: Date | null;
  updatedAt?: Date;
};

async function seedEvent(calendarId: string, o: SeedOpts): Promise<string> {
  const allDay = o.allDay ?? true;
  const [row] = await db.insert(schema.events).values({
    calendarId,
    uid: o.uid,
    summary: o.uid,
    // 网页 / App 写全天事件的那套约定：当天 00:00Z 到 23:59:59.999Z。
    startsAt: new Date("2026-09-21T00:00:00.000Z"),
    endsAt: allDay ? new Date("2026-09-21T23:59:59.999Z") : new Date("2026-09-21T01:00:00.000Z"),
    allDay,
    rawIcs: o.rawIcs ?? null,
    deletedAt: o.deletedAt ?? null,
    updatedAt: o.updatedAt ?? new Date("2026-01-02T03:04:05.000Z"),
  }).returning();
  return row!.id;
}

async function updatedAtOf(id: string): Promise<string> {
  const [row] = await db.select().from(schema.events).where(eq(schema.events.id, id)).limit(1);
  return row!.updatedAt.toISOString();
}

async function epochInDb(): Promise<string> {
  const [row] = await db.select().from(schema.siteSettings).where(eq(schema.siteSettings.id, 1)).limit(1);
  return row!.caldavSyncEpoch;
}

async function newCalendar(): Promise<string> {
  const u = await makeAuthedUser(`m${Date.now()}${Math.random()}@example.com`);
  return (await makeCalendar(u.id, "Cal")).id;
}

describe("0056 哪些事件被 bump", () => {
  it("网页 / App 建的全天事件（没有 raw_ics）被 bump 到那个时刻（presence）", async () => {
    const cal = await newCalendar();
    const id = await seedEvent(cal, { uid: "a1" });
    await runMigration();
    expect(await updatedAtOf(id), "该重下的全天事件没被 bump —— 手机上那份会一直画错一天").toBe(STAMP);
  });

  it("raw_ics 里只有别的东西、没有 VEVENT 的，按合成路径算，也 bump", async () => {
    const cal = await newCalendar();
    const id = await seedEvent(cal, { uid: "a2", rawIcs: "X-NOTHING" });
    await runMigration();
    expect(await updatedAtOf(id)).toBe(STAMP);
  });

  it("常量之后才被编辑过的全天事件也要 bump —— 手机上那份可能还是改之前抓的", async () => {
    const cal = await newCalendar();
    const id = await seedEvent(cal, { uid: "a3", updatedAt: new Date("2027-05-05T00:00:00.000Z") });
    await runMigration();
    expect(await updatedAtOf(id)).toBe(STAMP);
  });

  it("定时事件不动 —— 它的导出这一版没变", async () => {
    const cal = await newCalendar();
    const id = await seedEvent(cal, { uid: "t1", allDay: false });
    const before = await updatedAtOf(id);
    await runMigration();
    expect(await updatedAtOf(id)).toBe(before);
  });

  it("raw_ics 原文回放的全天事件不动 —— bump 了就是让每台手机白下一遍", async () => {
    const cal = await newCalendar();
    const id = await seedEvent(cal, { uid: "r1", rawIcs: "BEGIN:VEVENT\r\nUID:r1\r\nEND:VEVENT" });
    const before = await updatedAtOf(id);
    await runMigration();
    expect(await updatedAtOf(id)).toBe(before);
  });

  it("软删掉的全天事件不动 —— 它不出现在 CalDAV 响应里", async () => {
    const cal = await newCalendar();
    const id = await seedEvent(cal, { uid: "d1", deletedAt: new Date("2026-02-01T00:00:00Z") });
    const before = await updatedAtOf(id);
    await runMigration();
    expect(await updatedAtOf(id)).toBe(before);
  });

  it("跑两遍第二遍一行都不改（开机重放不能让全体手机再白下一轮）", async () => {
    const cal = await newCalendar();
    await seedEvent(cal, { uid: "c1" });
    await seedEvent(cal, { uid: "c2", allDay: false });
    await seedEvent(cal, { uid: "c3", rawIcs: "BEGIN:VEVENT\r\nEND:VEVENT" });
    await db.insert(schema.siteSettings).values({ id: 1 }).onConflictDoNothing();
    await runMigration();
    const snap = async () =>
      (await db.select().from(schema.events)).map((r) => `${r.uid}=${r.updatedAt.toISOString()}`).sort();
    const first = await snap();
    const firstEpoch = await epochInDb();
    await runMigration();
    expect(await snap()).toEqual(first);
    expect(await epochInDb()).toBe(firstEpoch);
  });

  it("常量没跑偏：迁移里写的就是测试断言的那个时刻和纪元", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const stamps = [...sql.matchAll(/TIMESTAMPTZ '([^']+)'/g)].map((m) => m[1]!);
    expect(stamps.length, "应该恰好两处（SET 一处、WHERE 一处）").toBe(2);
    expect(new Set(stamps).size, "两处必须是同一个值，否则第二遍跑就不是 no-op").toBe(1);
    const iso = stamps[0]!.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
    expect(new Date(iso).toISOString()).toBe(STAMP);
    const epochs = [...sql.matchAll(/caldav_sync_epoch(?: IS DISTINCT FROM| =) '([^']+)'/g)].map((m) => m[1]!);
    expect(epochs.length).toBe(2);
    expect(new Set(epochs)).toEqual(new Set([EPOCH]));
  });
});

describe("0056 的同步纪元", () => {
  beforeEach(async () => {
    await db.insert(schema.siteSettings).values({ id: 1 }).onConflictDoNothing();
  });

  it("纪元被 bump 成这一版的字面量", async () => {
    expect(await epochInDb(), "起点不是空串，下面那条「变了」验不出东西").toBe("");
    await runMigration();
    expect(await epochInDb()).toBe(EPOCH);
  });

  it("盖掉后台手动 bump 留下的值 —— 发版的重拉不能被管理员按过按钮就吞掉", async () => {
    await updateSettings({ caldavSyncEpoch: "manual:2099-01-01T00:00:00.000Z:deadbeefcafe" });
    await runMigration();
    expect(await epochInDb()).toBe(EPOCH);
  });
});

// ---------------------------------------------------------------------------
// 从 CalDAV 打进去：客户端读到的东西到底变没变。
// ---------------------------------------------------------------------------

async function buildApp() {
  const app = Fastify({ logger: false });
  app.addHttpMethod("PROPFIND", { hasBody: true });
  app.addHttpMethod("REPORT", { hasBody: true });
  app.addContentTypeParser(
    /^(application\/xml|text\/xml|text\/calendar)\b/i,
    { parseAs: "string" },
    (_req, body, done) => done(null, body as string),
  );
  await app.register(caldavRoutes);
  await app.ready();
  return app;
}
type App = Awaited<ReturnType<typeof buildApp>>;
type InjectLike = (opts: Record<string, unknown>) => Promise<{ statusCode: number; body: string }>;

async function propfind(app: App, user: { id: string; email: string }, calId: string) {
  const inject = app.inject as unknown as InjectLike;
  const res = await inject({
    method: "PROPFIND",
    url: `/caldav/${user.id}/${calId}/`,
    headers: {
      authorization: "Basic " + Buffer.from(`${user.email}:${PASSWORD}`).toString("base64"),
      depth: "1", "content-type": "application/xml",
    },
    payload: `<?xml version="1.0"?><propfind xmlns="DAV:"><prop><getetag/><getctag xmlns="http://calendarserver.org/ns/"/></prop></propfind>`,
  });
  expect(res.statusCode, `PROPFIND 没返回 207：${res.body.slice(0, 300)}`).toBe(207);
  return res.body;
}
function ctagOf(xml: string): string {
  const m = xml.match(/<CS:getctag>([^<]*)<\/CS:getctag>/);
  expect(m, "响应里没有 <CS:getctag> —— 这条用例什么也没验到").not.toBeNull();
  return m![1]!;
}
/** 每个事件的 etag，按事件 uid 取（href 里带着 uid）。 */
function etagFor(xml: string, uid: string): string {
  const blocks = xml.split(/<\/?(?:D:)?response>/).filter((b) => b.includes(uid));
  expect(blocks.length, `响应里找不到 ${uid}`).toBeGreaterThan(0);
  const m = blocks[0]!.match(/<getetag>([^<]*)<\/getetag>/);
  expect(m, `${uid} 那条没有 getetag`).not.toBeNull();
  return m![1]!;
}

describe("0056 从 CalDAV 看", () => {
  it("**日历里有更新的别的事件时，ctag 照样变**（只改 updated_at 不够，0051 实测过）", async () => {
    const app = await buildApp();
    const user = await makeAuthedUser("dav@example.com");
    const cal = await makeCalendar(user.id, "Cal");
    // 要修的那条：网页建的全天事件，updated_at 比常量早。
    await seedEvent(cal.id, { uid: "allday-web" });
    // 同一个日历里一条更新的订阅事件：max(updated_at) 落在它身上，
    // 只改 updated_at 的话 ctag 一个字节都不会变。
    await seedEvent(cal.id, {
      uid: "sub-event", allDay: false,
      rawIcs: "BEGIN:VEVENT\r\nUID:sub-event\r\nSUMMARY:sub\r\nDTSTART:20260921T010000Z\r\nDTEND:20260921T020000Z\r\nEND:VEVENT",
      updatedAt: new Date("2030-01-01T00:00:00.000Z"),
    });

    const before = await propfind(app, user, cal.id);
    await runMigration();
    reloadSettings();
    const after = await propfind(app, user, cal.id);

    expect(
      ctagOf(after),
      "ctag 没变 —— 苹果日历根本不会来重新列这个日历，单条 etag 变了也没人看见，" +
        "手机上的全天事件继续画错一天",
    ).not.toBe(ctagOf(before));
    expect(etagFor(after, "allday-web"), "要修的那条 etag 没变，客户端不会重下它").not.toBe(etagFor(before, "allday-web"));
    expect(etagFor(after, "sub-event"), "没改的订阅事件 etag 也变了 —— 每台手机白下一遍").toBe(etagFor(before, "sub-event"));
    await app.close();
  });
});
