// 后台「第三方 API」总闸对 OAuth 到底管不管用 —— 全程从 HTTP 打进去。
//
// 修之前的实情:站长在 /admin/api 关掉开关,页面写着「关闭后任何已签发的
// token 调用都会被拒(返回 401)」。bwc_ 那批 API token 确实停了
// (api_token.ts:169 开头就看这个开关),但 OAuth 签出去的 bwo_ token
// **完全不受影响** —— 照常读写日历,而且关着开关还能走完一次全新授权、
// 换到一个新的 30 天 token。止血阀只关了一半,而站长以为全关了。
//
// 为什么这一档必须从 HTTP 打:直调 verifyOAuthToken 看不见
// requireUserOrSend 这一层,也看不见授权端点自己有没有拦。本仓库为
// 「直调 lib 函数的测试结构上看不见路由自己多做了一件事」付过账。

import { vi, beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./security_harness.js");
  return { db: h.db, schema: h.schema };
});

// 唯一的 mock,且不是任何一道判定:登录成功会发「你刚登录了」的提醒信。
vi.mock("../../src/lib/mailer.js", () => ({
  isMailerEnabled: async () => true,
  sendMail: async () => ({ ok: true }),
}));

import Fastify, { type FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { ensureSchema, resetDb, db, schema, pg, applySettings } from "./security_harness.js";

let app: FastifyInstance;

const REDIRECT = "https://third-party.example.com/cb";

/** 挂上被测的全部路由。OAuth 授权端点在 web 层,受保护的业务接口在 /api/v1 下 ——
 *  两边都要在同一个实例里,否则「总闸关了但授权端点还能发新 token」这种
 *  跨层的形状就测不出来。 */
async function buildOAuthApp(): Promise<FastifyInstance> {
  const [{ env }, cookie, formbody, { authRoutes }, { calendarRoutes }, { oauthServerRoutes }] =
    await Promise.all([
      import("../../src/env.js"),
      import("@fastify/cookie"),
      import("@fastify/formbody"),
      import("../../src/routes/auth.js"),
      import("../../src/routes/calendars.js"),
      import("../../src/web/oauth_server.js"),
    ]);
  const a = Fastify({ logger: false });
  await a.register(cookie.default, { secret: env.SESSION_SECRET });
  await a.register(formbody.default);
  await a.register(authRoutes, { prefix: "/api/v1" });
  await a.register(calendarRoutes, { prefix: "/api/v1" });
  // 授权端点会 reply.view("error", ...) —— 这一档不关心渲染结果,只关心状态码,
  // 所以给一个最小的 view 实现,别为了跑测试把 EJS 整套拉起来。
  a.decorateReply("view", function (this: { code: (n: number) => unknown; send: (b: unknown) => unknown }, _tpl: string, _data: unknown) {
    return (this as unknown as { send: (b: unknown) => unknown }).send({ rendered: "error" });
  });
  await a.register(oauthServerRoutes);
  await a.ready();
  return a;
}

/** 建号 → 建 OAuth 客户端 → 走一次授权码交换,拿到一个真 token。
 *  全部是**布置**,不是断言;断言只看后面那几个 HTTP 请求的结果。 */
async function seedTokenHolder(scopes: string[] = ["read:events"]) {
  const { createOAuthClient, issueAuthorizationCode, exchangeCodeForToken } =
    await import("../../src/lib/oauth_server.js");
  const { hashPassword } = await import("../../src/lib/password.js");

  const [user] = await db.insert(schema.users).values({
    email: "holder@example.com",
    passwordHash: await hashPassword("Correct-Horse-9"),
    emailVerified: true,
  }).returning({ id: schema.users.id });

  const client = await createOAuthClient({
    name: "只读小工具",
    redirectUris: [REDIRECT],
    allowedScopes: scopes as never,
  });
  const code = await issueAuthorizationCode({
    clientId: client.id,
    userId: user!.id,
    redirectUri: REDIRECT,
    scopes,
    codeChallenge: null,
  });
  const res = await exchangeCodeForToken({
    code,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    redirectUri: REDIRECT,
  });
  if ("error" in res) throw new Error("布置失败,拿不到 token: " + res.error);
  return { userId: user!.id, client, accessToken: res.accessToken };
}

/** 再开一张授权码,用来测「总闸关着还能不能换新 token」。 */
async function freshCode(clientRowId: string, userId: string): Promise<string> {
  const { issueAuthorizationCode } = await import("../../src/lib/oauth_server.js");
  return issueAuthorizationCode({
    clientId: clientRowId, userId, redirectUri: REDIRECT,
    scopes: ["read:events"], codeChallenge: null,
  });
}

beforeAll(async () => {
  await ensureSchema();
  app = await buildOAuthApp();
});

afterAll(async () => {
  await app?.close();
  await pg?.close();
});

beforeEach(async () => {
  await resetDb();
});

describe("API 总闸必须同时管住 OAuth", () => {
  it("开关开着时,bwo_ token 能正常访问接口（presence —— 没有这条,下面那条会因为『本来就不通』而假绿）", async () => {
    await applySettings({ apiEnabled: true });
    const { accessToken } = await seedTokenHolder();

    const res = await app.inject({
      method: "GET", url: "/api/v1/calendars",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode, `开着都不通的话,这一档什么也没测到。响应: ${res.body.slice(0, 200)}`).toBe(200);
  });

  it("关掉开关之后,同一个 token 立刻被拒（401）", async () => {
    await applySettings({ apiEnabled: true });
    const { accessToken } = await seedTokenHolder();
    // 先确认它本来是通的 —— 同一个 token、同一个请求,只差一个开关。
    const before = await app.inject({
      method: "GET", url: "/api/v1/calendars",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(before.statusCode).toBe(200);

    await applySettings({ apiEnabled: false });

    const after = await app.inject({
      method: "GET", url: "/api/v1/calendars",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(
      after.statusCode,
      "后台文案承诺「任何已签发的 token 调用都会被拒(返回 401)」。bwc_ 那批一直是这样,bwo_ 以前不是。",
    ).toBe(401);
  });

  it("关掉开关之后,不能再换到新 token（否则「关闭」只是「旧的不认、新的照发」）", async () => {
    await applySettings({ apiEnabled: true });
    const { client, userId } = await seedTokenHolder();
    const code = await freshCode(client.id, userId);

    await applySettings({ apiEnabled: false });

    const res = await app.inject({
      method: "POST", url: "/oauth/token",
      payload: {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: client.clientId,
        client_secret: client.clientSecret,
      },
    });
    expect(res.statusCode, "总闸关着还能换到新 token").toBe(503);
    expect(String(res.body)).not.toContain("bwo_");
  });

  it("关掉开关之后,同意页不再出现（用户点不到那个「允许」）", async () => {
    await applySettings({ apiEnabled: true });
    const { client } = await seedTokenHolder();

    await applySettings({ apiEnabled: false });

    const res = await app.inject({
      method: "GET",
      url: `/oauth/authorize?client_id=${encodeURIComponent(client.clientId)}`
        + `&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&scope=read%3Aevents`,
    });
    expect(res.statusCode, "总闸关着,授权页还能打开").toBe(503);
  });

  it("但关掉开关之后,用户仍然能撤销自己已经授出去的授权", async () => {
    // 这条和上面几条方向相反,而且同样重要:如果撤销也跟着总闸一起停,
    // 站长一关总闸,用户就再也收不回已经授出去的东西 ——
    // 等于把止血阀和善后手段绑死在同一个开关上。
    await applySettings({ apiEnabled: true });
    const { accessToken } = await seedTokenHolder();

    await applySettings({ apiEnabled: false });

    const res = await app.inject({
      method: "POST", url: "/oauth/revoke",
      payload: { token: accessToken },
    });
    expect(res.statusCode).toBe(200);

    // 断言落在库里那一行上,不看状态码 —— /oauth/revoke 对任何输入都回 200
    // (免得变成一个「这个 token 存不存在」的探测器),所以状态码证明不了任何事。
    const rows = await db.select({ revokedAt: schema.oauthAccessTokens.revokedAt })
      .from(schema.oauthAccessTokens);
    expect(rows.length, "布置就没建出 token,这条断言是空的").toBe(1);
    expect(rows[0]!.revokedAt, "总闸关着时撤销没有真的落库").not.toBeNull();
  });

  it("总闸只管 OAuth 和 API token,不碰浏览器会话（站长自己还得能登录后台去把它打开）", async () => {
    await applySettings({ apiEnabled: false });
    const { hashPassword } = await import("../../src/lib/password.js");
    await db.insert(schema.users).values({
      email: "admin@example.com",
      passwordHash: await hashPassword("Correct-Horse-9"),
      emailVerified: true,
      isAdmin: true,
    });

    const res = await app.inject({
      method: "POST", url: "/api/v1/auth/login",
      payload: { email: "admin@example.com", password: "Correct-Horse-9" },
    });
    expect(
      res.statusCode,
      "总闸关着把密码登录也一起关了 —— 那样站长就再也进不去后台把它打开",
    ).toBe(200);
    expect(String(res.headers["set-cookie"] ?? ""), "没有下发会话 cookie").toContain("bwc_sid");
  });
});
