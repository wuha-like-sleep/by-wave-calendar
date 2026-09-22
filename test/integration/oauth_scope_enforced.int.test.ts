// OAuth 的 scope 到底有没有被执行 —— 全程从 HTTP 打进去。
//
// 修之前的实情:scope 从头到尾只被「记录」和「展示」。授权页把 scope 列给
// 用户看、/oauth/userinfo 把 scope 回显给客户端,而全仓库**没有一个地方
// 拿它做过判断**。于是一个勾了「只读日历」的第三方:能建、能改、能删事件,
// 能删整本日历,还能走两条路把 token 换成完整账号控制权
// (POST /auth/web-session 换浏览器会话、POST /devices/desktop-pair-approve
// 换长期设备凭据)—— 而后者即使用户后来撤销了这个应用,设备凭据仍然活着。
//
// 也就是说「授权一个只读小工具」实际等于「把账号交出去,且不可收回」,
// 而用户点「允许」时唯一的知情依据就是页面上那句「✓ 查看你的日历和事件」。
//
// 隔壁 bwc_ API token 的只读判断一直是有的(session.ts 里就在几行之外),
// 而且那条判断自己也踩过一次坑:写成 preHandler → authVia 还没写进 request
// → 判断永远不成立 → 只读 token 能建能删,后台还显示着「只读」。
// 所以这一档不看源码,只看真实请求的结果。

import { vi, beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./security_harness.js");
  return { db: h.db, schema: h.schema };
});

vi.mock("../../src/lib/mailer.js", () => ({
  isMailerEnabled: async () => true,
  sendMail: async () => ({ ok: true }),
}));

import Fastify, { type FastifyInstance } from "fastify";
import { ensureSchema, resetDb, db, schema, pg, applySettings } from "./security_harness.js";

let app: FastifyInstance;
const REDIRECT = "https://third-party.example.com/cb";

async function buildApp(): Promise<FastifyInstance> {
  const [{ env }, cookie, formbody, { authRoutes }, { calendarRoutes }, { eventRoutes }, { deviceRoutes }] =
    await Promise.all([
      import("../../src/env.js"),
      import("@fastify/cookie"),
      import("@fastify/formbody"),
      import("../../src/routes/auth.js"),
      import("../../src/routes/calendars.js"),
      import("../../src/routes/events.js"),
      import("../../src/routes/devices.js"),
    ]);
  const a = Fastify({ logger: false });
  await a.register(cookie.default, { secret: env.SESSION_SECRET });
  await a.register(formbody.default);
  await a.register(authRoutes, { prefix: "/api/v1" });
  await a.register(calendarRoutes, { prefix: "/api/v1" });
  await a.register(eventRoutes, { prefix: "/api/v1" });
  await a.register(deviceRoutes, { prefix: "/api/v1" });
  await a.ready();
  return a;
}

/** 发一个带指定 scope 的真 token(走完整的授权码交换,不是直接往表里塞行)。 */
async function tokenWithScopes(scopes: string[]): Promise<{ token: string; userId: string }> {
  const { createOAuthClient, issueAuthorizationCode, exchangeCodeForToken } =
    await import("../../src/lib/oauth_server.js");
  const { hashPassword } = await import("../../src/lib/password.js");
  const [user] = await db.insert(schema.users).values({
    email: `holder-${scopes.join("-").replace(/[^a-z]/g, "")}@example.com`,
    passwordHash: await hashPassword("Correct-Horse-9"),
    emailVerified: true,
  }).returning({ id: schema.users.id });
  const client = await createOAuthClient({
    name: "第三方小工具", redirectUris: [REDIRECT], allowedScopes: scopes as never,
  });
  const code = await issueAuthorizationCode({
    clientId: client.id, userId: user!.id, redirectUri: REDIRECT, scopes, codeChallenge: null,
  });
  const res = await exchangeCodeForToken({
    code, clientId: client.clientId, clientSecret: client.clientSecret, redirectUri: REDIRECT,
  });
  if ("error" in res) throw new Error("布置失败: " + res.error);
  return { token: res.accessToken, userId: user!.id };
}

function bearer(t: string) { return { authorization: `Bearer ${t}` }; }

beforeAll(async () => {
  await ensureSchema();
  app = await buildApp();
});
afterAll(async () => { await app?.close(); await pg?.close(); });
beforeEach(async () => { await resetDb(); await applySettings({ apiEnabled: true }); });

describe("OAuth scope 必须被真正执行", () => {
  it("read:events 的 token 能读（presence —— 没有这条,下面全都可能是『本来就不通』）", async () => {
    const { token } = await tokenWithScopes(["read:events"]);
    const res = await app.inject({ method: "GET", url: "/api/v1/calendars", headers: bearer(token) });
    expect(res.statusCode, `只读 token 连读都不行,这一档什么也没测到。响应: ${res.body.slice(0, 200)}`).toBe(200);
  });

  it("read:events 的 token **不能**建事件", async () => {
    const { token } = await tokenWithScopes(["read:events"]);
    const res = await app.inject({
      method: "POST", url: "/api/v1/events", headers: bearer(token),
      payload: { calendarId: "00000000-0000-0000-0000-000000000000", title: "x", start: "2026-01-01T00:00:00Z", end: "2026-01-01T01:00:00Z" },
    });
    expect(res.statusCode, "勾了「只读日历」的第三方建出了事件").toBe(403);
    expect(res.body, "403 是别的原因给的,不是 scope").toContain("insufficient_scope");
  });

  it("read:events 的 token 打没声明 scope 的路由被拒（这条测的是默认拒绝,不是 scope 比对）", async () => {
    const { token } = await tokenWithScopes(["read:events"]);
    const res = await app.inject({
      method: "DELETE", url: "/api/v1/calendars/00000000-0000-0000-0000-000000000000",
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("insufficient_scope");
  });

  it("write:events 的 token 能写（证明闸门不是一刀切全拒）", async () => {
    const { token } = await tokenWithScopes(["read:events", "write:events"]);
    const res = await app.inject({
      method: "POST", url: "/api/v1/events", headers: bearer(token),
      payload: { calendarId: "00000000-0000-0000-0000-000000000000", title: "x", start: "2026-01-01T00:00:00Z", end: "2026-01-01T01:00:00Z" },
    });
    // 日历 id 是假的,所以八成是 400/404 —— 但**不能是 403 insufficient_scope**,
    // 那说明有 write:events 也被挡住了,闸门就成了一刀切。
    expect(res.body, `有 write:events 还被 scope 挡住了。状态码 ${res.statusCode}`).not.toContain("insufficient_scope");
  });

  it("任何 scope 都换不到浏览器会话（这条是「授权只读 = 交出账号」的那条路）", async () => {
    const { token } = await tokenWithScopes(["read:events", "write:events", "read:profile"]);
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/web-session", headers: bearer(token), payload: {} });
    expect(res.statusCode, "OAuth token 换到了完整浏览器会话").toBe(403);
    expect(res.body).toContain("insufficient_scope");
  });

  it("任何 scope 都换不到长期设备凭据（撤销授权也收不回的那条路）", async () => {
    const { token } = await tokenWithScopes(["read:events", "write:events", "read:profile"]);
    const res = await app.inject({
      method: "POST", url: "/api/v1/devices/desktop-pair-approve",
      headers: bearer(token), payload: { code: "123456" },
    });
    expect(res.statusCode, "OAuth token 换到了长期设备凭据").toBe(403);
    expect(res.body).toContain("insufficient_scope");
  });

  it("scope 比对是整串相等,不是子串（伪造 read:events.evil 进不来）", async () => {
    const { token } = await tokenWithScopes(["read:events.evil"]);
    const res = await app.inject({ method: "GET", url: "/api/v1/calendars", headers: bearer(token) });
    expect(res.statusCode, "scope 用了 includes/startsWith 之类的子串比对").toBe(403);
  });

  it("没声明 scope 的路由,对第三方默认是关着的", async () => {
    // /devices/me 没有声明 oauthScope。默认拒绝的意思是:以后新加的路由
    // 天生对第三方关着 —— 忘了声明的后果是「第三方用不了(有人会报)」,
    // 而不是「第三方全都能用(没人发现)」。
    const { token } = await tokenWithScopes(["read:events", "write:events", "read:profile"]);
    const res = await app.inject({ method: "GET", url: "/api/v1/devices/me", headers: bearer(token) });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("insufficient_scope");
  });
});

describe("身份端点:token 有效就能问「我是谁」,但个人信息按 scope 裁", () => {
  it("只有 read:events 的存量 token 仍然能调 /auth/me（不这么做,所有现有集成会静默全挂）", async () => {
    // 授权页默认只勾 read:events、库里 allowed_scopes 默认值也是 ["read:events"],
    // 所以绝大多数存量 token 的 scope 就只有这一个。把身份端点整个锁在
    // read:profile 后面的话,它们换完 token 的第一步(「我是谁」)就 403,
    // 而且没有迁移路径 —— 已签发 token 里的 scope 是写死在库里的那份。
    const { token } = await tokenWithScopes(["read:events"]);
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: bearer(token) });
    expect(res.statusCode, `存量 token 调 /auth/me 被拒了。响应: ${res.body.slice(0, 200)}`).toBe(200);
  });

  it("但它拿不到邮箱和显示名（read:profile 这个 scope 的全部意义就在这儿）", async () => {
    const { token } = await tokenWithScopes(["read:events"]);
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: bearer(token) });
    const body = JSON.parse(res.body) as { data?: { id?: string; email?: string | null } };
    const data = body.data ?? (body as unknown as { id?: string; email?: string | null });
    expect(data.id, "连 id 都没给 —— 那这条端点就没用了").toBeTruthy();
    expect(data.email, "没授 read:profile 却把邮箱给出去了").toBeNull();
  });

  it("授了 read:profile 就能拿到（证明不是一刀切全裁）", async () => {
    const { token } = await tokenWithScopes(["read:events", "read:profile"]);
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: bearer(token) });
    const body = JSON.parse(res.body) as { data?: { email?: string | null } };
    const data = body.data ?? (body as unknown as { email?: string | null });
    expect(data.email, "授了 read:profile 还是拿不到邮箱").toBeTruthy();
  });
});
