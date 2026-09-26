// 已登录时「你刚输的密码 / 验证码不对」必须回 403，不能回 401。
//
// 三端 App 都把 401 当成「会话没了」：先刷新令牌、再把整个请求重发一遍。于是每输错
// 一次都吃掉两次限流额度 —— 删账号每 5 分钟只准 3 次，输错两次就被挡在外面。
// iOS 还把原因扔了，显示成「操作失败，请稍后再试（401）」。
// 这个仓库的约定：401 = 会话没了，403 = 这次没验过。

import { vi, beforeAll, beforeEach, afterEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
vi.mock("../../src/lib/mailer.js", () => ({
  sendMail: vi.fn(async () => ({ ok: true })), isMailerEnabled: vi.fn(async () => true),
}));

import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { ensureSchema, resetDb, db, schema, buildRoutedApp, makeUser } from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const { deviceRoutes } = await import("../../src/routes/devices.js");
const { hashPassword } = await import("../../src/lib/password.js");
const { signAccessToken } = await import("../../src/lib/device_tokens.js");
const { newTotpSecret } = await import("../../src/lib/mfa.js");

beforeAll(async () => { await ensureSchema(); });
let app: FastifyInstance;
let bearer: string;

beforeEach(async () => {
  await resetDb();
  const { reloadSettings } = await import("../../src/lib/site_settings.js");
  const v = { registrationMode: "public", appsEnabled: true, captchaProvider: "none", lockoutEnabled: false };
  await db.insert(schema.siteSettings).values({ id: 1, ...v }).onConflictDoUpdate({ target: schema.siteSettings.id, set: v });
  reloadSettings();
  app = await buildRoutedApp(deviceRoutes, { prefix: "/api/v1" });
  const u = await makeUser("u@example.com");
  await db.update(schema.users).set({
    passwordHash: await hashPassword("Right-Passw0rd!"), mfaEnabled: true, mfaTotpSecret: newTotpSecret(),
  }).where(eq(schema.users.id, u.id));
  const [d] = await db.insert(schema.devices).values({
    userId: u.id, label: "p", kind: "ios", refreshTokenHash: "h", refreshTokenPrefix: "p",
  }).returning();
  bearer = `Bearer ${signAccessToken(u.id, d!.id).token}`;
});
afterEach(async () => { await app.close(); });

const post = (url: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url, headers: { authorization: bearer }, payload });

describe("已登录时输错密码 / 验证码 → 403", () => {
  it("令牌本身是好的（presence —— 否则下面全是「没登录」的 401）", async () => {
    const r = await app.inject({ method: "GET", url: "/api/v1/devices", headers: { authorization: bearer } });
    expect(r.statusCode, "测试用的登录令牌本身不能用").not.toBe(401);
  });

  it.each([
    ["改密码：当前密码错", "/api/v1/account/password", { currentPassword: "WRONG-pass-1", newPassword: "New-Passw0rd!x" }, "invalid_credentials"],
    ["删账号：密码错", "/api/v1/account/delete", { password: "WRONG-pass-1", confirm: "删除我的账号" }, "invalid_credentials"],
    ["关两步验证：密码错", "/api/v1/account/mfa/disable", { password: "WRONG-pass-1", code: "000000" }, "invalid_credentials"],
  ])("%s", async (_name, url, payload, code) => {
    const r = await post(url, payload);
    expect(
      r.statusCode,
      `${url} 用 401 表示「你刚输的不对」—— App 会当成会话没了，刷新令牌后把请求重发一遍，` +
        "一次输错吃两次限流额度",
    ).toBe(403);
    expect(r.body, "错误码没带回去，App 没法说清是什么不对").toContain(code);
  });
});
