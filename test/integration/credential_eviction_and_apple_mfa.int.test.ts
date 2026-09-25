// 两件事，都是「以为锁上了，其实没锁」：
//
// ① Apple 登录绕过两步验证。
//    账号开了两步验证、又绑过 Apple ID —— 走「通过 Apple 登录」，服务端验完
//    Apple 的票就直接发 App 令牌，一次都没要验证码。拿这张令牌还能换出一个被
//    记成「已过二次验证」的浏览器会话，网页后台全部放行。
//    密码登录那条是有这一步的；Apple 那条的注释还写着「和密码登录一模一样」。
//
// ② 「踢人」赶不走人。
//    改密码、重置密码、后台停用、后台踢出 —— 五条路各列各的清单，每条都漏了
//    不一样的东西：改密码不吊销应用密码和第三方授权（盗号的人还能继续同步你的
//    日历），后台停用和踢出不吊销手机 App（踢出之后手机照常用，停用再启用
//    手机自己复活）。
//
// 判据都落在**库里那一行**上：令牌是不是真被作废了，而不是页面说了什么。

import { vi, beforeAll, beforeEach, afterEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
vi.mock("../../src/lib/mailer.js", () => ({
  sendMail: vi.fn(async () => ({ ok: true })),
  isMailerEnabled: vi.fn(async () => true),
}));

// 苹果验签要连外网取公钥，只替换「这张票是真的吗」这一步，后面全是生产代码。
class FakeAppleVerifyError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}
const appleClaims = { sub: "apple-sub-mfa", email: "mfa@example.com", emailVerified: true, isPrivateRelay: false };
vi.mock("../../src/lib/apple_signin.js", () => ({
  appleSignInConfigured: () => true,
  verifyAppleIdentityToken: async () => appleClaims,
  AppleVerifyError: FakeAppleVerifyError,
  appleClientIds: () => ["cn.bywave.calendar"],
}));

import type { FastifyInstance } from "fastify";
import { eq, isNull } from "drizzle-orm";
import { generateSync } from "otplib";
import { ensureSchema, resetDb, db, schema, buildRoutedApp, makeUser } from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";

const { deviceRoutes } = await import("../../src/routes/devices.js");
const { newTotpSecret } = await import("../../src/lib/mfa.js");
const { hashPassword } = await import("../../src/lib/password.js");
const { signAccessToken } = await import("../../src/lib/device_tokens.js");
const { evictAllCredentials } = await import("../../src/lib/user_state.js");

beforeAll(async () => { await ensureSchema(); });

let app: FastifyInstance;

async function enableApps() {
  const { reloadSettings } = await import("../../src/lib/site_settings.js");
  const v = { registrationMode: "public", appsEnabled: true, captchaProvider: "none" };
  await db.insert(schema.siteSettings).values({ id: 1, ...v })
    .onConflictDoUpdate({ target: schema.siteSettings.id, set: v });
  reloadSettings();
}

beforeEach(async () => {
  await resetDb();
  await enableApps();
  app = await buildRoutedApp(deviceRoutes, { prefix: "/api/v1" });
});
afterEach(async () => { await app.close(); });

const deviceCount = async (userId: string) =>
  (await db.select().from(schema.devices).where(eq(schema.devices.userId, userId))).length;

function appleSignIn() {
  return app.inject({
    method: "POST", url: "/api/v1/auth/apple",
    payload: { identityToken: "x".repeat(40), label: "iPhone", kind: "ios", appVersion: "1.7.1", clientDeviceId: "dev-apple-1" },
  });
}

// ─────────────────────────────────────────────────────────────────────────
describe("Apple 登录必须过两步验证", () => {
  it("没开两步验证的账号：直接登进去（presence —— 证明这条路本身是通的）", async () => {
    const u = await makeUser("plain@example.com");
    await db.update(schema.users).set({ appleSub: "apple-sub-mfa" }).where(eq(schema.users.id, u.id));
    const res = await appleSignIn();
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    const b = JSON.parse(res.body) as { accessToken?: string };
    expect(b.accessToken, "连普通账号都登不进来 —— 下面几条什么也没测到").toBeTruthy();
  });

  it("**开了两步验证的账号：不发令牌，先要验证码**（这条是核心）", async () => {
    const u = await makeUser("mfa@example.com");
    await db.update(schema.users).set({
      appleSub: "apple-sub-mfa", mfaEnabled: true, mfaTotpSecret: newTotpSecret(),
    }).where(eq(schema.users.id, u.id));

    const res = await appleSignIn();
    expect(res.statusCode).toBe(200);
    const b = JSON.parse(res.body) as { accessToken?: string; refreshToken?: string; mfaPending?: boolean; mfaToken?: string };
    expect(
      b.accessToken,
      "开了两步验证的账号走 Apple 直接拿到了令牌 —— 对走这条路的人，两步验证等于不存在",
    ).toBeUndefined();
    expect(b.refreshToken, "刷新令牌也不该发").toBeUndefined();
    expect(b.mfaPending, "没有转入两步验证").toBe(true);
    expect(b.mfaToken, "没给下一步用的票").toBeTruthy();
    expect(await deviceCount(u.id), "还没过两步验证就已经建了设备").toBe(0);
  });

  it("交上正确的验证码之后才真正登进去", async () => {
    const secret = newTotpSecret();
    const u = await makeUser("mfa2@example.com");
    await db.update(schema.users).set({ appleSub: "apple-sub-mfa", mfaEnabled: true, mfaTotpSecret: secret })
      .where(eq(schema.users.id, u.id));
    const first = JSON.parse((await appleSignIn()).body) as { mfaToken: string };

    const bad = await app.inject({ method: "POST", url: "/api/v1/auth/login-mfa-verify",
      payload: { mfaToken: first.mfaToken, code: "000000" } });
    expect(bad.statusCode, "错的验证码也放行了").not.toBe(200);
    expect(await deviceCount(u.id)).toBe(0);

    const again = JSON.parse((await appleSignIn()).body) as { mfaToken: string };
    const ok = await app.inject({ method: "POST", url: "/api/v1/auth/login-mfa-verify",
      payload: { mfaToken: again.mfaToken, code: generateSync({ secret }) } });
    expect(ok.statusCode, ok.body.slice(0, 300)).toBe(200);
    expect((JSON.parse(ok.body) as { accessToken?: string }).accessToken).toBeTruthy();
    expect(await deviceCount(u.id)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
/** 给一个人装满各种钥匙：两台 App、一个应用密码、一个 API Token、一张第三方授权。 */
async function seedKeys(userId: string) {
  const mk = async (label: string) => (await db.insert(schema.devices).values({
    userId, label, kind: "ios", refreshTokenHash: "h-" + label, refreshTokenPrefix: "p-" + label,
  }).returning())[0]!;
  const phone = await mk("phone");
  const tablet = await mk("tablet");
  await db.insert(schema.appPasswords).values({ userId, label: "Apple 日历", prefix: "ap1", tokenHash: "x" });
  await db.insert(schema.apiTokens).values({ userId, label: "n8n", prefix: "at1", tokenHash: "x" });
  const [client] = await db.insert(schema.oauthClients).values({
    clientId: "bwc_app_test", clientSecretHash: "x", name: "第三方", redirectUris: "https://x.example/cb",
  }).returning();
  await db.insert(schema.oauthAccessTokens).values({
    userId, clientId: client!.id, tokenHash: "x", prefix: "bwo_t1", scopes: ["read:events"],
    expiresAt: new Date(Date.now() + 30 * 86400_000),
  });
  return { phone, tablet };
}

async function liveKeys(userId: string) {
  const live = async <T extends { revokedAt: unknown; userId: unknown }>(t: T) =>
    (await db.select().from(t as never).where(eq((t as never as { userId: never }).userId, userId)))
      .filter((r: { revokedAt?: Date | null }) => !r.revokedAt).length;
  return {
    devices: await live(schema.devices as never),
    appPasswords: await live(schema.appPasswords as never),
    apiTokens: await live(schema.apiTokens as never),
    oauth: await live(schema.oauthAccessTokens as never),
  };
}

describe("「把人赶走」要把所有钥匙都作废", () => {
  it("收口函数本身：四类钥匙一个不留（presence —— 先证明种进去了）", async () => {
    const u = await makeUser("k@example.com");
    await seedKeys(u.id);
    expect(await liveKeys(u.id), "种钥匙就失败了").toEqual({ devices: 2, appPasswords: 1, apiTokens: 1, oauth: 1 });
    await evictAllCredentials(u.id);
    expect(
      await liveKeys(u.id),
      "有钥匙没被作废 —— 用户以为把人赶走了，对方还能用它继续读写日历",
    ).toEqual({ devices: 0, appPasswords: 0, apiTokens: 0, oauth: 0 });
  });

  it("**第三方授权也被作废**（原来整个仓库没有一处会批量收回它）", async () => {
    const u = await makeUser("o@example.com");
    await seedKeys(u.id);
    await evictAllCredentials(u.id);
    const rows = await db.select().from(schema.oauthAccessTokens)
      .where(eq(schema.oauthAccessTokens.userId, u.id));
    expect(rows.every((r) => r.revokedAt), "改完密码，第三方授权还能用到 30 天后到期").toBe(true);
  });

  it("App 里改密码：别的都作废，**只留当前这台**（从 HTTP 打进去）", async () => {
    const u = await makeUser("chg@example.com");
    await db.update(schema.users).set({ passwordHash: await hashPassword("OldPassw0rd!x") })
      .where(eq(schema.users.id, u.id));
    const { phone } = await seedKeys(u.id);
    const access = signAccessToken(u.id, phone.id);

    const res = await app.inject({
      method: "POST", url: "/api/v1/account/password",
      headers: { authorization: `Bearer ${access.token}` },
      payload: { currentPassword: "OldPassw0rd!x", newPassword: "NewPassw0rd!y2" },
    });
    expect(res.statusCode, `改密码没成功：${res.body.slice(0, 300)}`).toBe(200);

    const k = await liveKeys(u.id);
    expect(k.devices, "当前这台被踢了 —— 用户在 App 里改完密码自己就被登出").toBe(1);
    const [kept] = await db.select().from(schema.devices)
      .where(eq(schema.devices.userId, u.id)).then((r) => r.filter((d) => !d.revokedAt));
    expect(kept!.id, "留下的不是当前这台").toBe(phone.id);
    expect(k.appPasswords, "应用密码没作废 —— 盗号的人还能继续用 CalDAV 同步").toBe(0);
    expect(k.apiTokens, "API Token 没作废").toBe(0);
    expect(k.oauth, "第三方授权没作废").toBe(0);
  });

  it("五条「踢人」的路都走同一个收口（少一条就又是各漏各的）", async () => {
    const { readFileSync } = await import("node:fs");
    const src = (f: string) => readFileSync(f, "utf8");
    const web = src("src/web/index.ts");
    const admin = src("src/web/admin.ts");
    const devices = src("src/routes/devices.ts");
    const calls = (s: string) => (s.match(/evictAllCredentials\s*\(/g) ?? []).length;
    expect(calls(web), "网页改密码 + 忘记密码重置，应该各调一次").toBeGreaterThanOrEqual(2);
    expect(calls(admin), "后台停用 + 后台踢出，应该各调一次").toBeGreaterThanOrEqual(2);
    expect(calls(devices), "App 里改密码").toBeGreaterThanOrEqual(1);
  });
});
