// 后台用户管理页 —— 从 HTTP 打进去。
//
// ── 这一页原来的三个问题 ──────────────────────────────────────────────
//
// ① 不分页。一次把全部用户查出来、一次渲染完。用户上万之后这一页越来越慢，
//    最后变成打不开 —— 而站长第一次发现，是在他最需要用它的时候。
// ② 「最近登录方式」取的是这些人里最新的 500 条登录事件，谁先出现算谁的。
//    几个活跃用户就能把 500 条占满，剩下所有人这一栏是空的。空白看起来像
//    「这个人从没登录过」，而其实只是被挤出了那个窗口。
// ③ 每一行都无条件挂「密码」徽章。而 SSO / Apple 建的号拿的是一串随机不可用的
//    哈希，根本没法用密码登录。站长照着看会以为「关掉 SSO 这些人还有退路」。
//
// 判据都必须落在**响应体**上，不是 lib 函数的返回值：这一页错在渲染和取数的
// 接缝处，直调函数看不见。

import { vi, beforeAll, beforeEach, afterEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import view from "@fastify/view";
import ejs from "ejs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { ensureSchema, resetDb, db, schema, makeUser } from "./harness.js";
import { newSessionId } from "../../src/lib/ids.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";

const { adminRoutes } = await import("../../src/web/admin.js");
const { makeT } = await import("../../src/lib/i18n.js");

let app: FastifyInstance;
let cookieHeader: string;

async function buildApp(): Promise<FastifyInstance> {
  const a = Fastify({ logger: false });
  await a.register(cookie, { secret: "integration-test-cookie-secret-32-chars-min" });
  await a.register(formbody);
  await a.register(multipart, { limits: { fileSize: 2 * 1024 * 1024 } });
  await a.register(view, {
    engine: { ejs }, root: path.resolve("src/views"), propertyName: "view",
    options: { async: false },
    defaultContext: {
      // 用**真的** t()，不是 key 回显的桩：这一档要能发现「文案没走多语言」。
      t: makeT("zh-CN"),
      siteName: "ByWave", siteLogoUrl: null, icpNumber: null, icpUrl: "",
      assetVersion: "t", jsBasePath: "/static/js", cspNonce: "n",
      currentLocale: "zh-CN", locales: [], siteLocaleOptions: [], currentUser: null,
      themePalette: "indigo", themeDensity: "comfortable", currentPath: "/admin/users",
    },
  });
  await a.register(adminRoutes);
  await a.ready();
  return a;
}

async function loginAs(userId: string) {
  const sid = newSessionId();
  await db.insert(schema.sessions).values({
    id: sid, userId, mfaSatisfied: true, expiresAt: new Date(Date.now() + 86400_000),
  });
  return `bwc_sid=${encodeURIComponent(app.signCookie(sid))}`;
}

async function get(url: string) {
  const res = await app.inject({ method: "GET", url, headers: { cookie: cookieHeader } });
  expect(res.statusCode, `${url} 回的是 ${res.statusCode}：${res.body.slice(0, 300)}`).toBe(200);
  return res.body;
}

/** 表格里出现了几行用户（靠来源那一格数，页面别处也有同样的文字）。 */
const rowCount = (html: string) => [...html.matchAll(/data-source-cell/g)].length;

beforeAll(async () => { await ensureSchema(); app = await buildApp(); });
afterEach(async () => { /* 实例复用 */ });

beforeEach(async () => {
  await resetDb();
  const admin = await makeUser("admin@example.com", { isAdmin: true });
  cookieHeader = await loginAs(admin.id);
});

describe("分页", () => {
  it("一页装得下时不出翻页条（presence）", async () => {
    const html = await get("/admin/users");
    expect(rowCount(html), "连管理员自己那一行都没渲染出来 —— 这组用例什么也测不到").toBe(1);
    expect(html).not.toContain('rel="next"');
  });

  it("**人多了会分页，不是一次全渲染出来**（这条是核心）", async () => {
    for (let i = 0; i < 70; i++) await makeUser(`u${String(i).padStart(3, "0")}@example.com`);
    const html = await get("/admin/users");
    expect(
      rowCount(html),
      "一次把全部用户渲染出来了 —— 用户上万之后这一页会慢到打不开，" +
        "而站长第一次发现是在他最需要用它的时候",
    ).toBe(50);
    expect(html, "没有下一页的入口，后面的人永远看不到").toContain('rel="next"');
  });

  it("第二页是剩下的人，而且不重复", async () => {
    for (let i = 0; i < 70; i++) await makeUser(`u${String(i).padStart(3, "0")}@example.com`);
    const p2 = await get("/admin/users?page=2");
    expect(rowCount(p2)).toBe(21); // 70 + 管理员自己 = 71
    expect(p2).toContain('rel="prev"');
  });

  it("页码越界夹回最后一页，而不是给一张空表", async () => {
    for (let i = 0; i < 70; i++) await makeUser(`u${String(i).padStart(3, "0")}@example.com`);
    const html = await get("/admin/users?page=999");
    expect(
      rowCount(html),
      "越界直接给空表，站长读到的意思是「这个条件下没有人」——一条不报错的假消息",
    ).toBeGreaterThan(0);
  });

  it("翻页会把筛选条件原样带上", async () => {
    for (let i = 0; i < 70; i++) await makeUser(`u${String(i).padStart(3, "0")}@example.com`);
    const html = await get("/admin/users?status=active");
    const next = /href="\/admin\/users([^"]*)"[^>]*rel="next"/.exec(html)?.[1] ?? "";
    expect(
      next,
      "翻页链接没带上筛选条件 —— 翻到第二页筛选就没了，站长看到的是「怎么突然多出一堆人」",
    ).toContain("status=active");
  });
});

describe("筛选", () => {
  beforeEach(async () => {
    await makeUser("normal@example.com");
    await makeUser("off@example.com", { disabledAt: new Date() });
    const u = await makeUser("unverified@example.com");
    await db.update(schema.users).set({ emailVerified: false }).where(eq(schema.users.id, u.id));
    const l = await makeUser("locked@example.com");
    await db.update(schema.users).set({ lockedUntil: new Date(Date.now() + 3600_000) }).where(eq(schema.users.id, l.id));
  });

  it("只看管理员", async () => {
    const html = await get("/admin/users?role=admin");
    expect(html).toContain("admin@example.com");
    expect(html, "筛管理员却把普通用户也列出来了").not.toContain("normal@example.com");
  });

  it("只看已停用", async () => {
    const html = await get("/admin/users?status=disabled");
    expect(html).toContain("off@example.com");
    expect(html).not.toContain("normal@example.com");
  });

  it("只看邮箱未验证", async () => {
    const html = await get("/admin/users?status=unverified");
    expect(html).toContain("unverified@example.com");
    expect(html).not.toContain("normal@example.com");
  });

  it("只看被锁定 —— 而且锁已经过期的不算", async () => {
    const stale = await makeUser("stale-lock@example.com");
    await db.update(schema.users).set({ lockedUntil: new Date(Date.now() - 3600_000) })
      .where(eq(schema.users.id, stale.id));
    const html = await get("/admin/users?status=locked");
    expect(html).toContain("locked@example.com");
    expect(
      html,
      "锁早就过期了还算在「被锁定」里 —— 这一栏会一直挂着几个其实能正常登录的人",
    ).not.toContain("stale-lock@example.com");
  });

  it("乱传的筛选值当成没筛，不是 500 也不是空表", async () => {
    const html = await get("/admin/users?status=../../etc/passwd&role=%27&sortdir=drop:table");
    expect(rowCount(html), "乱传参数把整页弄空了").toBeGreaterThan(0);
  });
});

describe("排序", () => {
  it("按邮箱正序时第一行是字母最小的那个", async () => {
    await makeUser("zzz@example.com");
    await makeUser("aaa@example.com");
    const html = await get("/admin/users?sortdir=email:asc");
    expect(html.indexOf("aaa@example.com")).toBeLessThan(html.indexOf("zzz@example.com"));
  });
  it("反过来也对（只测一个方向等于没测）", async () => {
    await makeUser("zzz@example.com");
    await makeUser("aaa@example.com");
    const html = await get("/admin/users?sortdir=email:desc");
    expect(html.indexOf("zzz@example.com")).toBeLessThan(html.indexOf("aaa@example.com"));
  });
});

describe("页面上写的是不是真的", () => {
  it("**SSO 建的号不显示「密码」**", async () => {
    const [sso] = await db.insert(schema.users).values({
      email: "sso@example.com", emailVerified: true, passwordHash: "random-unusable",
      passwordSet: false, signupSource: "sso:keycloak", ssoProviderSlug: "keycloak",
    }).returning();
    expect(sso).toBeTruthy();
    const html = await get("/admin/users?q=sso@example.com");
    expect(rowCount(html), "没搜到这一行").toBe(1);
    expect(
      html,
      "给一个根本没法用密码登录的账号挂了「密码」徽章 —— " +
        "站长照着看会以为关掉 SSO 之后这些人还有退路，其实没有",
    ).toContain("未设密码");
  });

  it("自己设过密码的仍然显示「密码」（别把对的也改坏了）", async () => {
    await makeUser("pw@example.com");
    const html = await get("/admin/users?q=pw@example.com");
    expect(rowCount(html)).toBe(1);
    expect(html).not.toContain("未设密码");
  });

  it("**每个人的「最近登录方式」是他自己的**，不会被活跃用户挤掉", async () => {
    // 造一个活跃用户刷满窗口，再看安静的那个还认不认得出来。
    const busy = await makeUser("busy@example.com");
    const quiet = await makeUser("quiet@example.com");
    const rows: (typeof schema.loginEvents.$inferInsert)[] = [];
    for (let i = 0; i < 600; i++) {
      rows.push({ userId: busy.id, method: "password", ip: "10.0.0.1", userAgent: "probe",
        createdAt: new Date(Date.now() - i * 1000) });
    }
    // 安静的那个只有一条，而且时间更早 —— 原来的写法会把它挤出 500 条窗口。
    rows.push({ userId: quiet.id, method: "passkey", ip: "10.0.0.2", userAgent: "probe",
      createdAt: new Date(Date.now() - 10 * 24 * 3600_000) });
    for (let i = 0; i < rows.length; i += 200) await db.insert(schema.loginEvents).values(rows.slice(i, i + 200));

    // **不能加 ?q= 筛出这一个人。** 第一版就是这么写的，结果 A/B 当场证明它是空的：
    // 筛掉别人之后，取数窗口里只剩他自己的事件，旧实现照样能答对。
    // 必须让活跃用户和他**同在一页**，才是真实场景。
    const html = await get("/admin/users");
    const row = /<tr>(?:(?!<\/tr>)[\s\S])*quiet@example\.com(?:(?!<\/tr>)[\s\S])*<\/tr>/.exec(html)?.[0];
    expect(row, "没找到这个人那一行 —— 这条用例什么也没测到").toBeTruthy();
    expect(
      row,
      "这个人的最近登录方式是空的 —— 被同一页上的活跃用户挤出了取数窗口。" +
        "空白看起来像「他从没登录过」，而站长会据此做判断",
    ).toContain("passkey");
  });

  it("顶部统计是全量，不跟着筛选走", async () => {
    for (let i = 0; i < 5; i++) await makeUser(`n${i}@example.com`);
    const all = await get("/admin/users");
    const filteredHtml = await get("/admin/users?role=admin");
    // 「共 6 个用户」这句在两边都该一样（5 + 管理员自己）。
    const totalOf = (h: string) => /共\s*(\d+)\s*个用户/.exec(h)?.[1];
    expect(totalOf(all), "统计数字没渲染出来").toBeTruthy();
    expect(
      totalOf(filteredHtml),
      "顶部统计跟着筛选变了 —— 站长会以为筛选把人弄丢了",
    ).toBe(totalOf(all));
  });

  it("页面上不该出现未翻译的 key", async () => {
    const html = await get("/admin/users");
    const leaked = [...html.matchAll(/adminUsers\.[a-zA-Z.]+/g)].map((m) => m[0]);
    expect(leaked, `这些文案没有对应的翻译，页面上直接显示成了 key：${leaked.join(", ")}`).toEqual([]);
  });
});

describe("单个用户的详情页", () => {
  it("打得开，而且列表能点进来（presence）", async () => {
    const u = await makeUser("detail@example.com");
    const list = await get("/admin/users?q=detail@example.com");
    expect(list, "列表里没有指向详情页的链接，这一页等于不存在").toContain(`/admin/users/${u.id}`);
    const html = await get(`/admin/users/${u.id}`);
    expect(html).toContain("detail@example.com");
  });

  it("把这个号占的东西摆出来 —— 0 也要显示，整行不许消失", async () => {
    const u = await makeUser("owner2@example.com");
    const [cal] = await db.insert(schema.calendars).values({
      ownerId: u.id, name: "工作", color: "#6366f1", timezone: "Asia/Shanghai",
    }).returning();
    await db.insert(schema.events).values({
      calendarId: cal!.id, uid: "x@example.com", summary: "会",
      startsAt: new Date(), endsAt: new Date(Date.now() + 3600_000),
    });
    const html = await get(`/admin/users/${u.id}`);
    expect(html, "日历名没显示出来").toContain("工作");
    // 没有的那些也要有行 —— 少一行，读的人分不清是「没有」还是「这一版没做」。
    for (const k of ["预约链接", "应用密码", "API Token", "第三方授权"]) {
      expect(html, `「${k}」那一行整个没了`).toContain(k);
    }
  });

  it("「能不能登进来」那一块反映真实情况", async () => {
    const [sso] = await db.insert(schema.users).values({
      email: "ssod@example.com", emailVerified: true, passwordHash: "unusable",
      passwordSet: false, signupSource: "sso:keycloak",
      lockedUntil: new Date(Date.now() + 3600_000), failedLoginCount: 7,
    }).returning();
    const html = await get(`/admin/users/${sso!.id}`);
    expect(html, "没显示锁定状态 —— 而「登不进去」最常见的原因就是它").toContain("已锁定");
    expect(html, "连续输错次数没显示").toContain("7");
  });

  it("最近登录记录列得出来", async () => {
    const u = await makeUser("lg@example.com");
    await db.insert(schema.loginEvents).values({
      userId: u.id, method: "passkey", ip: "203.0.113.9", userAgent: "probe",
    });
    const html = await get(`/admin/users/${u.id}`);
    expect(html).toContain("passkey");
    expect(html).toContain("203.0.113.9");
  });

  it("不存在的 id 跳回列表并说明，而不是 500 或白页", async () => {
    for (const bad of ["not-a-uuid", "00000000-0000-0000-0000-000000000000"]) {
      const res = await app.inject({ method: "GET", url: `/admin/users/${bad}`, headers: { cookie: cookieHeader } });
      expect([302, 303], `${bad} 回的是 ${res.statusCode}`).toContain(res.statusCode);
      expect(decodeURIComponent(String(res.headers.location))).toMatch(/找不到/);
    }
  });

  it("非管理员进不来", async () => {
    const plain = await makeUser("plain@example.com");
    const c = await loginAs(plain.id);
    const res = await app.inject({ method: "GET", url: `/admin/users/${plain.id}`, headers: { cookie: c } });
    expect([302, 303, 403]).toContain(res.statusCode);
    expect(res.body).not.toContain("plain@example.com");
  });

  it("详情页上也不该出现未翻译的 key", async () => {
    const u = await makeUser("k@example.com");
    const html = await get(`/admin/users/${u.id}`);
    const leaked = [...html.matchAll(/adminUserDetail\.[a-zA-Z.]+/g)].map((m) => m[0]);
    expect(leaked, `这些文案没有翻译，页面上直接显示成了 key：${leaked.join(", ")}`).toEqual([]);
  });
});
