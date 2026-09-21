// 账号接管链 + 老 SSO 用户 + 配额并发,全部从 HTTP 打进去。
//
// 见 claim_harness.ts 顶上那段:这一档一律**真 Fastify 实例 + 真路由 + 真请求**,
// 落点在 users / sessions / devices / api_tokens 这些真表上,不直调 lib 函数。
// 直调看不见「路由自己多做了一件事」—— 本仓库为这件事付过账。

import { vi, beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";

// 必须在任何 import 之前落地:src/env.ts 在模块求值时就 parse 了 process.env,
// 而 appleClientIds() 读的是 env.SIWA_CLIENT_IDS。晚一步设,苹果那条路会一直
// 503(feature off),而 503 也是「没被接管」—— 一组看起来很绿的空跑。
vi.hoisted(() => {
  process.env.SIWA_CLIENT_IDS = "cn.bywave.calendar.test";
});

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./security_harness.js");
  return { db: h.db, schema: h.schema };
});

// 唯一一处 mock,而且它不是任何一道判定:SMTP。登录成功会去发「你刚登录了」
// 的提醒信,mailer 没开的话那是一条 fire-and-forget 的失败日志,跟被测的判定
// 无关,但会把输出刷满。
vi.mock("../../src/lib/mailer.js", () => ({
  isMailerEnabled: async () => true,
  sendMail: async () => ({ ok: true }),
}));

import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  ensureSchema, resetDb, db, schema, pg,
  applySettings, userCount,
  buildClaimApp, userByEmail,
  startSsoIdp, seedSsoProvider, ssoLogin, type SsoIdp,
  startFakeIdp, seedIdpProvider, APPLE_CLIENT_ID, type FakeIdp,
} from "./claim_harness.js";

let app: FastifyInstance;
let sso: SsoIdp;
let apple: FakeIdp;

const SLUG = "keycloak";
const VICTIM = "boss@example.com";
const ATTACKER_PW = "Attacker-Horse-9";

beforeAll(async () => {
  await ensureSchema();
  sso = await startSsoIdp();
  apple = await startFakeIdp();
  app = await buildClaimApp();
});

afterAll(async () => {
  await app?.close();
  await sso?.close();
  await apple?.close();
});

beforeEach(async () => {
  await resetDb();
});

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

async function openSite(extra: Parameters<typeof applySettings>[0] = {}): Promise<void> {
  await applySettings({ registrationMode: "public", idpApiServiceClients: "meeting-platform", ...extra });
  await seedSsoProvider(sso, SLUG);
}

/** 站点开着,但只挂外部 IdP 那台(资源服务器那条路要它的 JWKS)。 */
async function openSiteWithIdpApi(): Promise<void> {
  await applySettings({ registrationMode: "public", idpApiServiceClients: "meeting-platform" });
  await seedIdpProvider(apple, "resource-idp");
}

function sessionCookieOf(res: { headers: Record<string, unknown> }): string | null {
  const h = res.headers["set-cookie"];
  const list = Array.isArray(h) ? h.map(String) : h ? [String(h)] : [];
  return list.find((c) => c.startsWith("bwc_sid=") && !c.includes("Max-Age=0")) ?? null;
}

function register(email: string, password: string) {
  return app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email, password } });
}

function login(email: string, password: string) {
  return app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } });
}

async function appleLogin(email: string, sub: string, verified: unknown = "true") {
  const token = await apple.signAppleToken({ sub, email, email_verified: verified, is_private_email: "false" });
  return app.inject({
    method: "POST", url: "/api/v1/auth/apple",
    payload: { identityToken: token, label: "iPhone", kind: "ios" },
  });
}

async function countRows(table: string, userId: string): Promise<number> {
  const r = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [userId]);
  return Number(r.rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// 0. 工装自检 —— 没有这一组,下面所有「被拒了」都可能是空跑
// ---------------------------------------------------------------------------

describe("工装自检", () => {
  it("苹果登录的 feature 开关是开的（否则整组会静默 503）", async () => {
    const { appleSignInConfigured, appleClientIds } = await import("../../src/lib/apple_signin.js");
    expect(appleSignInConfigured()).toBe(true);
    expect(appleClientIds()).toContain(APPLE_CLIENT_ID);
  });

  it("假 Keycloak 真的走得完 authorization_code：一个全新邮箱能开出号来", async () => {
    await openSite();
    const r = await ssoLogin(app, sso, SLUG, { sub: "fresh-1", email: "fresh@example.com", email_verified: true });
    expect(r.location, `回调去了 ${r.location}`).toBe("/app");
    expect(r.sessionCookie).not.toBeNull();
    expect(await userCount()).toBe(1);
  });

  it("苹果那条路真的挂着（不是 404，也不是 503）", async () => {
    await openSite();
    const r = await appleLogin("fresh-apple@example.com", "apple-fresh");
    expect(r.statusCode, r.body.slice(0, 200)).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 1. 抢注接管链
// ---------------------------------------------------------------------------
//
// 复现原文(改动前):
//     攻击者注册: 200 → 库里 email_verified:false, signup_source:'self'
//     受害者苹果登录: 200 → 同一行被打上 apple_sub
//     攻击者用自己的密码登录: 200 → 还是那一行
// 这一组把这三步原样打一遍,断言第三步进不去。

describe("抢注接管链：攻击者注册 → 受害者外部登录 → 攻击者原密码登录", () => {
  it("苹果登录之后，攻击者那个密码进不去了", async () => {
    await openSite();

    // ---- 第一步:攻击者拿受害者的邮箱开一个号 ----
    const reg = await register(VICTIM, ATTACKER_PW);
    expect(reg.statusCode, reg.body.slice(0, 200)).toBe(200);
    const squatted = await userByEmail(VICTIM);
    expect(squatted!.emailVerified).toBe(false);
    expect(squatted!.signupSource).toBe("self");
    // 没验过邮箱就不该当场把人登进去 —— 这是抢注链的第一环。
    expect(sessionCookieOf(reg), "未验证的注册当场发了会话").toBeNull();

    // 这一步之前,攻击者的密码是**能用**的。不先钉住这条,第三步的 401 可能是
    // 密码一开始就没写进去(比如注册被别的闸门挡了),而不是被作废掉了。
    const beforeLogin = await login(VICTIM, ATTACKER_PW);
    expect(beforeLogin.statusCode, beforeLogin.body.slice(0, 200)).toBe(200);
    expect(sessionCookieOf(beforeLogin)).not.toBeNull();
    expect(await countRows("sessions", squatted!.id)).toBe(1);

    // ---- 第二步:受害者用苹果登录 ----
    const siwa = await appleLogin(VICTIM, "apple-victim-sub");
    expect(siwa.statusCode, siwa.body.slice(0, 300)).toBe(200);
    // 还是同一行(苹果认领了它),不是又开了一个号。
    const after = await userByEmail(VICTIM);
    expect(after!.id).toBe(squatted!.id);
    expect(after!.appleSub).toBe("apple-victim-sub");
    expect(await userCount()).toBe(1);

    // ---- 第三步:攻击者拿自己那个密码再登一次 ----
    const afterLogin = await login(VICTIM, ATTACKER_PW);
    expect(afterLogin.statusCode, afterLogin.body.slice(0, 200)).toBe(401);
    expect(sessionCookieOf(afterLogin)).toBeNull();
    // 他之前那个还没过期的浏览器会话也不能留着。
    expect(await countRows("sessions", squatted!.id)).toBe(0);
  });

  it("浏览器 SSO 登录也是同一条链（同一份判定，两个入口）", async () => {
    await openSite();
    await register(VICTIM, ATTACKER_PW);
    const squatted = await userByEmail(VICTIM);
    expect((await login(VICTIM, ATTACKER_PW)).statusCode).toBe(200);

    const r = await ssoLogin(app, sso, SLUG, { sub: "kc-victim", email: VICTIM, email_verified: true });
    expect(r.location, `回调去了 ${r.location}`).toBe("/app");
    expect(r.sessionCookie).not.toBeNull();
    expect((await userByEmail(VICTIM))!.id).toBe(squatted!.id);

    expect((await login(VICTIM, ATTACKER_PW)).statusCode).toBe(401);
  });

  it("作废的是**所有**登录方式，不只是密码", async () => {
    await openSite();
    await register(VICTIM, ATTACKER_PW);
    const squatted = (await userByEmail(VICTIM))!;
    await login(VICTIM, ATTACKER_PW);   // 一条会话

    // 抢注者在这个号上还能攒下别的钥匙。逐张表种一行:漏掉哪张表,下面对应
    // 那条断言就会红。
    await db.insert(schema.devices).values({
      userId: squatted.id, label: "攻击者的手机", kind: "ios",
      refreshTokenHash: "h", refreshTokenPrefix: "bwd_aaaa1111",
    });
    await db.insert(schema.apiTokens).values({
      userId: squatted.id, label: "t", prefix: "bwk_aaaa1111", tokenHash: "h",
    });
    await db.insert(schema.appPasswords).values({
      userId: squatted.id, label: "caldav", prefix: "bwa_aaaa1111", tokenHash: "h",
    });
    await db.insert(schema.webauthnCredentials).values({
      userId: squatted.id, credentialId: "cred-1", publicKey: "pk",
    });
    await db.insert(schema.userIdentities).values({
      userId: squatted.id, provider: "other-idp", subject: "attacker-sub", email: VICTIM,
    });
    await db.insert(schema.passwordResets).values({
      userId: squatted.id, token: "reset-token-1", expiresAt: new Date(Date.now() + 3600_000),
    });
    // MFA 也要真的先开起来。不开的话下面那两条断言天生就是绿的 —— 那不是
    // 「作废掉了」,那是「本来就没有」。
    await db.update(schema.users).set({
      mfaEnabled: true,
      mfaTotpSecret: "ATTACKERSECRET234567",
      mfaBackupCodes: [{ hash: "h", used: false }] as unknown as object,
    }).where(eq(schema.users.id, squatted.id));

    const siwa = await appleLogin(VICTIM, "apple-victim-sub");
    expect(siwa.statusCode, siwa.body.slice(0, 300)).toBe(200);

    expect(await countRows("sessions", squatted.id), "浏览器会话").toBe(0);
    expect(await countRows("webauthn_credentials", squatted.id), "通行密钥").toBe(0);
    expect(await countRows("user_identities", squatted.id), "别的 IdP 身份").toBe(0);
    expect(await countRows("password_resets", squatted.id), "没用掉的重置链接").toBe(0);

    // 设备:苹果登录自己会开一台新的,所以数不能为 0 —— 断言的是「攻击者那台
    // 不在了」,不是「一台都没有」。
    const devices = await db.select().from(schema.devices).where(eq(schema.devices.userId, squatted.id));
    expect(devices.map((d) => d.label)).not.toContain("攻击者的手机");

    const tokens = await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.userId, squatted.id));
    expect(tokens.every((t) => t.revokedAt !== null), "API 令牌").toBe(true);
    const appPws = await db.select().from(schema.appPasswords).where(eq(schema.appPasswords.userId, squatted.id));
    expect(appPws.every((p) => p.revokedAt !== null), "应用专用密码").toBe(true);

    // MFA 也是抢注者布下的,留着会把真正的人挡在门外。
    const row = (await userByEmail(VICTIM))!;
    expect(row.mfaEnabled, "MFA 开关").toBe(false);
    expect(row.mfaTotpSecret, "TOTP 密钥").toBeNull();
    expect(row.mfaBackupCodes, "备用码").toBeNull();

    // 「拒绝/换人要留一条管理员看得见的记录」。
    const audit = await db.select().from(schema.adminAuditLog);
    expect(audit.map((a) => a.action)).toContain("account.unverified_claim_evicted");
  });

  it("苹果对这个邮箱什么都没断言时，连认领都不许（不是「先认领再说」）", async () => {
    // 走不到第 2 步(没验过 / 私有转发 / 占位邮箱)的时候,原来的代码在第 3 步
    // 还有一次无条件认领 —— 同一个动作换了个入口。
    await openSite();
    await register(VICTIM, ATTACKER_PW);
    const squatted = (await userByEmail(VICTIM))!;

    const r = await appleLogin(VICTIM, "apple-unverified-sub", "false");
    expect(r.statusCode, r.body.slice(0, 300)).toBe(409);
    expect(r.statusCode, "401 会把 App 登出").not.toBe(401);
    // 那一行不许被打上 apple_sub,也不许多开一个号。
    const after = (await userByEmail(VICTIM))!;
    expect(after.appleSub).toBeNull();
    expect(after.id).toBe(squatted.id);
    expect(await userCount()).toBe(1);
  });

  it("**已验证**的账号不受影响：SSO 认领它不会把它的密码作废", async () => {
    // 这条是上面那组的反面。只测「作废」的话,把认领判定改成「永远作废」也全绿
    // —— 那不是堵洞,那是把「密码号首次绑 SSO」这个功能拆了。
    await openSite();
    await register(VICTIM, ATTACKER_PW);
    const row = (await userByEmail(VICTIM))!;
    // 这个号自己验过邮箱(网页注册那条路走完验证码就是这个状态)。
    await db.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.id, row.id));

    const r = await ssoLogin(app, sso, SLUG, { sub: "kc-owner", email: VICTIM, email_verified: true });
    expect(r.location).toBe("/app");
    // 密码照样能用 —— 他本来就是这个号的主人。
    expect((await login(VICTIM, ATTACKER_PW)).statusCode).toBe(200);
    const audit = await db.select().from(schema.adminAuditLog);
    expect(audit.map((a) => a.action)).not.toContain("account.unverified_claim_evicted");
  });
});

// ---------------------------------------------------------------------------
// 2. 老 SSO 用户不能被挡在门外
// ---------------------------------------------------------------------------
//
// user_identities 是 2026-06-17 才建的、**没有回填**,所以「三个月内没登过的
// SSO 用户」一行 identity 都没有;而企业 Keycloak 里管理员手工建的用户默认
// emailVerified=Off、LDAP 联邦用户没开 Trust Email 时也是 false、Entra ID 干脆
// 不发这个 claim。这三种组合缺一条都不算测过。

describe("老 SSO 用户：三种组合", () => {
  /** 造一个「以前用 SSO 登录过」的号。slug 传 null 表示这一列是空的。 */
  async function seedOldSsoUser(opts: { slug: string | null; identitySub?: string }) {
    const [u] = await db.insert(schema.users).values({
      email: VICTIM,
      emailVerified: true,          // 老代码无条件写 true,存量就是这个样子
      passwordHash: "$2a$12$3GVAJUNGYRfPaWdgnQ2yyOzcQGw.j6sHCk0i9JdRZ7JFqVfTXVfTC",
      ssoProviderSlug: opts.slug,
    }).returning();
    if (opts.identitySub) {
      await db.insert(schema.userIdentities).values({
        userId: u!.id, provider: SLUG, subject: opts.identitySub, email: VICTIM,
      });
    }
    return u!;
  }

  it("有 identity 行 + IdP 不发 email_verified → 正常登录", async () => {
    await openSite();
    const u = await seedOldSsoUser({ slug: null, identitySub: "old-sub" });
    const r = await ssoLogin(app, sso, SLUG, { sub: "old-sub", email: VICTIM });
    expect(r.location, `回调去了 ${r.location}`).toBe("/app");
    expect(r.sessionCookie).not.toBeNull();
    expect(await userCount()).toBe(1);
    expect((await userByEmail(VICTIM))!.id).toBe(u.id);
  });

  it("无 identity 行 + IdP 发 email_verified → 正常登录", async () => {
    await openSite();
    const u = await seedOldSsoUser({ slug: null });
    const r = await ssoLogin(app, sso, SLUG, { sub: "new-sub", email: VICTIM, email_verified: true });
    expect(r.location, `回调去了 ${r.location}`).toBe("/app");
    expect(r.sessionCookie).not.toBeNull();
    expect((await userByEmail(VICTIM))!.id).toBe(u.id);
  });

  it("无 identity 行 + IdP 不发 email_verified → **也要能登录**（这条是上一轮改动挡掉的）", async () => {
    await openSite();
    // 这一行上次就是从这个 IdP 进来的 —— ssoProviderSlug 记着,这本身就是凭据。
    const u = await seedOldSsoUser({ slug: SLUG });
    const r = await ssoLogin(app, sso, SLUG, { sub: "recreated-sub", email: VICTIM });
    expect(r.location, `回调去了 ${r.location}`).toBe("/app");
    expect(r.sessionCookie).not.toBeNull();
    expect((await userByEmail(VICTIM))!.id).toBe(u.id);
    // 顺手把新 sub 绑上,下次直接走 (provider, subject) 那一步。
    const ids = await db.select().from(schema.userIdentities).where(eq(schema.userIdentities.userId, u.id));
    expect(ids.map((i) => i.subject)).toContain("recreated-sub");
  });

  it("放开的只是那一格：没有这条历史的账号，IdP 不发 email_verified 时照样拒", async () => {
    await openSite();
    const u = await seedOldSsoUser({ slug: null });
    const r = await ssoLogin(app, sso, SLUG, { sub: "stranger-sub", email: VICTIM });
    expect(r.location.startsWith("/login?error=")).toBe(true);
    expect(r.sessionCookie, "被拒了还发了会话").toBeNull();
    // 也不许偷偷把 subject 绑上去(绑上了下次就无条件进得去了)。
    expect(await countRows("user_identities", u.id)).toBe(0);
  });

  it("被拒时给的是一句人话，不是键名", async () => {
    // flash.sso.linkInSettings 这个键在八个语言包里一个都没有,于是这句提示
    // 原样把键名印在登录页上。看起来「有提示」,实际用户看到的是一串点号。
    await openSite();
    await seedOldSsoUser({ slug: null });
    const r = await ssoLogin(app, sso, SLUG, { sub: "stranger-sub", email: VICTIM });
    const msg = r.location.replace("/login?error=", "");
    expect(msg).not.toContain("flash.sso.");
    expect(msg.length).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// 3. 外部 IdP 资源服务器那条路
// ---------------------------------------------------------------------------

describe("外部 IdP 普通用户令牌：按邮箱认到一行账号", () => {
  it("认到的是抢注形状的行 → 403，而且不是 401（401 会把 App 登出）", async () => {
    await openSiteWithIdpApi();
    await register(VICTIM, ATTACKER_PW);   // signup_source=self, email_verified=false

    const token = await apple.signServiceToken({ azp: apple.loginClient, email: VICTIM });
    const r = await app.inject({
      method: "GET", url: "/api/v1/calendars",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.statusCode, r.body.slice(0, 300)).toBe(403);
    expect(r.statusCode).not.toBe(401);
    expect(r.body).toContain("account_claim_unproven");
  });

  it("这一行验过邮箱就照常放行（这道判定不是「一律拒绝」）", async () => {
    await openSiteWithIdpApi();
    await register(VICTIM, ATTACKER_PW);
    const row = (await userByEmail(VICTIM))!;
    await db.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.id, row.id));

    const token = await apple.signServiceToken({ azp: apple.loginClient, email: VICTIM });
    const r = await app.inject({
      method: "GET", url: "/api/v1/calendars",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
  });

  it("这条路一个凭据都不作废（作废是真人登录才该做的事）", async () => {
    await openSiteWithIdpApi();
    await register(VICTIM, ATTACKER_PW);
    await login(VICTIM, ATTACKER_PW);
    const row = (await userByEmail(VICTIM))!;

    const token = await apple.signServiceToken({ azp: apple.loginClient, email: VICTIM });
    await app.inject({
      method: "GET", url: "/api/v1/calendars",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(await countRows("sessions", row.id)).toBe(1);
    expect((await login(VICTIM, ATTACKER_PW)).statusCode).toBe(200);
  });
});
