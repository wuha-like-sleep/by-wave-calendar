// 1.7.4 升级时对老数据做的两件事：
//
//   一、0058（纯 SQL）：让手机把「网页 / App 建的定时重复事件」重新下载一遍 ——
//       导出从 DTSTART:…Z 改成了 DTSTART;TZID=日历时区，已经同步到手机上的那份不会自己变。
//   二、数据迁移（src/lib/data_migrations.ts，程序里算）：以前「删掉这一次」记下的是旧算法
//       （按 UTC 展开）算出来的时刻，对到新算法里同序号的那一次。
//
// 断言读的是用户看得到的东西：GET /api/v1/events 里少的是哪一天、CalDAV 拿到的 EXDATE / etag / ctag。
// 每条都要能红：
//   · 0058 改窄 / 改宽范围、删掉纪元那句 → 对应的「bump / 不动 / ctag 变」红
//   · 数据迁移不对齐序号、不认记账、不刷新 updated_at、恢复备份后不跑 → 对应的那条红
import { vi, beforeAll, beforeEach, afterEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

import Fastify, { type FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { ensureSchema, resetDb, pg, db, schema, buildRoutedApp, loginAs } from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const { eventRoutes } = await import("../../src/routes/events.js");
const { caldavRoutes } = await import("../../src/web/caldav.js");
const { hashPassword } = await import("../../src/lib/password.js");
const { invalidateCalDavAuthCache } = await import("../../src/lib/caldav_auth.js");
const { reloadSettings, updateSettings } = await import("../../src/lib/site_settings.js");
const { runDataMigrations, EXDATE_LOCAL_TIME_MIGRATION } = await import("../../src/lib/data_migrations.js");
const { listSeriesStartsLegacyUtc } = await import("../../src/lib/rrule_expand.js");
const { exportData, importData } = await import("../../src/lib/backup.js");

const MIGRATION = "drizzle/migrations/0058_recurring_local_time_resync.sql";
const STAMP = "2026-10-29T10:00:00.000Z";
const EPOCH = "2026-10-29-recurring-local-time";
const PASSWORD = "recurring-resync-test-pw-123456";
const MEL = "Australia/Melbourne";
const quiet = { info: () => undefined, error: () => undefined };

beforeAll(async () => { await ensureSchema(); });

let api: FastifyInstance;
let cookie: string;
let user: typeof schema.users.$inferSelect;

beforeEach(async () => {
  await resetDb();
  invalidateCalDavAuthCache();
  reloadSettings();
  api = await buildRoutedApp(eventRoutes, { prefix: "/api/v1" });
  const [u] = await db.insert(schema.users)
    .values({ email: "mel@example.com", emailVerified: true, passwordHash: await hashPassword(PASSWORD), passwordSet: true })
    .returning();
  user = u!;
  cookie = await loginAs(api, user.id);
  await db.insert(schema.siteSettings).values({ id: 1 }).onConflictDoNothing();
});
afterEach(async () => { await api.close(); });

async function runSqlMigration(): Promise<void> {
  for (const stmt of readFileSync(MIGRATION, "utf8").split("--> statement-breakpoint")) {
    const t = stmt.trim();
    if (t) await pg.exec(t);
  }
}

async function calendarIn(tz: string) {
  const [c] = await db.insert(schema.calendars).values({ ownerId: user.id, name: "Cal", color: "#000000", timezone: tz }).returning();
  return c!;
}

type Seed = Partial<typeof schema.events.$inferInsert> & { uid: string };
async function seed(calendarId: string, o: Seed) {
  const [row] = await db.insert(schema.events).values({
    calendarId,
    summary: o.uid,
    // 墨尔本 2026-09-28 周一 09:30 AEST
    startsAt: new Date("2026-09-27T23:30:00.000Z"),
    endsAt: new Date("2026-09-28T00:30:00.000Z"),
    rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=12",
    updatedAt: new Date("2026-01-02T03:04:05.000Z"),
    ...o,
  }).returning();
  return row!;
}

async function rowOf(id: string) {
  const [r] = await db.select().from(schema.events).where(eq(schema.events.id, id)).limit(1);
  return r!;
}

function legacyNth(startsAt: Date, rrule: string, k: number): string {
  return listSeriesStartsLegacyUtc({ startsAt, rrule }, { minCount: k + 1, cap: 1000 })!.starts[k]!.toISOString();
}

function melDay(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: MEL, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

async function visibleDays(eventId: string): Promise<string[]> {
  const res = await api.inject({
    method: "GET",
    url: `/api/v1/events?from=${encodeURIComponent("2026-09-01T00:00:00Z")}&to=${encodeURIComponent("2027-01-31T00:00:00Z")}`,
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { events: { id: string; startsAt: string }[] }).events
    .filter((e) => e.id === eventId).map((e) => melDay(e.startsAt));
}

async function doneMarker(): Promise<string> {
  const [r] = await db.select().from(schema.siteSettings).where(eq(schema.siteSettings.id, 1)).limit(1);
  return r!.dataMigrationsDone;
}

// ---------------------------------------------------------------------------
// 一、0058
// ---------------------------------------------------------------------------

describe("0058 哪些事件被 bump", () => {
  it("网页 / App 建的定时重复事件（没有 raw_ics）被 bump；常量之后编辑过的也 bump", async () => {
    const cal = await calendarIn(MEL);
    const a = await seed(cal.id, { uid: "a" });
    const b = await seed(cal.id, { uid: "b", updatedAt: new Date("2027-05-05T00:00:00Z") });
    const c = await seed(cal.id, { uid: "c", rawIcs: "X-NOTHING" });
    await runSqlMigration();
    for (const r of [a, b, c]) expect((await rowOf(r.id)).updatedAt.toISOString(), r.uid).toBe(STAMP);
  });

  it("全天的、不重复的、rrule 是空串的、有原文的、软删的：不动", async () => {
    const cal = await calendarIn(MEL);
    const rows = [
      await seed(cal.id, { uid: "allday", allDay: true }),
      await seed(cal.id, { uid: "single", rrule: null }),
      await seed(cal.id, { uid: "empty", rrule: "" }),
      await seed(cal.id, { uid: "raw", rawIcs: "BEGIN:VEVENT\r\nUID:raw\r\nEND:VEVENT" }),
      await seed(cal.id, { uid: "deleted", deletedAt: new Date("2026-02-01T00:00:00Z") }),
    ];
    await runSqlMigration();
    for (const r of rows) {
      expect((await rowOf(r.id)).updatedAt.toISOString(), `${r.uid} 被 bump 了 —— 每台手机白下一遍`).toBe("2026-01-02T03:04:05.000Z");
    }
  });

  it("跑两遍第二遍一行都不改", async () => {
    const cal = await calendarIn(MEL);
    await seed(cal.id, { uid: "x1" });
    await seed(cal.id, { uid: "x2", rrule: null });
    await runSqlMigration();
    const snap = async () => (await db.select().from(schema.events)).map((r) => `${r.uid}=${r.updatedAt.toISOString()}`).sort();
    const first = await snap();
    await runSqlMigration();
    expect(await snap()).toEqual(first);
  });

  it("纪元被 bump 成这一版的字面量，也盖掉后台手动 bump 的值", async () => {
    await updateSettings({ caldavSyncEpoch: "manual:2099-01-01T00:00:00.000Z:deadbeefcafe" });
    await runSqlMigration();
    const [r] = await db.select().from(schema.siteSettings).where(eq(schema.siteSettings.id, 1)).limit(1);
    expect(r!.caldavSyncEpoch).toBe(EPOCH);
  });

  it("常量没跑偏：迁移里写的就是测试断言的那个时刻和纪元", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const stamps = [...sql.matchAll(/TIMESTAMPTZ '([^']+)'/g)].map((m) => m[1]!);
    expect(stamps.length).toBe(2);
    expect(new Set(stamps).size).toBe(1);
    expect(new Date(stamps[0]!.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00")).toISOString()).toBe(STAMP);
    const epochs = [...sql.matchAll(/caldav_sync_epoch(?: IS DISTINCT FROM| =) '([^']+)'/g)].map((m) => m[1]!);
    expect(new Set(epochs)).toEqual(new Set([EPOCH]));
  });
});

// ---------------------------------------------------------------------------
// CalDAV 视角
// ---------------------------------------------------------------------------

async function buildDavApp() {
  const app = Fastify({ logger: false });
  app.addHttpMethod("PROPFIND", { hasBody: true });
  app.addHttpMethod("REPORT", { hasBody: true });
  app.addContentTypeParser(/^(application\/xml|text\/xml|text\/calendar)\b/i, { parseAs: "string" },
    (_req, body, done) => done(null, body as string));
  await app.register(caldavRoutes);
  await app.ready();
  return app;
}
type InjectLike = (opts: Record<string, unknown>) => Promise<{ statusCode: number; body: string }>;
function basic(): string {
  return "Basic " + Buffer.from(`${user.email}:${PASSWORD}`).toString("base64");
}
async function propfind(app: Awaited<ReturnType<typeof buildDavApp>>, calId: string): Promise<string> {
  const res = await (app.inject as unknown as InjectLike)({
    method: "PROPFIND", url: `/caldav/${user.id}/${calId}/`,
    headers: { authorization: basic(), depth: "1", "content-type": "application/xml" },
    payload: `<?xml version="1.0"?><propfind xmlns="DAV:"><prop><getetag/><getctag xmlns="http://calendarserver.org/ns/"/></prop></propfind>`,
  });
  expect(res.statusCode).toBe(207);
  return res.body;
}
const ctagOf = (xml: string) => xml.match(/<CS:getctag>([^<]*)<\/CS:getctag>/)![1]!;
function etagFor(xml: string, uid: string): string {
  const block = xml.split(/<\/?(?:D:)?response>/).find((b) => b.includes(uid))!;
  return block.match(/<getetag>([^<]*)<\/getetag>/)![1]!;
}

describe("0058 从 CalDAV 看", () => {
  it("日历里有更新的别的事件时 ctag 照样变；要修的那条 etag 变、原文回放的不变", async () => {
    const cal = await calendarIn(MEL);
    await seed(cal.id, { uid: "web-weekly" });
    await seed(cal.id, {
      uid: "phone-weekly",
      rawIcs: "BEGIN:VEVENT\r\nUID:phone-weekly\r\nSUMMARY:x\r\nDTSTART;TZID=Australia/Melbourne:20260928T093000\r\nDTEND;TZID=Australia/Melbourne:20260928T103000\r\nRRULE:FREQ=WEEKLY\r\nEND:VEVENT",
      updatedAt: new Date("2030-01-01T00:00:00Z"),
    });
    const dav = await buildDavApp();
    const before = await propfind(dav, cal.id);
    await runSqlMigration();
    reloadSettings();
    const after = await propfind(dav, cal.id);
    expect(ctagOf(after), "ctag 没变 —— 苹果日历不会来重新列").not.toBe(ctagOf(before));
    expect(etagFor(after, "web-weekly")).not.toBe(etagFor(before, "web-weekly"));
    expect(etagFor(after, "phone-weekly")).toBe(etagFor(before, "phone-weekly"));
    await dav.close();
  });
});

// ---------------------------------------------------------------------------
// 二、数据迁移：老的「删掉这一次」
// ---------------------------------------------------------------------------

describe("数据迁移把旧算法记下的 exdate 对到新算法的同一次", () => {
  const startsAt = new Date("2026-09-27T23:30:00.000Z");
  const rrule = "FREQ=WEEKLY;BYDAY=MO;COUNT=12";

  it("以前删掉的是第 3 次 → 迁移后列表里少的还是第 3 次（墨尔本 10-12 周一）；updated_at 刷新；记账写上", async () => {
    const cal = await calendarIn(MEL);
    const ev = await seed(cal.id, { uid: "w", exdates: [legacyNth(startsAt, rrule, 2)] });
    // 升级后、迁移前：被删的那次冒出来了（12 次一次不少）
    expect(await visibleDays(ev.id), "前提不成立：不迁移也看不出问题").toHaveLength(12);

    const r = await runDataMigrations(db, { log: quiet });
    expect(r.ran).toEqual([EXDATE_LOCAL_TIME_MIGRATION]);

    const days = await visibleDays(ev.id);
    expect(days).toHaveLength(11);
    expect(days.slice(0, 3)).toEqual(["2026-09-28", "2026-10-05", "2026-10-19"]);
    const row = await rowOf(ev.id);
    expect(row.exdates).toEqual(["2026-10-11T22:30:00.000Z"]);
    expect(row.updatedAt.getTime(), "updated_at 没刷新 —— 手机不会重新下载改过的 EXDATE").toBeGreaterThan(ev.updatedAt.getTime());
    expect((await doneMarker()).split(" ")).toContain(EXDATE_LOCAL_TIME_MIGRATION);
  });

  it("记账写上之后不再跑；强制重跑也一行不改（幂等）", async () => {
    const cal = await calendarIn(MEL);
    const ev = await seed(cal.id, { uid: "w", exdates: [legacyNth(startsAt, rrule, 2)] });
    await runDataMigrations(db, { log: quiet });
    const once = await rowOf(ev.id);

    // 记账之后又冒出一条旧写法的（比如有人手动改库）：正常开机不碰它
    const late = await seed(cal.id, { uid: "late", exdates: [legacyNth(startsAt, rrule, 1)] });
    expect((await runDataMigrations(db, { log: quiet })).ran, "记账没生效，每次开机都在重跑").toEqual([]);
    expect((await rowOf(late.id)).exdates).toEqual([legacyNth(startsAt, rrule, 1)]);

    // 强制重跑：已经迁移过的那条一字不改、updated_at 也不动；新冒出来那条被对齐
    expect((await runDataMigrations(db, { force: true, log: quiet })).ran).toEqual([EXDATE_LOCAL_TIME_MIGRATION]);
    const twice = await rowOf(ev.id);
    expect(twice.exdates).toEqual(once.exdates);
    expect(twice.updatedAt.toISOString(), "重跑把没变的事件 updated_at 也刷了 —— 手机白下一遍").toBe(once.updatedAt.toISOString());
    expect((await rowOf(late.id)).exdates).toEqual(["2026-10-04T22:30:00.000Z"]);
  });

  it("不该动的不动：已经是新写法的、全天的、软删的、手机按 UTC 写上来的、UTC 日历里的", async () => {
    const mel = await calendarIn(MEL);
    const utc = await calendarIn("UTC");
    const oldEx = legacyNth(startsAt, rrule, 2);
    const rows = [
      await seed(mel.id, { uid: "already", exdates: ["2026-10-11T22:30:00.000Z"] }),
      // 两种算法都算得出、序号不同（旧第 1 次 = 新第 2 次）：按「新算法算得出就不动」
      await seed(mel.id, { uid: "both", rrule: "FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR", exdates: ["2026-09-28T23:30:00.000Z"] }),
      await seed(mel.id, {
        uid: "allday", allDay: true, exdates: ["2026-10-12T00:00:00.000Z"],
        startsAt: new Date("2026-09-28T00:00:00Z"), endsAt: new Date("2026-09-28T23:59:59.999Z"),
      }),
      await seed(mel.id, { uid: "deleted", exdates: [oldEx], deletedAt: new Date("2026-10-20T00:00:00Z") }),
      await seed(mel.id, {
        uid: "phone-utc", exdates: [oldEx],
        rawIcs: "BEGIN:VEVENT\r\nUID:phone-utc\r\nDTSTART:20260927T233000Z\r\nDTEND:20260928T003000Z\r\nRRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=12\r\nEND:VEVENT",
      }),
      await seed(utc.id, { uid: "utc-cal", exdates: [oldEx] }),
    ];
    await runDataMigrations(db, { log: quiet });
    for (const r of rows) {
      const now = await rowOf(r.id);
      expect(now.exdates, `${r.uid} 的 exdates 被改了`).toEqual(r.exdates);
      expect(now.updatedAt.toISOString(), `${r.uid} 的 updated_at 被刷了`).toBe(r.updatedAt.toISOString());
    }
  });

  it("CalDAV 拿到的 EXDATE 是对齐后的那一次（墨尔本 10-12 09:30），etag 也变了", async () => {
    const cal = await calendarIn(MEL);
    const ev = await seed(cal.id, { uid: "weekly-legacy-exdate", exdates: [legacyNth(startsAt, rrule, 2)] });
    const dav = await buildDavApp();
    const before = await propfind(dav, cal.id);
    await runDataMigrations(db, { log: quiet });
    const after = await propfind(dav, cal.id);
    expect(etagFor(after, ev.uid), "etag 没变：手机不会重新下载改过的 EXDATE").not.toBe(etagFor(before, ev.uid));
    const res = await (dav.inject as unknown as InjectLike)({
      method: "GET", url: `/caldav/${user.id}/${cal.id}/${ev.uid}.ics`, headers: { authorization: basic() },
    });
    const ex = res.body.split("\r\n").filter((l) => l.startsWith("EXDATE"));
    expect(ex).toEqual(["EXDATE;TZID=Australia/Melbourne:20261012T093000"]);
    await dav.close();
  });

  it("恢复一份升级前导出的备份（里面没有记账）：恢复完就把老的 exdate 对齐", async () => {
    const cal = await calendarIn(MEL);
    const ev = await seed(cal.id, { uid: "w", exdates: [legacyNth(startsAt, rrule, 2)] });
    await runDataMigrations(db, { log: quiet });   // 这台机器自己已经迁移过、也记了账
    // 造一份「升级前导出」的备份：site_settings 里没有记账那一列，事件还是旧写法
    const bundle = JSON.parse(JSON.stringify(await exportData())) as { tables: Record<string, Record<string, unknown>[]> };
    for (const s of bundle.tables.site_settings!) delete s.dataMigrationsDone;
    for (const e of bundle.tables.events!) if (e.uid === "w") e.exdates = [legacyNth(startsAt, rrule, 2)];
    reloadSettings();
    await importData(bundle as never);
    expect((await rowOf(ev.id)).exdates, "恢复回来的老数据没被迁移：被删的那次又冒出来了").toEqual(["2026-10-11T22:30:00.000Z"]);
    expect((await doneMarker()).split(" ")).toContain(EXDATE_LOCAL_TIME_MIGRATION);
  });
});
