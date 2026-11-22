// 原生 App 的 API Token 管理端点（/api/v1/account/api-tokens*）口径：
//   一、与网页自助流程同一套安全口径：创建要验密、写 Token 在 MFA 账号上
//       还要 TOTP、上限 5 枚、轮换 7 天宽限且继承到期、撤销立即生效；
//   二、明文只在创建/轮换的响应里出现一次，列表里永远没有；
//   三、个人 API Token 本身不许管理 Token（能签发凭据的凭据 = 持久化后门）；
//   四、错误编码是 JSON 形状：验密失败 403（不是 401 —— 三端把 401 当会话
//       失效会重发请求）、功能关闭 412、超限 409、轮换他人 Token 404。
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

import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { generateSync } from "otplib";
import { ensureSchema, resetDb, makeUser, buildRoutedApp } from "./harness.js";
import { db, schema } from "../../src/db/client.js";

const { deviceRoutes } = await import("../../src/routes/devices.js");
const { createApiToken, listApiTokensForUser, verifyApiToken } = await import("../../src/lib/api_token.js");
const { updateSettings, reloadSettings } = await import("../../src/lib/site_settings.js");
const { hashPassword } = await import("../../src/lib/password.js");
const { newTotpSecret } = await import("../../src/lib/mfa.js");

const REAL_PASSWORD = "correct-horse-battery";
const TOKEN_SHAPE = /^bwc_[A-Za-z0-9]{8}_[A-Za-z0-9]{24}$/;

let app: FastifyInstance;

async function makePasswordUser(email: string) {
  const u = await makeUser(email);
  await db.update(schema.users)
    .set({ passwordHash: await hashPassword(REAL_PASSWORD) })
    .where(eq(schema.users.id, u.id));
  return u;
}

async function login(email: string, totpSecret?: string): Promise<string> {
  const res = await app.inject({
    method: "POST", url: "/api/v1/auth/login-password",
    payload: { email, password: REAL_PASSWORD, label: "Desktop", kind: "desktop", clientDeviceId: `dev-${email.replace(/[^a-z0-9]/gi, "").slice(0, 24)}-1` },
  });
  expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
  const b = JSON.parse(res.body) as { accessToken?: string; mfaPending?: boolean; mfaToken?: string };
  if (b.mfaPending) {
    // 开了两步验证的账号：密码登录先落到待验证态，补一发 TOTP 才发令牌。
    expect(totpSecret, "MFA 账号登录需要提供 TOTP secret").toBeTruthy();
    const verify = await app.inject({
      method: "POST", url: "/api/v1/auth/login-mfa-verify",
      payload: { mfaToken: b.mfaToken, code: generateSync({ secret: totpSecret! }) },
    });
    expect(verify.statusCode, verify.body.slice(0, 300)).toBe(200);
    const vb = JSON.parse(verify.body) as { accessToken?: string };
    expect(vb.accessToken).toBeTruthy();
    return vb.accessToken!;
  }
  expect(b.accessToken).toBeTruthy();
  return b.accessToken!;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function setApiEnabled(on: boolean) {
  await updateSettings({ apiEnabled: on } as never);
  reloadSettings();
}

beforeAll(async () => { await ensureSchema(); });
afterAll(async () => { await app?.close(); });

beforeEach(async () => {
  await resetDb();
  await db.insert(schema.siteSettings)
    .values({ id: 1, registrationMode: "public", appsEnabled: true, captchaProvider: "none" })
    .onConflictDoNothing();
  reloadSettings();
  await setApiEnabled(true);
  app = await buildRoutedApp(deviceRoutes, { prefix: "/api/v1" });
});

describe("GET /account/api-tokens", () => {
  it("未登录 → 401", async () => {
    const res = await app.inject({ url: "/api/v1/account/api-tokens" });
    expect(res.statusCode).toBe(401);
  });

  it("空列表 + 表单形状字段 + 用量结构", async () => {
    const u = await makePasswordUser("list@example.com");
    const at = await login(u.email);
    const res = await app.inject({ url: "/api/v1/account/api-tokens", headers: auth(at) });
    expect(res.statusCode).toBe(200);
    const b = JSON.parse(res.body);
    expect(b.apiEnabled).toBe(true);
    expect(b.limit).toBe(5);
    expect(b.limitReached).toBe(false);
    expect(b.passwordSet).toBe(true);
    expect(b.mfaEnabled).toBe(false);
    expect(b.tokens).toEqual([]);
    expect(b.usage.total).toBe(0);
    expect(b.usage.perDay).toHaveLength(30);
    expect(b.usage.perToken).toEqual([]);
  });

  it("个人 API Token 本身不许读这个列表 → 403", async () => {
    const u = await makePasswordUser("self@example.com");
    const issued = await createApiToken({ userId: u.id, label: "integration", scope: "write" });
    const res = await app.inject({ url: "/api/v1/account/api-tokens", headers: auth(issued.plain) });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe("token_management_requires_session");
  });
});

describe("POST /account/api-tokens", () => {
  it("验密通过 → 201，明文只出现一次且能鉴权；列表里没有明文", async () => {
    const u = await makePasswordUser("create@example.com");
    const at = await login(u.email);
    const res = await app.inject({
      method: "POST", url: "/api/v1/account/api-tokens", headers: auth(at),
      payload: { label: "n8n", currentPassword: REAL_PASSWORD },
    });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(201);
    const b = JSON.parse(res.body);
    expect(b.plain).toMatch(TOKEN_SHAPE);
    expect(b.token.label).toBe("n8n");
    expect(b.token.scope).toBe("read"); // 默认只读
    expect(await verifyApiToken(b.plain)).toMatchObject({ userId: u.id, scope: "read" });

    const list = await app.inject({ url: "/api/v1/account/api-tokens", headers: auth(at) });
    const lb = JSON.parse(list.body);
    expect(lb.tokens).toHaveLength(1);
    expect(list.body).not.toContain(b.plain);
    expect(lb.usage.perToken).toHaveLength(1);
  });

  it("密码错 → 403 step_up_failed，且不签发", async () => {
    const u = await makePasswordUser("wrongpw@example.com");
    const at = await login(u.email);
    const res = await app.inject({
      method: "POST", url: "/api/v1/account/api-tokens", headers: auth(at),
      payload: { label: "x", currentPassword: "nope-nope" },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe("step_up_failed");
    expect(await listApiTokensForUser(u.id)).toHaveLength(0);
  });

  it("MFA 账号建写 Token：缺 TOTP → 403，补上 → 201", async () => {
    const u = await makePasswordUser("mfa@example.com");
    const secret = newTotpSecret();
    await db.update(schema.users).set({ mfaEnabled: true, mfaTotpSecret: secret }).where(eq(schema.users.id, u.id));
    const at = await login(u.email, secret);
    const noCode = await app.inject({
      method: "POST", url: "/api/v1/account/api-tokens", headers: auth(at),
      payload: { label: "w", scope: "write", currentPassword: REAL_PASSWORD },
    });
    expect(noCode.statusCode).toBe(403);
    const withCode = await app.inject({
      method: "POST", url: "/api/v1/account/api-tokens", headers: auth(at),
      payload: { label: "w", scope: "write", currentPassword: REAL_PASSWORD, mfaCode: generateSync({ secret }) },
    });
    expect(withCode.statusCode, withCode.body.slice(0, 300)).toBe(201);
    expect(JSON.parse(withCode.body).token.scope).toBe("write");
  });

  it("第 6 枚 → 409 limit_reached", async () => {
    const u = await makePasswordUser("cap@example.com");
    const at = await login(u.email);
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({
        method: "POST", url: "/api/v1/account/api-tokens", headers: auth(at),
        payload: { label: `t${i}`, currentPassword: REAL_PASSWORD },
      });
      expect(r.statusCode).toBe(201);
    }
    const sixth = await app.inject({
      method: "POST", url: "/api/v1/account/api-tokens", headers: auth(at),
      payload: { label: "t6", currentPassword: REAL_PASSWORD },
    });
    expect(sixth.statusCode).toBe(409);
    expect(JSON.parse(sixth.body)).toMatchObject({ error: "limit_reached", limit: 5 });
  });

  it("API 功能关闭 → 412 api_disabled", async () => {
    const u = await makePasswordUser("off@example.com");
    const at = await login(u.email);
    await setApiEnabled(false);
    const res = await app.inject({
      method: "POST", url: "/api/v1/account/api-tokens", headers: auth(at),
      payload: { label: "x", currentPassword: REAL_PASSWORD },
    });
    expect(res.statusCode).toBe(412);
    expect(JSON.parse(res.body).error).toBe("api_disabled");
  });
});

describe("rotate / revoke", () => {
  it("轮换：新明文一次、旧 Token 进宽限且仍可鉴权；轮换他人 → 404", async () => {
    const u = await makePasswordUser("rot@example.com");
    const other = await makePasswordUser("rot-other@example.com");
    const at = await login(u.email);
    const created = await app.inject({
      method: "POST", url: "/api/v1/account/api-tokens", headers: auth(at),
      payload: { label: "ci", currentPassword: REAL_PASSWORD },
    });
    const { token, plain } = JSON.parse(created.body);

    const badPw = await app.inject({
      method: "POST", url: `/api/v1/account/api-tokens/${token.id}/rotate`, headers: auth(at),
      payload: { currentPassword: "nope" },
    });
    expect(badPw.statusCode).toBe(403);

    const ok = await app.inject({
      method: "POST", url: `/api/v1/account/api-tokens/${token.id}/rotate`, headers: auth(at),
      payload: { currentPassword: REAL_PASSWORD },
    });
    expect(ok.statusCode, ok.body.slice(0, 300)).toBe(200);
    const rb = JSON.parse(ok.body);
    expect(rb.plain).toMatch(TOKEN_SHAPE);
    expect(rb.plain).not.toBe(plain);
    // 宽限期内旧密钥仍可鉴权
    expect(await verifyApiToken(plain)).toMatchObject({ userId: u.id });

    const list = JSON.parse((await app.inject({ url: "/api/v1/account/api-tokens", headers: auth(at) })).body);
    expect(list.tokens.find((t: { id: string }) => t.id === token.id)?.inGrace).toBe(true);

    const foreign = await app.inject({
      method: "POST", url: `/api/v1/account/api-tokens/${token.id}/rotate`, headers: auth(await login(other.email)),
      payload: { currentPassword: REAL_PASSWORD },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it("撤销立即生效；撤销他人的 id 是无声的 no-op", async () => {
    const u = await makePasswordUser("rev@example.com");
    const other = await makePasswordUser("rev-other@example.com");
    const at = await login(u.email);
    const created = await app.inject({
      method: "POST", url: "/api/v1/account/api-tokens", headers: auth(at),
      payload: { label: "tmp", currentPassword: REAL_PASSWORD },
    });
    const { token, plain } = JSON.parse(created.body);

    const foreign = await app.inject({
      method: "POST", url: `/api/v1/account/api-tokens/${token.id}/revoke`, headers: auth(await login(other.email)),
    });
    expect(foreign.statusCode).toBe(200);
    expect(await verifyApiToken(plain)).not.toBeNull(); // 没被别人撤掉

    const own = await app.inject({
      method: "POST", url: `/api/v1/account/api-tokens/${token.id}/revoke`, headers: auth(at),
    });
    expect(own.statusCode).toBe(200);
    expect(await verifyApiToken(plain)).toBeNull();
    expect(await listApiTokensForUser(u.id)).toHaveLength(0);
  });
});
