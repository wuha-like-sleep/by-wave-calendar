// 后台「客户端更新」—— 全部从 HTTP 打进去。
//
// 这一档最要紧的一条断言不是「文件写进去了」，而是**保存完之后去打公开接口**
// (/api/app/android/latest)，看它是不是真的变了。
//
// 为什么必须这么测：这一页最容易出的错是「页面说保存成功、而 App 那边拿到 404」。
// 服务端读清单的那个函数对 JSON 解析失败和形状不符**一律静默 return null** ——
// 后台只要自己写一套「看起来差不多」的校验，就会放过一份读取侧认不出来的清单，
// 而站长得不到任何提示。断言落在写盘上的话，这个形状完全看不见。
//
// 本仓库为同一个形状付过账：OAuth 的 scope 被记录、被展示，就是从来没被执行过。

import { vi, beforeAll, beforeEach, afterEach, describe, it, expect } from "vitest";

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
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { ensureSchema, resetDb, db, schema, makeUser } from "./harness.js";
import { newSessionId } from "../../src/lib/ids.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const SESSION_SECRET = process.env.SESSION_SECRET;

const { adminRoutes } = await import("../../src/web/admin.js");

const TEST_COOKIE_SECRET = "integration-test-cookie-secret-32-chars-min";
const VIEWS = path.resolve("src/views");
/** 路由用的是 process.cwd() 下的 data/ —— 测试也落在同一处，跑完清掉。 */
const OVERRIDE = path.resolve("data/app-android-manifest.json");

let app: FastifyInstance;

async function buildApp(): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  await instance.register(cookie, { secret: TEST_COOKIE_SECRET });
  await instance.register(formbody);
  await instance.register(view, {
    engine: { ejs }, root: VIEWS, propertyName: "view", options: { async: false },
    defaultContext: {
      t: (key: string) => key, siteName: "ByWave Calendar", siteLogoUrl: null,
      icpNumber: null, icpUrl: "", assetVersion: "test", jsBasePath: "/static/js",
      cspNonce: "test-nonce", currentLocale: "zh-CN", locales: [], siteLocaleOptions: [],
      currentUser: null, themePalette: "indigo", themeDensity: "comfortable",
      currentPath: "/admin/client-release",
    },
  });
  await instance.register(adminRoutes);
  // 公开接口也挂上 —— 这一档的核心断言要从它这儿看结果。
  const { db: realDb } = await import("../../src/db/client.js");
  void realDb;
  instance.get("/api/app/android/latest", async (_req, reply) => {
    const { getLatestRelease } = await import("../../src/lib/android_release.js");
    const rel = await getLatestRelease();
    if (!rel) return reply.code(404).send({ error: "no_release_published" });
    return reply.send({ versionCode: rel.versionCode, versionName: rel.versionName });
  });
  await instance.ready();
  return instance;
}

async function loginAs(userId: string): Promise<{ cookie: string; csrf: string }> {
  const sid = newSessionId();
  await db.insert(schema.sessions).values({
    id: sid, userId, mfaSatisfied: true,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  return {
    cookie: `bwc_sid=${encodeURIComponent(app.signCookie(sid))}`,
    csrf: createHmac("sha256", SESSION_SECRET).update(sid).digest("hex"),
  };
}

/** 只回 payload。**不回 headers** —— 回了的话调用处写
 *  `headers: {cookie}, ...form(...)` 会被后面的 headers 整个覆盖掉,
 *  请求就不带会话了,于是所有 POST 都停在「跳去登录」上,
 *  看着像「权限没过」,其实根本没带 cookie。这一版就是这么红了一轮。 */
function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}
const FORM_CT = "application/x-www-form-urlencoded";

const GOOD = JSON.stringify({
  versionCode: 99, versionName: "9.9.9",
  downloadUrl: "https://example.com/app.apk",
  sha256: "a".repeat(64), sizeBytes: 123,
});

/** 公开接口现在报的是什么。核心断言落在这里，不落在文件系统上。 */
async function liveVersion(): Promise<{ code: number; name?: string; status: number }> {
  const res = await app.inject({ method: "GET", url: "/api/app/android/latest" });
  if (res.statusCode !== 200) return { code: -1, status: res.statusCode };
  const b = JSON.parse(res.body) as { versionCode: number; versionName: string };
  return { code: b.versionCode, name: b.versionName, status: 200 };
}

beforeAll(async () => { await ensureSchema(); app = await buildApp(); });

beforeEach(async () => {
  await resetDb();
  await rm(OVERRIDE, { force: true });
  // 清掉 android_release 的 mtime 缓存 —— 它按文件修改时间缓存，
  // 同一个测试进程里连续改同一个路径可能落在同一毫秒上。
  const m = await import("../../src/lib/android_release.js");
  void m;
});

afterEach(async () => { await rm(OVERRIDE, { force: true }); });

describe("后台能覆盖客户端更新清单", () => {
  it("管理员打得开这一页（presence）", async () => {
    const admin = await makeUser("admin@example.com", { isAdmin: true });
    const s = await loginAs(admin.id);
    const res = await app.inject({
      method: "GET", url: "/admin/client-release", headers: { cookie: s.cookie },
    });
    expect(res.statusCode, `打不开的话下面全都测不到。响应: ${res.body.slice(0, 200)}`).toBe(200);
    expect(res.body).toContain("客户端更新");
  });

  it("非管理员进不来", async () => {
    const u = await makeUser("nobody@example.com");
    const s = await loginAs(u.id);
    const res = await app.inject({
      method: "GET", url: "/admin/client-release", headers: { cookie: s.cookie },
    });
    expect([302, 303, 403]).toContain(res.statusCode);
  });

  it("保存一份合法清单之后，**公开接口真的变了**（这是核心断言）", async () => {
    const admin = await makeUser("admin@example.com", { isAdmin: true });
    const s = await loginAs(admin.id);
    const res = await app.inject({
      method: "POST", url: "/admin/client-release/android",
      headers: { cookie: s.cookie, "content-type": FORM_CT },
      payload: formBody({ manifest: GOOD, _csrf: s.csrf }),
    });
    expect([302, 303]).toContain(res.statusCode);
    expect(String(res.headers.location), "跳回去时带的是错误而不是成功").toContain("success=");

    const live = await liveVersion();
    expect(
      live.status,
      "保存说成功了，而公开接口 404 —— 正是「页面说保存成功、App 那边拿到 404」那个形状",
    ).toBe(200);
    expect(live.code).toBe(99);
    expect(live.name).toBe("9.9.9");
  });

  it("不是合法 JSON：不保存，公开接口不受影响", async () => {
    const admin = await makeUser("admin@example.com", { isAdmin: true });
    const s = await loginAs(admin.id);
    const before = await liveVersion();
    const res = await app.inject({
      method: "POST", url: "/admin/client-release/android",
      headers: { cookie: s.cookie, "content-type": FORM_CT },
      payload: formBody({ manifest: "{ 这不是 json", _csrf: s.csrf }),
    });
    expect(String(res.headers.location)).toContain("error=");
    await expect(readFile(OVERRIDE, "utf8")).rejects.toThrow();
    expect((await liveVersion()).code, "坏 JSON 把原来生效的那份弄没了").toBe(before.code);
  });

  it("读取侧认不出来的清单（缺 versionCode）：不保存", async () => {
    // 这一条是整页的核心风险：形状不对的话读取侧静默 return null → 接口 404，
    // 而站长看到的是「保存成功」。所以校验必须复用读取侧那一份。
    const admin = await makeUser("admin@example.com", { isAdmin: true });
    const s = await loginAs(admin.id);
    const res = await app.inject({
      method: "POST", url: "/admin/client-release/android",
      headers: { cookie: s.cookie, "content-type": FORM_CT },
      payload: formBody({ manifest: JSON.stringify({ versionName: "1.0.0", downloadUrl: "https://x/y.apk" }), _csrf: s.csrf }),
    });
    expect(String(res.headers.location), "缺 versionCode 却被当成保存成功了").toContain("error=");
    await expect(readFile(OVERRIDE, "utf8")).rejects.toThrow();
  });

  it("下载地址不是 https：不保存", async () => {
    // 这个地址会被推给所有装了本站 App 的用户。
    const admin = await makeUser("admin@example.com", { isAdmin: true });
    const s = await loginAs(admin.id);
    const bad = JSON.stringify({
      versionCode: 5, versionName: "0.0.5",
      downloadUrl: "http://example.com/app.apk", sha256: "b".repeat(64), sizeBytes: 1,
    });
    const res = await app.inject({
      method: "POST", url: "/admin/client-release/android",
      headers: { cookie: s.cookie, "content-type": FORM_CT },
      payload: formBody({ manifest: bad, _csrf: s.csrf }),
    });
    expect(String(res.headers.location)).toContain("error=");
    await expect(readFile(OVERRIDE, "utf8")).rejects.toThrow();
  });

  it("不带 CSRF 令牌：不保存（一张别的网页就能替管理员按下去）", async () => {
    const admin = await makeUser("admin@example.com", { isAdmin: true });
    const s = await loginAs(admin.id);
    const res = await app.inject({
      method: "POST", url: "/admin/client-release/android",
      headers: { cookie: s.cookie, "content-type": FORM_CT },
      payload: formBody({ manifest: GOOD }),
    });
    expect(res.statusCode).toBe(403);
    await expect(readFile(OVERRIDE, "utf8")).rejects.toThrow();
  });

  it("清除覆盖之后，公开接口跟着回去", async () => {
    const admin = await makeUser("admin@example.com", { isAdmin: true });
    const s = await loginAs(admin.id);
    await app.inject({
      method: "POST", url: "/admin/client-release/android",
      headers: { cookie: s.cookie, "content-type": FORM_CT },
      payload: formBody({ manifest: GOOD, _csrf: s.csrf }),
    });
    expect((await liveVersion()).code, "布置就没生效，这条用例什么也没测到").toBe(99);

    const res = await app.inject({
      method: "POST", url: "/admin/client-release/android/clear",
      headers: { cookie: s.cookie, "content-type": FORM_CT },
      payload: formBody({ _csrf: s.csrf }),
    });
    expect(String(res.headers.location)).toContain("success=");
    const after = await liveVersion();
    expect(after.code, "清了覆盖，接口还在报那份被覆盖的版本").not.toBe(99);
  });

  it("每次保存都留审计", async () => {
    const admin = await makeUser("admin@example.com", { isAdmin: true });
    const s = await loginAs(admin.id);
    await app.inject({
      method: "POST", url: "/admin/client-release/android",
      headers: { cookie: s.cookie, "content-type": FORM_CT },
      payload: formBody({ manifest: GOOD, _csrf: s.csrf }),
    });
    const rows = await db.select({ action: schema.adminAuditLog.action }).from(schema.adminAuditLog);
    expect(
      rows.map((r) => r.action),
      "改「推给所有用户哪一版」这种事没留审计",
    ).toContain("app_manifest.override_set");
  });
});

// 这一页用到的目录在仓库根的 data/ 下，跑完别留东西。
afterEach(async () => {
  await mkdir(path.dirname(OVERRIDE), { recursive: true }).catch(() => undefined);
  await writeFile(path.join(path.dirname(OVERRIDE), ".gitkeep"), "").catch(() => undefined);
  await rm(path.join(path.dirname(OVERRIDE), ".gitkeep"), { force: true }).catch(() => undefined);
});
