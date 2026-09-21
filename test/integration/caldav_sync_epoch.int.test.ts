// CalDAV 同步纪元：让「只改序列化口径、不动任何一行数据」的发版也能把客户端叫回来。
//
// 为什么非得从 HTTP 打进去：calendarCtags 不是导出的，而且这个 bug 的形态正是
// 「函数本身算得对，是它拿到的输入里少了一样东西」。直调 lib 函数看不见
// PROPFIND 到底把哪个字符串写进了 <CS:getctag>，而 <CS:getctag> 才是苹果日历
// 真正读的那个值。
//
// 四条断言分别守住四种失效：
//   1. bump 了 ctag 不变      → 发版说明让用户「同步一下」，同步了也没用
//   2. 没 bump ctag 却在变    → 客户端每轮都重新列一遍，无限重同步
//   3. 纪元窜进了单行 etag    → bump 一次全部事件被当成「内容变了」，全量重下
//   4. 两个日历 ctag 撞在一起 → 一个日历的变更会把另一个的缓存也顶掉（或反过来，
//                              互相遮住对方的变更）
import { vi, beforeAll, beforeEach, describe, it, expect } from "vitest";

// Point the production `db`/`schema` at the in-memory PGlite instance.
vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { ensureSchema, resetDb, pg, db, schema, makeCalendar } from "./harness.js";
import { hashPassword } from "../../src/lib/password.js";
import { invalidateCalDavAuthCache } from "../../src/lib/caldav_auth.js";
import { caldavRoutes } from "../../src/web/caldav.js";
import { bumpCaldavSyncEpoch, reloadSettings, updateSettings } from "../../src/lib/site_settings.js";

beforeAll(async () => { await ensureSchema(); });
beforeEach(async () => {
  await resetDb();
  invalidateCalDavAuthCache();
  // site_settings 被 TRUNCATE 了，但设置缓存是模块级的、活过了 reset。
  // 不清它的话第二个用例读到的是第一个用例 bump 出来的纪元。
  reloadSettings();
});

const PASSWORD = "caldav-epoch-test-pw-123456";

async function makeAuthedUser(email: string) {
  const [u] = await db
    .insert(schema.users)
    .values({ email, emailVerified: true, passwordHash: await hashPassword(PASSWORD) })
    .returning();
  return u!;
}

async function buildApp() {
  const app = Fastify({ logger: false });
  // 生产里这三行在 server.ts：Fastify 默认不认这两个方法，caldavRoutes 注册时会直接抛。
  app.addHttpMethod("PROPFIND", { hasBody: true });
  app.addHttpMethod("REPORT", { hasBody: true });
  // 和 server.ts:114 那条同一个正则 —— PROPFIND 的 body 必须原样是字符串，
  // 少了它 Fastify 直接回 415，路由一次都没跑到。
  app.addContentTypeParser(
    /^(application\/xml|text\/xml|text\/calendar)\b/i,
    { parseAs: "string" },
    (_req, body, done) => done(null, body as string),
  );
  await app.register(caldavRoutes);
  await app.ready();
  return app;
}

function authHeader(email: string): string {
  return "Basic " + Buffer.from(`${email}:${PASSWORD}`).toString("base64");
}

type App = Awaited<ReturnType<typeof buildApp>>;

// light-my-request 的 method 是标准 HTTP 方法的联合类型，里面没有 PROPFIND——
// 这个方法是 server.ts 用 addHttpMethod 在运行时加进去的，类型层面看不见。
// 所以这里把 inject 的入参和返回各绕一次类型。运行时一切正常（下面那条
// 「没返回 207」的断言就是它的看门狗：真绕错了会立刻红，不会静静地不测东西）。
type InjectLike = (opts: Record<string, unknown>) => Promise<{ statusCode: number; body: string }>;

async function propfind(app: App, user: { id: string; email: string }, calId: string, depth: "0" | "1") {
  const inject = app.inject as unknown as InjectLike;
  const res = await inject({
    method: "PROPFIND",
    url: `/caldav/${user.id}/${calId}/`,
    headers: { authorization: authHeader(user.email), depth, "content-type": "application/xml" },
    payload: `<?xml version="1.0"?><propfind xmlns="DAV:"><prop><getetag/><getctag xmlns="http://calendarserver.org/ns/"/></prop></propfind>`,
  });
  expect(res.statusCode, `PROPFIND 没返回 207，正文：${res.body.slice(0, 400)}`).toBe(207);
  return res.body;
}

/** 从 multistatus 里取集合的 ctag —— 客户端读的就是这个元素。 */
function ctagOf(xml: string): string {
  const m = xml.match(/<CS:getctag>([^<]*)<\/CS:getctag>/);
  expect(m, `响应里没有 <CS:getctag>，说明这条用例根本没验到东西：${xml.slice(0, 400)}`).not.toBeNull();
  return m![1]!;
}

/** Depth:1 响应里每个事件的 etag，按出现顺序。集合那条自己不带 getetag。 */
function etagsOf(xml: string): string[] {
  return Array.from(xml.matchAll(/<getetag>([^<]*)<\/getetag>/g)).map((m) => m[1]!);
}

async function seedEvent(calendarId: string, uid: string, updatedAt: Date) {
  const [e] = await db
    .insert(schema.events)
    .values({
      calendarId,
      uid,
      summary: uid,
      startsAt: new Date("2026-06-10T09:00:00Z"),
      endsAt: new Date("2026-06-10T10:00:00Z"),
      updatedAt,
    })
    .returning();
  return e!;
}

describe("CalDAV 同步纪元", () => {
  it("bump 一次纪元，同一个日历的 ctag 必须变 —— 这是苹果日历唯一会看的那个值", async () => {
    const app = await buildApp();
    const user = await makeAuthedUser("epoch-a@example.com");
    const cal = await makeCalendar(user.id, "日历");
    await seedEvent(cal.id, "evt-1", new Date("2026-09-25T00:00:00Z"));

    const before = ctagOf(await propfind(app, user, cal.id, "0"));
    await bumpCaldavSyncEpoch();
    const after = ctagOf(await propfind(app, user, cal.id, "0"));

    expect(after, `bump 了纪元但 ctag 一个字节都没变（${before}）—— 客户端不会回来重新列，发版说明里那句「同步一下就有了」是假的`).not.toBe(before);
  });

  it("纪元不变时，同一份数据的 ctag 必须稳定 —— 否则客户端每轮都重新列一遍", async () => {
    const app = await buildApp();
    const user = await makeAuthedUser("epoch-b@example.com");
    const cal = await makeCalendar(user.id, "日历");
    await seedEvent(cal.id, "evt-1", new Date("2026-09-25T00:00:00Z"));
    await updateSettings({ caldavSyncEpoch: "fixed-epoch-for-stability" });

    const first = ctagOf(await propfind(app, user, cal.id, "0"));
    const second = ctagOf(await propfind(app, user, cal.id, "0"));
    const third = ctagOf(await propfind(app, user, cal.id, "0"));

    expect([second, third], `同一份数据连着问三次 ctag 得到了不同的值（${first} / ${second} / ${third}）—— 客户端会无限重同步`).toEqual([first, first]);
  });

  it("单行 etag 不受纪元影响 —— 否则 bump 一次，全部事件都被当成「内容变了」重下一遍", async () => {
    const app = await buildApp();
    const user = await makeAuthedUser("epoch-c@example.com");
    const cal = await makeCalendar(user.id, "日历");
    await seedEvent(cal.id, "evt-1", new Date("2026-09-25T00:00:00Z"));
    await seedEvent(cal.id, "evt-2", new Date("2026-08-01T00:00:00Z"));

    const beforeXml = await propfind(app, user, cal.id, "1");
    const etagsBefore = etagsOf(beforeXml);
    // absence 断言的配套 presence：先证明这里真的有 etag 可看。
    // 没有这一条的话，「etag 没变」在响应里一个 etag 都没有时也是成立的。
    expect(etagsBefore.length, `Depth:1 响应里一个 <getetag> 都没有，下面那条「没变」什么都没验到：${beforeXml.slice(0, 400)}`).toBe(2);
    expect(new Set(etagsBefore).size, "两条事件的 etag 撞在一起了，「没变」同样验不出东西").toBe(2);

    const ctagBefore = ctagOf(beforeXml);
    await bumpCaldavSyncEpoch();
    const afterXml = await propfind(app, user, cal.id, "1");

    expect(etagsOf(afterXml), "bump 纪元把单行 etag 也带着变了 —— 客户端会把整个日历的正文重下一遍").toEqual(etagsBefore);
    // 同一个响应里 ctag 必须已经变了，否则上面那条「etag 没变」是因为压根没 bump 成功。
    expect(ctagOf(afterXml), "ctag 没变 —— 这条用例里 bump 根本没生效，「etag 没变」是假绿").not.toBe(ctagBefore);
  });

  it("同一个纪元下，两个日历的 ctag 仍然互不相同", async () => {
    const app = await buildApp();
    const user = await makeAuthedUser("epoch-d@example.com");
    const calA = await makeCalendar(user.id, "工作");
    const calB = await makeCalendar(user.id, "生活");
    // 故意让两个日历的 max(updated_at) 和活行数**完全一样** —— 数据不一样的话
    // ctag 本来就不同，这条用例连掺没掺日历 id 都分辨不出来，永远是绿的。
    await seedEvent(calA.id, "a-1", new Date("2026-09-25T00:00:00Z"));
    await seedEvent(calB.id, "b-1", new Date("2026-09-25T00:00:00Z"));
    await updateSettings({ caldavSyncEpoch: "shared-epoch" });

    const a = ctagOf(await propfind(app, user, calA.id, "0"));
    const b = ctagOf(await propfind(app, user, calB.id, "0"));

    expect(a, "掺了纪元之后两个日历的 ctag 变成同一个值 —— 一个日历的变更会顶掉另一个的缓存").not.toBe(b);
  });
});

// 0051 这条迁移本身。纯 SQL，没有一行 TypeScript 参与 —— 唯一能被测的东西
// 就是「把 .sql 喂给数据库之后，那一列变成了什么」。
const EPOCH_MIGRATION = "drizzle/migrations/0051_caldav_sync_epoch.sql";

/** 按仓库迁移器的方式跑一个迁移文件：按 statement-breakpoint 拆开逐条执行。 */
async function runMigration(file: string): Promise<void> {
  for (const stmt of readFileSync(file, "utf8").split("--> statement-breakpoint")) {
    const t = stmt.trim();
    if (t) await pg.exec(t);
  }
}

async function epochInDb(): Promise<string> {
  const [row] = await db.select().from(schema.siteSettings).where(eq(schema.siteSettings.id, 1)).limit(1);
  return row!.caldavSyncEpoch;
}

describe("0051 迁移", () => {
  beforeEach(async () => {
    // 迁移只 UPDATE，不 INSERT —— 得先有那一行。
    await db.insert(schema.siteSettings).values({ id: 1 }).onConflictDoNothing();
  });

  it("把还没 bump 过的库（空串）bump 掉", async () => {
    expect(await epochInDb(), "起点不是空串，下面那条「变了」验不出东西").toBe("");
    await runMigration(EPOCH_MIGRATION);
    const after = await epochInDb();
    expect(after, "跑完迁移纪元还是空串 —— 这一版的强制重拉根本没发生").not.toBe("");
  });

  it("重放一遍是真正的 no-op —— 否则每次开机全体客户端白列一轮", async () => {
    // auto_migrate.ts 每次开机都跑迁移器，而「记账和真实 schema 对不上、
    // 整条链重放」是这个仓库出过的事。写成 now() 或者 epoch || 'x' 的话，
    // 第二遍会再 bump 一次，而且没有任何人会发现。
    await runMigration(EPOCH_MIGRATION);
    const first = await epochInDb();
    await runMigration(EPOCH_MIGRATION);
    const second = await epochInDb();
    await runMigration(EPOCH_MIGRATION);
    const third = await epochInDb();
    expect([second, third], `重放改变了纪元（${first} → ${second} → ${third}）`).toEqual([first, first]);
  });

  it("盖掉后台手动 bump 留下的值 —— 发版的强制重拉不能被管理员按过按钮就吞掉", async () => {
    // 这一条是「为什么不用自增整数」的实证：整数 + `WHERE epoch < N` 的话，
    // 管理员按几次就能把值推过下一版的常量，那一版就静默地什么都不做。
    await updateSettings({ caldavSyncEpoch: "manual:2099-01-01T00:00:00.000Z:deadbeefcafe" });
    await runMigration(EPOCH_MIGRATION);
    expect(await epochInDb(), "迁移没盖掉手动 bump 的值 —— 这一版的重拉被吞了").toBe("2026-09-21-alarm-vevent");
  });
});
