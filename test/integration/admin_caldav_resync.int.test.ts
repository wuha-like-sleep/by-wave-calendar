// 后台「让所有设备重新同步日历」——**全部从 HTTP 打进去**。
//
// 为什么不直调 bumpCaldavSyncEpoch:那个函数本来就是对的(上一轮已经有断言)。
// 这一档要守的是**路由自己那几件事**:谁能按、要不要带令牌、有没有先经过确认页、
// 按完库里那一列是不是真的换了值。这四件事一件都不在那个函数里,直调它的测试
// 结构上就看不见 —— 这个仓库为「单元测试全绿而后台真实路径是坏的」付过账。
//
// 五条断言各守一种失效:
//   1. 非管理员能按        → 任何登录用户都能把全站设备叫醒一遍
//   2. 不带 CSRF 令牌能按  → 一张别的网页就能替管理员按下去
//   3. 绕过确认页能按      → 「一点就执行」,而且是他没看见那页说明的情况下
//   4. 按了纪元没变        → 提示说「已发出」,而设备永远不会回来(不报错、就是不响)
//   5. 连按两次值一样      → 正是「写 now() 会在同一秒内静默失效」那个坑
import { vi, beforeAll, beforeEach, afterEach, describe, it, expect } from "vitest";

// Point the production `db`/`schema` at the in-memory PGlite instance.
vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import view from "@fastify/view";
import ejs from "ejs";
import path from "node:path";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { ensureSchema, resetDb, db, schema, makeUser } from "./harness.js";
import { newSessionId } from "../../src/lib/ids.js";

// src/web/admin.ts 一路拉到 env.ts,而 env 解析不过是 process.exit(1) ——
// 整个 vitest 进程当场消失,连一条红都留不下。CI 上没有 .env,先兜底再动态 import。
process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const SESSION_SECRET = process.env.SESSION_SECRET;

const { adminRoutes } = await import("../../src/web/admin.js");
const { reloadSettings } = await import("../../src/lib/site_settings.js");

// 签名 cookie 用的密钥。测试内部自洽即可(签和验都在同一个实例上)。
const TEST_COOKIE_SECRET = "integration-test-cookie-secret-32-chars-min";
const SESSION_COOKIE_NAME = "bwc_sid";
const VIEWS = path.resolve("src/views");

beforeAll(async () => { await ensureSchema(); });

let app: FastifyInstance;

/**
 * 起一个挂着后台路由的真 Fastify。
 *
 * 比 harness.buildRoutedApp 多两样,都是这条路真的会用到的:
 *   · formbody —— 后台的表单是 application/x-www-form-urlencoded,少了它
 *     req.body 是 undefined,CSRF 那一关会因为「没拿到令牌」而拒,看着像过了,
 *     其实验的是另一件事。
 *   · view —— requireAdmin 拒绝非管理员时渲染的是 error 模板。没有它这条路
 *     会抛成 500,而 500 和 403 在「被拒」这件事上像,在「是不是我们主动拒的」
 *     上完全不像。
 * 模板需要的那几个全局在 defaultContext 里补齐(生产里由 server.ts 的
 * onRequest 钩子注入,那个钩子连着真库,这里复刻不了)。
 */
async function buildApp(): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  await instance.register(cookie, { secret: TEST_COOKIE_SECRET });
  await instance.register(formbody);
  await instance.register(view, {
    engine: { ejs },
    root: VIEWS,
    propertyName: "view",
    options: { async: false },
    defaultContext: {
      // 只放模板必须有的那几个;别的都由路由自己传。
      t: (key: string) => key,
      siteName: "ByWave Calendar",
      siteLogoUrl: null,
      icpNumber: null,
      icpUrl: "",
      assetVersion: "test",
      jsBasePath: "/static/js",
      cspNonce: "test-nonce",
      currentLocale: "zh-CN",
      locales: [],
      siteLocaleOptions: [],
      currentUser: null,
      themePalette: "indigo",
      themeDensity: "comfortable",
      currentPath: "/admin/caldav",
    },
  });
  await instance.register(adminRoutes);
  await instance.ready();
  return instance;
}

/** 造一个「已登录的浏览器」,顺手算出这个会话该有的 CSRF 令牌。 */
async function loginAs(userId: string): Promise<{ cookie: string; csrf: string }> {
  const sid = newSessionId();
  await db.insert(schema.sessions).values({
    id: sid,
    userId,
    mfaSatisfied: true,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  return {
    cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(app.signCookie(sid))}`,
    // 口径抄自 src/lib/csrf.ts 的 csrfTokenFor:HMAC(SESSION_SECRET, sid)。
    csrf: createHmac("sha256", SESSION_SECRET).update(sid).digest("hex"),
  };
}

/** 库里那一列现在是什么。页面怎么显示是另一回事,这里只认库。 */
async function epochInDb(): Promise<string> {
  const [row] = await db.select().from(schema.siteSettings).where(eq(schema.siteSettings.id, 1)).limit(1);
  return row?.caldavSyncEpoch ?? "";
}

function post(body: Record<string, string>, headers: Record<string, string>) {
  return app.inject({
    method: "POST",
    url: "/admin/caldav/resync",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    payload: new URLSearchParams(body).toString(),
  });
}

let admin: Awaited<ReturnType<typeof makeUser>>;
let adminAuth: { cookie: string; csrf: string };

beforeEach(async () => {
  await resetDb();
  // site_settings 被 TRUNCATE 了,但设置缓存是模块级的、活过了 reset ——
  // 不清它的话第二条用例读到的是第一条 bump 出来的纪元。
  reloadSettings();
  app = await buildApp();
  // 这一行必须有:site_settings 只有一行(id=1),路由里的 UPDATE 不会自己造它。
  await db.insert(schema.siteSettings).values({ id: 1 }).onConflictDoNothing();
  admin = await makeUser("admin@example.com", { isAdmin: true });
  adminAuth = await loginAs(admin.id);
});

afterEach(async () => { await app.close(); });

describe("POST /admin/caldav/resync", () => {
  it("管理员按一次,纪元真的换了值", async () => {
    const before = await epochInDb();
    // presence:起点是「从来没 bump 过」那个取值。不先钉住的话,下面那条
    // 「变了」在库里本来就有个随机值时也成立,等于什么都没验。
    expect(before, "起点不是空串,下面那条「变了」验不出东西").toBe("");

    const res = await post({ _csrf: adminAuth.csrf, confirm: "yes" }, { cookie: adminAuth.cookie });

    expect(res.statusCode, `按下去没跳回后台页,正文:${res.body.slice(0, 300)}`).toBe(302);
    expect(res.headers.location).toMatch(/^\/admin\/caldav\?success=/);
    const after = await epochInDb();
    expect(after, "按完库里那一列没变 —— 提示说「已发出」,而设备永远不会回来").not.toBe(before);
    expect(after).not.toBe("");
  });

  it("连按两次,两次写进去的值互不相同", async () => {
    // 这一条守的是「写 now() 会在同一秒内静默失效」:两次 bump 落在同一秒时,
    // 时间戳一模一样 = 第二次什么都没发生,而且不报错。
    await post({ _csrf: adminAuth.csrf, confirm: "yes" }, { cookie: adminAuth.cookie });
    const first = await epochInDb();
    await post({ _csrf: adminAuth.csrf, confirm: "yes" }, { cookie: adminAuth.cookie });
    const second = await epochInDb();

    expect(first, "第一次就没写进去,这条用例后面比的是两个空串").not.toBe("");
    expect(second, `连着按两次写进去的是同一个值(${first}) —— 第二次静默失效了`).not.toBe(first);
  });

  it("每按一次留一条审计,前后两个值都记下来", async () => {
    await post({ _csrf: adminAuth.csrf, confirm: "yes" }, { cookie: adminAuth.cookie });
    const rows = await db.select().from(schema.adminAuditLog);
    expect(rows.length, "按了一次却没留下审计行").toBe(1);
    const row = rows[0]!;
    expect(row.action).toBe("caldav.resync_all");
    expect(row.actorUserId).toBe(admin.id);
    // ip 那一列是 NOT NULL —— 真写成 null 的话 insert 会抛,而 audit() 把异常
    // 吞成一条 warn 日志,表现就是「审计里什么都没有」。上面那条数行数的断言
    // 已经能抓到,这里把值也钉死。
    expect(row.ip, "审计行没记住来源 IP").toBeTruthy();
    const details = row.details as { epochBefore: string; epochAfter: string; changed: boolean };
    expect(details.epochBefore).toBe("");
    expect(details.epochAfter).toBe(await epochInDb());
    expect(details.changed).toBe(true);
  });

  it("非管理员按不动 —— 而且库里那一列一个字都没变", async () => {
    const outsider = await makeUser("nobody@example.com");
    const auth = await loginAs(outsider.id);
    const before = await epochInDb();

    const res = await post({ _csrf: auth.csrf, confirm: "yes" }, { cookie: auth.cookie });

    expect(res.statusCode, `非管理员居然过了,正文:${res.body.slice(0, 300)}`).toBe(403);
    expect(await epochInDb(), "非管理员把全站设备叫醒了一遍").toBe(before);
  });

  it("没登录的直接被赶去登录页", async () => {
    const before = await epochInDb();
    const res = await post({ _csrf: "whatever", confirm: "yes" }, {});
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login");
    expect(await epochInDb()).toBe(before);
  });

  it("不带 CSRF 令牌的 POST 被拒", async () => {
    const before = await epochInDb();
    const res = await post({ confirm: "yes" }, { cookie: adminAuth.cookie });
    expect(res.statusCode, `没带令牌居然过了,正文:${res.body.slice(0, 300)}`).toBe(403);
    expect(await epochInDb(), "没带令牌也把纪元改了").toBe(before);
  });

  it("令牌是别人的会话那一个,同样被拒", async () => {
    const other = await makeUser("other-admin@example.com", { isAdmin: true });
    const otherAuth = await loginAs(other.id);
    const before = await epochInDb();
    const res = await post({ _csrf: otherAuth.csrf, confirm: "yes" }, { cookie: adminAuth.cookie });
    expect(res.statusCode).toBe(403);
    expect(await epochInDb()).toBe(before);
  });

  it("没经过确认页(缺 confirm 字段)不执行,而且回去时说得清为什么", async () => {
    const before = await epochInDb();
    const res = await post({ _csrf: adminAuth.csrf }, { cookie: adminAuth.cookie });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^\/admin\/caldav\?error=/);
    expect(await epochInDb(), "绕过确认页也执行了 —— 「一点就执行」").toBe(before);
  });
});

describe("GET /admin/caldav", () => {
  it("管理员打得开,并且给的是确认页的入口而不是直接提交", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/caldav", headers: { cookie: adminAuth.cookie } });
    expect(res.statusCode, `页面打不开,正文:${res.body.slice(0, 300)}`).toBe(200);
    expect(res.body).toContain('href="/admin/caldav/resync"');
  });

  it("按完之后,页面上的状态跟着变 —— 按了没生效时站长得能看出来", async () => {
    const before = await app.inject({ method: "GET", url: "/admin/caldav", headers: { cookie: adminAuth.cookie } });
    expect(before.body, "起点就显示成「手动触发过」,下面那条比不出东西").toContain("adminCaldav.state.never");

    await post({ _csrf: adminAuth.csrf, confirm: "yes" }, { cookie: adminAuth.cookie });

    const after = await app.inject({ method: "GET", url: "/admin/caldav", headers: { cookie: adminAuth.cookie } });
    expect(after.body).toContain("adminCaldav.state.manual");
    expect(after.body, "按完页面还显示「从来没触发过」").not.toContain("adminCaldav.state.never");
  });

  it("非管理员打不开", async () => {
    const outsider = await makeUser("guest@example.com");
    const auth = await loginAs(outsider.id);
    const res = await app.inject({ method: "GET", url: "/admin/caldav", headers: { cookie: auth.cookie } });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /admin/caldav/resync(确认页)", () => {
  it("把代价四条和多进程那条都摆出来了", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/caldav/resync", headers: { cookie: adminAuth.cookie } });
    expect(res.statusCode, `确认页打不开,正文:${res.body.slice(0, 300)}`).toBe(200);
    for (const key of [
      "adminCaldav.confirm.willHappen",
      "adminCaldav.confirm.wontHappen",
      "adminCaldav.confirm.cost",
      "adminCaldav.confirm.notInstant",
      "adminCaldav.confirm.multiProcess",
    ]) {
      expect(res.body, `确认页少了「${key}」`).toContain(key);
    }
  });

  it("光打开确认页什么都不会发生", async () => {
    const before = await epochInDb();
    await app.inject({ method: "GET", url: "/admin/caldav/resync", headers: { cookie: adminAuth.cookie } });
    expect(await epochInDb(), "只是看了一眼确认页,纪元就变了").toBe(before);
  });

  it("非管理员连确认页都看不到", async () => {
    const outsider = await makeUser("guest2@example.com");
    const auth = await loginAs(outsider.id);
    const res = await app.inject({ method: "GET", url: "/admin/caldav/resync", headers: { cookie: auth.cookie } });
    expect(res.statusCode).toBe(403);
  });
});
