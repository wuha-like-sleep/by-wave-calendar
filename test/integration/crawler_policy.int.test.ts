// 哪些页面不许被搜索引擎收录 —— 按**真实注册的路由**去查。
//
// 名单原来有两份（响应头一份、robots.txt 一份），两份一起写错成 "/booking"，
// 而真实路径是 /book/… 和 /book-cancel/…。取消页的地址里带着令牌，谁拿到谁就能
// 取消那次预约 —— 被转发到公开的地方，就会被抓走、被搜到。
//
// 这里不拿名单自己查自己：把公开的路由真的注册出来，**凡是路径里带令牌 / 码的
// GET 页面**，都必须落在不收录的范围里。以后新加一个带令牌的页面忘了登记，这条会红。

import { vi, beforeAll, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
vi.mock("../../src/lib/mailer.js", () => ({
  sendMail: vi.fn(async () => ({ ok: true })), isMailerEnabled: vi.fn(async () => true),
}));

import Fastify from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import view from "@fastify/view";
import ejs from "ejs";
import path from "node:path";
import { ensureSchema, db, schema, makeUser, makeCalendar } from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";

const { isNoindexPath, robotsTxt, NOINDEX_PREFIXES } = await import("../../src/lib/crawler_policy.js");
const { webRoutes } = await import("../../src/web/index.js");
const { makeT } = await import("../../src/lib/i18n.js");
const { env } = await import("../../src/env.js");
const { jsonForScript } = await import("../../src/lib/script_json.js");

beforeAll(async () => { await ensureSchema(); });

/** 把一个带参数的路由路径填成一个具体地址。 */
const concrete = (p: string) => p.replace(/:[A-Za-z_]+/g, "x");

describe("不收录的范围", () => {
  it("公开的介绍页、下载页、法律页照常收录（presence —— 否则「全部不收录」也会绿）", () => {
    for (const p of ["/", "/download", "/privacy", "/terms", "/about"]) {
      expect(isNoindexPath(p), `${p} 被挡在搜索引擎外面了`).toBe(false);
    }
  });

  it("**预约页和取消预约页不收录**", () => {
    expect(isNoindexPath("/book/2f3c/chat"), "公开预约页被收录").toBe(true);
    expect(isNoindexPath("/book-cancel/abcdef123"), "取消预约页被收录 —— 它的地址里带着能取消预约的令牌").toBe(true);
  });

  it("robots.txt 和响应头是同一份名单", () => {
    const txt = robotsTxt();
    for (const p of NOINDEX_PREFIXES) expect(txt, `robots.txt 里没有 ${p}`).toContain(`Disallow: ${p}`);
  });

  it("**凡是地址里带令牌 / 码的页面都不收录**（按真实注册的路由查）", async () => {
    const app = Fastify({ logger: false });
    const routes: string[] = [];
    app.addHook("onRoute", (r) => {
      const methods = Array.isArray(r.method) ? r.method : [r.method];
      if (methods.includes("GET")) routes.push(r.url);
    });
    await app.register(cookie, { secret: env.SESSION_SECRET });
    await app.register(formbody);
    await app.register(webRoutes);
    await app.ready();
    await app.close();

    const tokenized = routes.filter((u) => /:(token|code|key|secret)\b/i.test(u));
    expect(tokenized.length, "一个带令牌的页面都没扫到 —— 判据瞎了").toBeGreaterThan(2);
    const leaking = tokenized.filter((u) => !isNoindexPath(concrete(u)));
    expect(
      leaking,
      "这些页面的地址里带着令牌，却会被搜索引擎收录 —— 地址一旦被转发到公开的地方，" +
        "就会被抓走、被搜到，拿到的人能直接用它。加到 lib/crawler_policy.ts 的名单里。",
    ).toEqual([]);
  });
});

describe("公开预约页不公开店主的邮箱", () => {
  it("**店主没设昵称时，页面上不出现他的邮箱**", async () => {
    const owner = await makeUser("owner-private@example.com");
    await db.update(schema.users).set({ displayName: null }).where((await import("drizzle-orm")).eq(schema.users.id, owner.id));
    const cal = await makeCalendar(owner.id);
    await db.insert(schema.bookingLinks).values({
      userId: owner.id, calendarId: cal.id, slug: "chat", title: "聊一聊", weeklyAvailability: {},
    });
    const app = Fastify({ logger: false });
    await app.register(cookie, { secret: env.SESSION_SECRET });
    await app.register(formbody);
    await app.register(view, {
      engine: { ejs }, root: path.resolve("src/views"), propertyName: "view", options: { async: false },
      defaultContext: {
        t: makeT("zh-CN"), siteName: "ByWave", siteLogoUrl: null, icpNumber: null, icpUrl: "",
        assetVersion: "t", jsBasePath: "/static/js", cspNonce: "n", currentLocale: "zh-CN",
        locales: [], siteLocaleOptions: [], currentUser: null, themePalette: "indigo",
        themeDensity: "comfortable", currentPath: "/book", jsonForScript,
      },
    });
    await app.register(webRoutes);
    await app.ready();
    const res = await app.inject({ method: "GET", url: `/book/${owner.id}/chat` });
    await app.close();
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    expect(res.body, "页面没渲染出预约标题 —— 这条用例什么也没验到").toContain("聊一聊");
    expect(
      res.body,
      "店主的邮箱被印在了公开页面上 —— 这张页面会被转发、被抓取，而他从没选过公开邮箱",
    ).not.toContain("owner-private@example.com");
  });
});
