// 设置页「已授权应用」（/app/settings#oauth）的 JSON 双生端点口径：
//   GET  /api/v1/account/oauth-grants
//   POST /api/v1/account/oauth-grants/:clientId/revoke
//
// 授权同意页承诺用户「之后可在设置中撤销」，这一档钉住四件事：
//   一、列表只见自己的授权，按应用聚合（应用名 / 权限 / 授权时间）；
//   二、撤销即刻生效 —— 该应用的 OAuth 访问令牌马上过不了校验
//       （真实接口从 200 变 401），撤销前发出的未用授权码也不能再
//       换出新令牌。本实现没有 refresh token，访问令牌一撤整份授权
//       即终止，所以这里不存在「撤了 access 还留 refresh」的缝；
//   三、撤别人的授权撤不动：接口对不存在的授权一律不置可否（200
//       {ok:true}，与个人 API Token 撤销同一不透明口径），但对方的
//       令牌必须照常工作、对方列表里授权必须还在；
//   四、个人 API Token 身份不许列 / 撤（403
//       token_management_requires_session，与 Token 管理端点同一守卫），
//       OAuth 令牌本身更不许（oauthScope: "deny"）。
import { vi, beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

vi.mock("../../src/lib/mailer.js", () => ({
  sendMail: vi.fn(async () => ({ ok: true })),
  isMailerEnabled: vi.fn(async () => true),
}));

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://localhost:5432/bywave";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";

import Fastify, { type FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { ensureSchema, resetDb, makeUser } from "./harness.js";
import { db, schema } from "../../src/db/client.js";

const { hashPassword } = await import("../../src/lib/password.js");
const { createOAuthClient, issueAuthorizationCode, exchangeCodeForToken } = await import("../../src/lib/oauth_server.js");
const { createApiToken } = await import("../../src/lib/api_token.js");
const { updateSettings, reloadSettings } = await import("../../src/lib/site_settings.js");

const REAL_PASSWORD = "Correct-Horse-9";
const REDIRECT = "https://third-party.example.com/cb";
const SCOPES = ["read:events", "write:events", "read:profile"];

let app: FastifyInstance;

async function buildApp(): Promise<FastifyInstance> {
  const [cookie, formbody, { authRoutes }, { calendarRoutes }, { deviceRoutes }] =
    await Promise.all([
      import("@fastify/cookie"),
      import("@fastify/formbody"),
      import("../../src/routes/auth.js"),
      import("../../src/routes/calendars.js"),
      import("../../src/routes/devices.js"),
    ]);
  const { env } = await import("../../src/env.js");
  const a = Fastify({ logger: false });
  await a.register(cookie.default, { secret: env.SESSION_SECRET });
  await a.register(formbody.default);
  await a.register(authRoutes, { prefix: "/api/v1" });
  await a.register(calendarRoutes, { prefix: "/api/v1" });
  await a.register(deviceRoutes, { prefix: "/api/v1" });
  await a.ready();
  return a;
}

async function makePasswordUser(email: string) {
  const u = await makeUser(email);
  await db.update(schema.users)
    .set({ passwordHash: await hashPassword(REAL_PASSWORD) })
    .where(eq(schema.users.id, u.id));
  return u;
}

/** 设备登录（原生 App 身份）——已授权应用管理的合法调用方之一。 */
async function deviceLogin(email: string): Promise<string> {
  const res = await app.inject({
    method: "POST", url: "/api/v1/auth/login-password",
    payload: { email, password: REAL_PASSWORD, label: "Desktop", kind: "desktop", clientDeviceId: `dev-${email.replace(/[^a-z0-9]/gi, "").slice(0, 24)}-1` },
  });
  expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
  const b = JSON.parse(res.body) as { accessToken?: string };
  expect(b.accessToken).toBeTruthy();
  return b.accessToken!;
}

/** 走完整授权码交换给指定用户发一张真 OAuth 令牌（不直接塞表）。 */
async function grantFor(userId: string, appName: string) {
  const client = await createOAuthClient({
    name: appName, redirectUris: [REDIRECT], allowedScopes: SCOPES as never,
  });
  const code = await issueAuthorizationCode({
    clientId: client.id, userId, redirectUri: REDIRECT, scopes: SCOPES, codeChallenge: null,
  });
  const res = await exchangeCodeForToken({
    code, clientId: client.clientId, clientSecret: client.clientSecret, redirectUri: REDIRECT,
  });
  if ("error" in res) throw new Error("布置失败: " + res.error);
  return { token: res.accessToken, clientRowId: client.id, client };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function listGrants(token: string) {
  const res = await app.inject({ url: "/api/v1/account/oauth-grants", headers: auth(token) });
  expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
  return (JSON.parse(res.body) as { grants: Array<{ clientId: string; name: string; scopes: string[]; tokenCount: number; grantedAt: string }> }).grants;
}

async function calendarsStatus(oauthToken: string) {
  const res = await app.inject({ url: "/api/v1/calendars", headers: auth(oauthToken) });
  return res.statusCode;
}

beforeAll(async () => { await ensureSchema(); });
afterAll(async () => { await app?.close(); });

beforeEach(async () => {
  await resetDb();
  await db.insert(schema.siteSettings)
    .values({ id: 1, registrationMode: "public", appsEnabled: true, captchaProvider: "none" })
    .onConflictDoNothing();
  await updateSettings({ apiEnabled: true } as never);
  reloadSettings();
  app = await buildApp();
});

describe("GET /account/oauth-grants", () => {
  it("未登录 → 401", async () => {
    const res = await app.inject({ url: "/api/v1/account/oauth-grants" });
    expect(res.statusCode).toBe(401);
  });

  it("只列自己的授权，按应用聚合且不带任何令牌材料", async () => {
    const a = await makePasswordUser("a@example.com");
    const b = await makePasswordUser("b@example.com");
    const ga = await grantFor(a.id, "甲应用");
    await grantFor(b.id, "乙应用");

    const grantsA = await listGrants(await deviceLogin("a@example.com"));
    expect(grantsA).toHaveLength(1);
    expect(grantsA[0]!.clientId).toBe(ga.clientRowId);
    expect(grantsA[0]!.name).toBe("甲应用");
    expect(grantsA[0]!.scopes).toEqual(expect.arrayContaining(SCOPES));
    expect(grantsA[0]!.tokenCount).toBe(1);
    expect(grantsA[0]!.grantedAt).toBeTruthy();
    // 列表里永远不出现令牌明文 / 哈希。
    expect(JSON.stringify(grantsA)).not.toContain("bwo_");

    const grantsB = await listGrants(await deviceLogin("b@example.com"));
    expect(grantsB).toHaveLength(1);
    expect(grantsB[0]!.name).toBe("乙应用");
  });

  it("同一应用重复授权在列表里并成一行，tokenCount 累加", async () => {
    const a = await makePasswordUser("a@example.com");
    const client = await createOAuthClient({
      name: "重复授权应用", redirectUris: [REDIRECT], allowedScopes: SCOPES as never,
    });
    for (let i = 0; i < 2; i++) {
      const code = await issueAuthorizationCode({
        clientId: client.id, userId: a.id, redirectUri: REDIRECT, scopes: SCOPES, codeChallenge: null,
      });
      const res = await exchangeCodeForToken({
        code, clientId: client.clientId, clientSecret: client.clientSecret, redirectUri: REDIRECT,
      });
      if ("error" in res) throw new Error("布置失败: " + res.error);
    }
    const grants = await listGrants(await deviceLogin("a@example.com"));
    expect(grants).toHaveLength(1);
    expect(grants[0]!.tokenCount).toBe(2);
  });
});

describe("POST /account/oauth-grants/:clientId/revoke", () => {
  it("撤销后该应用的访问令牌立即失效，未用授权码也不能再换令牌", async () => {
    const a = await makePasswordUser("a@example.com");
    const g = await grantFor(a.id, "待撤销应用");
    expect(await calendarsStatus(g.token)).toBe(200);

    // 撤销前再发一张未用的授权码 —— 撤销后它不该还能换出新令牌。
    const pendingCode = await issueAuthorizationCode({
      clientId: g.clientRowId, userId: a.id, redirectUri: REDIRECT, scopes: SCOPES, codeChallenge: null,
    });

    const device = await deviceLogin("a@example.com");
    const res = await app.inject({
      method: "POST", url: `/api/v1/account/oauth-grants/${g.clientRowId}/revoke`, headers: auth(device),
    });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });

    // 访问令牌即刻过不了校验（真实接口 401）。
    expect(await calendarsStatus(g.token)).toBe(401);
    // 列表里也没了。
    expect(await listGrants(device)).toHaveLength(0);
    // 未用授权码换不出令牌了。
    const exchanged = await exchangeCodeForToken({
      code: pendingCode, clientId: g.client.clientId, clientSecret: g.client.clientSecret, redirectUri: REDIRECT,
    });
    expect("error" in exchanged).toBe(true);
    // 审计留痕。
    const audits = await db.select().from(schema.adminAuditLog)
      .where(eq(schema.adminAuditLog.action, "oauth_grant.revoke"));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorUserId).toBe(a.id);
    expect(audits[0]!.targetId).toBe(g.clientRowId);
  });

  it("重复授权的两张令牌一起失效（一撤撤整份授权）", async () => {
    const a = await makePasswordUser("a@example.com");
    const client = await createOAuthClient({
      name: "双令牌应用", redirectUris: [REDIRECT], allowedScopes: SCOPES as never,
    });
    const tokens: string[] = [];
    for (let i = 0; i < 2; i++) {
      const code = await issueAuthorizationCode({
        clientId: client.id, userId: a.id, redirectUri: REDIRECT, scopes: SCOPES, codeChallenge: null,
      });
      const res = await exchangeCodeForToken({
        code, clientId: client.clientId, clientSecret: client.clientSecret, redirectUri: REDIRECT,
      });
      if ("error" in res) throw new Error("布置失败: " + res.error);
      tokens.push(res.accessToken);
    }
    expect(await calendarsStatus(tokens[0]!)).toBe(200);
    expect(await calendarsStatus(tokens[1]!)).toBe(200);

    const device = await deviceLogin("a@example.com");
    const res = await app.inject({
      method: "POST", url: `/api/v1/account/oauth-grants/${client.id}/revoke`, headers: auth(device),
    });
    expect(res.statusCode).toBe(200);
    expect(await calendarsStatus(tokens[0]!)).toBe(401);
    expect(await calendarsStatus(tokens[1]!)).toBe(401);
  });

  it("撤别人的授权：响应不置可否，但对方令牌照常工作、授权还在", async () => {
    const a = await makePasswordUser("a@example.com");
    const b = await makePasswordUser("b@example.com");
    const ga = await grantFor(a.id, "甲应用");
    const deviceB = await deviceLogin("b@example.com");

    const res = await app.inject({
      method: "POST", url: `/api/v1/account/oauth-grants/${ga.clientRowId}/revoke`, headers: auth(deviceB),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });

    expect(await calendarsStatus(ga.token)).toBe(200);
    const grantsA = await listGrants(await deviceLogin("a@example.com"));
    expect(grantsA).toHaveLength(1);
    // 没有产生撤销审计。
    const audits = await db.select().from(schema.adminAuditLog)
      .where(eq(schema.adminAuditLog.action, "oauth_grant.revoke"));
    expect(audits).toHaveLength(0);
  });

  it("个人 API Token 身份：列与撤都 403 token_management_requires_session", async () => {
    const a = await makePasswordUser("a@example.com");
    const g = await grantFor(a.id, "甲应用");
    const apiToken = await createApiToken({ userId: a.id, label: "cli", scope: "write" });

    const list = await app.inject({ url: "/api/v1/account/oauth-grants", headers: auth(apiToken.plain) });
    expect(list.statusCode).toBe(403);
    expect(JSON.parse(list.body)).toEqual({ error: "token_management_requires_session" });

    const revoke = await app.inject({
      method: "POST", url: `/api/v1/account/oauth-grants/${g.clientRowId}/revoke`, headers: auth(apiToken.plain),
    });
    expect(revoke.statusCode).toBe(403);
    expect(JSON.parse(revoke.body)).toEqual({ error: "token_management_requires_session" });

    // 授权毫发无损。
    expect(await calendarsStatus(g.token)).toBe(200);
  });

  it("OAuth 令牌本身不许碰授权管理（oauthScope deny）", async () => {
    const a = await makePasswordUser("a@example.com");
    const g = await grantFor(a.id, "甲应用");
    const list = await app.inject({ url: "/api/v1/account/oauth-grants", headers: auth(g.token) });
    expect(list.statusCode).toBe(403);
    const revoke = await app.inject({
      method: "POST", url: `/api/v1/account/oauth-grants/${g.clientRowId}/revoke`, headers: auth(g.token),
    });
    expect(revoke.statusCode).toBe(403);
    expect(await calendarsStatus(g.token)).toBe(200);
  });

  it("clientId 不是 uuid → 400", async () => {
    await makePasswordUser("a@example.com");
    const device = await deviceLogin("a@example.com");
    const res = await app.inject({
      method: "POST", url: "/api/v1/account/oauth-grants/not-a-uuid/revoke", headers: auth(device),
    });
    expect(res.statusCode).toBe(400);
  });
});
