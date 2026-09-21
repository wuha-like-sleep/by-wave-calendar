// 建号安全断言专用的 PGlite + 真 HTTP 工装。
//
// 为什么另起一份而不是加进 test/integration/harness.ts:那个文件这一轮有另一个
// 进程在改。两个进程往同一个文件里加东西,合并的时候谁都说不清哪一半是自己的。
// 写法照抄它(同样是 PGlite + drizzle + 按迁移文件建表 + TRUNCATE 重置),但这是
// 独立的一份实例,和它互不影响。
//
// ===================== 这份工装为什么必须从 HTTP 打进去 =====================
// 直调收口函数的测试**结构上看不见**「路由自己多做了一件事」。本仓库为这件事
// 付过账:封禁那次 30 条单元测试全绿,而后台真实路径是坏的 —— 坏就坏在路由里,
// 测试从来没走过路由。所以下面的断言一律是:真 Fastify 实例 + 真路由插件 +
// app.inject() 发真请求 + 事后去 users 表数行。
//
// ===================== 这份工装**复刻不了**什么 =====================
// src/server.ts 是一个 top-level await 的副作用脚本,import 的一瞬间就去连真库、
// 监听端口、拉起 cron,所以这里只能把路由插件单独挂起来。跟着丢掉的有:
//   · 全局 rate limit(@fastify/rate-limit)—— 限流的断言不能用这套工装
//   · helmet / CSP
//   · onResponse 的取证审计钩子(P5 那条)
//   · 注入 view locals 的 preHandler —— 所以**会渲染模板的路径测不了**,
//     下面用到的都是 redirect / JSON 的路径。
// 这几条不是「懒得做」,是这套工装的边界。要测它们得另想办法,别在这里假装覆盖。

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { createHmac, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type JWK, type CryptoKey } from "jose";
import Fastify, { type FastifyInstance } from "fastify";
import * as schema from "../../src/db/schema.js";

export const pg = new PGlite();
export const db = drizzle(pg, { schema });
export { schema };

let migrated = false;

/** 按迁移文件建全表(幂等)。 */
export async function ensureSchema(): Promise<void> {
  if (migrated) return;
  const dir = "drizzle/migrations";
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const sql = readFileSync(`${dir}/${f}`, "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      const t = stmt.trim();
      if (t) await pg.exec(t);
    }
  }
  migrated = true;
}

/** 每条用例之间清空所有表。 */
export async function resetDb(): Promise<void> {
  await pg.exec(
    `DO $$ DECLARE r RECORD; BEGIN
       FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname='public') LOOP
         EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' RESTART IDENTITY CASCADE';
       END LOOP;
     END $$;`,
  );
}

// ---------------------------------------------------------------------------
// 站点设置
// ---------------------------------------------------------------------------

export type GateSetup = {
  registrationMode?: "closed" | "public" | "invite";
  signupDomainAllowlist?: string;
  signupDailyQuota?: number;
  apiEnabled?: boolean;
  idpApiEnabled?: boolean;
  idpApiServiceClients?: string;
  idpApiAutoProvision?: boolean;
  /** 网页注册那条路的人机验证。测试里一律 none —— PoW 是另一件事,不在这一档的射程里。 */
  captchaProvider?: string;
};

/**
 * 写 site_settings 第 1 行并清掉进程内缓存。
 *
 * 必须走真表 + reloadSettings():被测代码读的是 getSettings(),而那是带缓存的。
 * 直接 mock getSettings 的话,「路由自己又读了一次设置」这种事就看不见了 ——
 * 而那正是这一档要防的形状。
 */
export async function applySettings(gates: GateSetup = {}): Promise<void> {
  const { reloadSettings } = await import("../../src/lib/site_settings.js");
  await db.insert(schema.siteSettings).values({
    id: 1,
    registrationMode: gates.registrationMode ?? "public",
    signupDomainAllowlist: gates.signupDomainAllowlist ?? "",
    signupDailyQuota: gates.signupDailyQuota ?? 0,
    apiEnabled: gates.apiEnabled ?? true,
    idpApiEnabled: gates.idpApiEnabled ?? true,
    idpApiServiceClients: gates.idpApiServiceClients ?? "",
    idpApiAutoProvision: gates.idpApiAutoProvision ?? true,
    captchaProvider: gates.captchaProvider ?? "none",
  }).onConflictDoUpdate({
    target: schema.siteSettings.id,
    set: {
      registrationMode: gates.registrationMode ?? "public",
      signupDomainAllowlist: gates.signupDomainAllowlist ?? "",
      signupDailyQuota: gates.signupDailyQuota ?? 0,
      apiEnabled: gates.apiEnabled ?? true,
      idpApiEnabled: gates.idpApiEnabled ?? true,
      idpApiServiceClients: gates.idpApiServiceClients ?? "",
      idpApiAutoProvision: gates.idpApiAutoProvision ?? true,
      captchaProvider: gates.captchaProvider ?? "none",
    },
  });
  reloadSettings();
}

/** users 表当前有多少行。所有断言最终都落在这个数字上 —— 状态码可能是别的原因给的。 */
export async function userCount(): Promise<number> {
  const r = await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM users");
  return Number(r.rows[0]?.n ?? 0);
}

export async function userEmails(): Promise<string[]> {
  const r = await pg.query<{ email: string }>("SELECT email FROM users ORDER BY email");
  return r.rows.map((x) => x.email);
}

// ---------------------------------------------------------------------------
// 真 Fastify 实例
// ---------------------------------------------------------------------------

/**
 * 把被测的路由插件挂进一个真实例。
 *
 * cookie 的 secret 用 env.SESSION_SECRET **不是**随便一个串:csrfTokenFor() 拿它
 * 算 HMAC,下面 csrfToken() 要算出同一个值。用别的 secret 的话 CSRF 永远对不上,
 * 于是所有 POST 都停在 403 上 —— 测试会「红得很有道理」,但它根本没走到闸门。
 */
export async function buildApp(): Promise<FastifyInstance> {
  // 全部动态 import:这些模块会 import src/db/client.js,而那是被测试文件
  // vi.mock 成本文件的。静态 import 会在本模块求值到一半时绕回来。
  const [{ env }, cookie, formbody, { authRoutes }, { accountRoutes }, { deviceRoutes }, { calendarRoutes }, { webRoutes }] =
    await Promise.all([
      import("../../src/env.js"),
      import("@fastify/cookie"),
      import("@fastify/formbody"),
      import("../../src/routes/auth.js"),
      import("../../src/routes/accounts.js"),
      import("../../src/routes/devices.js"),
      import("../../src/routes/calendars.js"),
      import("../../src/web/index.js"),
    ]);

  const app = Fastify({ logger: false });
  await app.register(cookie.default, { secret: env.SESSION_SECRET });
  await app.register(formbody.default);
  // 和 server.ts 一样挂在 /api/v1 下。路径写错会让请求落到 404,而 404 也是
  // 「没建号」—— 所以每条用例都另外断言了状态码不是 404。
  await app.register(authRoutes, { prefix: "/api/v1" });
  await app.register(accountRoutes, { prefix: "/api/v1" });
  await app.register(deviceRoutes, { prefix: "/api/v1" });
  await app.register(calendarRoutes, { prefix: "/api/v1" });
  await app.register(webRoutes);
  await app.ready();
  return app;
}

/** 匿名访客的 CSRF 令牌 —— 跟 csrfTokenFor() 在没有会话 cookie 时算的是同一个值。 */
export async function csrfToken(): Promise<string> {
  const { env } = await import("../../src/env.js");
  return createHmac("sha256", env.SESSION_SECRET).update("anonymous").digest("hex");
}

/**
 * 表单 POST 的 payload + 头,和浏览器发出来的一样。
 *
 * extra 这个参数踩过一次:原来的写法是
 *   inject({ headers: { cookie }, ...form(...) })
 * 对象展开在后面,把 headers 整个换成了 content-type —— cookie 被悄悄丢掉,
 * 于是 POST /verify-email 走进「没有待验证邮箱」那一支,重定向回 /register。
 * 看起来像是闸门拦住了,其实请求根本没到闸门。头必须在这里合并,不给调用方
 * 留下那个坑。
 */
export function form(
  fields: Record<string, string>,
  extra: Record<string, string> = {},
): { payload: string; headers: Record<string, string> } {
  return {
    payload: new URLSearchParams(fields).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", ...extra },
  };
}

// ---------------------------------------------------------------------------
// 假装成 Keycloak:一台真的本地 HTTP 服务器
// ---------------------------------------------------------------------------
//
// 这里**没有 mock 掉任何校验**。起一台真 http 服务器,发 OIDC 发现文档和真的
// JWKS,provider 行的 issuer 指向它,令牌是用对应私钥真签的 RS256 JWT。
// external_idp.ts 里那一串判定(iss 匹配、JWKS 验签、alg 钉死、typ!=ID、
// azp/aud 授权方)全程照跑。换句话说:我们扮演的是 IdP,不是扮演校验结果。
//
// 苹果那条路的 JWKS 也从这台服务器出(见 appleJwksPath)—— 因为 apple_signin.ts
// 把 issuer 和 JWKS 地址写死成 appleid.apple.com,只能在 fetch 那一层改道。
// 改道的只是「去哪儿拿公钥」,签名验证、iss、aud、alg、exp 一条没少。

export type FakeIdp = {
  issuer: string;
  /** 受信任服务客户端的 client id。 */
  serviceClient: string;
  /** 登录客户端(普通用户令牌的 azp)。 */
  loginClient: string;
  /** 签一个服务客户端的访问令牌。 */
  signServiceToken(extra?: Record<string, unknown>): Promise<string>;
  /** 签一个苹果 identity token(iss/aud 按 apple_signin.ts 的要求填)。 */
  signAppleToken(claims: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
};

export const APPLE_CLIENT_ID = "cn.bywave.calendar.test";
const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";

let originalFetch: typeof globalThis.fetch | null = null;

export async function startFakeIdp(): Promise<FakeIdp> {
  const idpKeys = await generateKeyPair("RS256", { extractable: true });
  const appleKeys = await generateKeyPair("RS256", { extractable: true });
  const idpJwk: JWK = { ...(await exportJWK(idpKeys.publicKey)), kid: "idp-1", alg: "RS256", use: "sig" };
  const appleJwk: JWK = { ...(await exportJWK(appleKeys.publicKey)), kid: "apple-1", alg: "RS256", use: "sig" };

  let issuer = "";
  const server: Server = createServer((req, res) => {
    const url = String(req.url ?? "");
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.startsWith("/.well-known/openid-configuration")) {
      return json({
        issuer,
        jwks_uri: `${issuer}/jwks`,
        authorization_endpoint: `${issuer}/auth`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
      });
    }
    if (url.startsWith("/jwks")) return json({ keys: [idpJwk] });
    if (url.startsWith("/apple-jwks")) return json({ keys: [appleJwk] });
    res.writeHead(404).end("no");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  issuer = `http://127.0.0.1:${port}`;

  // 只给苹果那一个 URL 改道,其余原样走真 fetch(上面那台服务器就是靠真 fetch
  // 被访问到的)。**不要**把整个 fetch 换成假的:那样 IdP 那条路的验签也就成了
  // 摆设,而那条路本来是能真测的。
  if (!originalFetch) originalFetch = globalThis.fetch;
  const real = originalFetch;
  type FetchInput = Parameters<typeof fetch>[0];
  type FetchInit = Parameters<typeof fetch>[1];
  globalThis.fetch = ((input: FetchInput, init?: FetchInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (href === APPLE_JWKS_URL) return real(`${issuer}/apple-jwks`, init);
    return real(input, init);
  }) as typeof globalThis.fetch;

  const sign = async (key: CryptoKey, kid: string, claims: Record<string, unknown>): Promise<string> =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuedAt()
      .setExpirationTime("10m")
      .setJti(randomUUID())
      .sign(key);

  return {
    issuer,
    serviceClient: "meeting-platform",
    loginClient: "bywave-web",
    async signServiceToken(extra = {}) {
      return sign(idpKeys.privateKey, "idp-1", {
        iss: issuer,
        sub: "service-account-meeting-platform",
        azp: "meeting-platform",
        aud: "account",
        typ: "Bearer",
        ...extra,
      });
    },
    async signAppleToken(claims) {
      return sign(appleKeys.privateKey, "apple-1", {
        iss: APPLE_ISSUER,
        aud: APPLE_CLIENT_ID,
        ...claims,
      });
    },
    async close() {
      if (originalFetch) { globalThis.fetch = originalFetch; originalFetch = null; }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** 往 sso_providers 里写一行指向上面那台服务器的 provider,并清掉相关缓存。 */
export async function seedIdpProvider(idp: FakeIdp, slug = "keycloak"): Promise<void> {
  await db.insert(schema.ssoProviders).values({
    slug,
    issuerUrl: idp.issuer,
    clientId: idp.loginClient,
    clientSecret: "test-secret",
    label: "Keycloak",
    enabled: true,
  });
  // provider 列表、OIDC 发现、JWKS 三个缓存都是模块级的,TRUNCATE 之后不清就会
  // 拿着上一条用例的东西接着用(而上一条用例可能连 provider 行都没有)。
  const [{ resetExternalIdpCache }, { resetOidcCache }] = await Promise.all([
    import("../../src/lib/external_idp.js"),
    import("../../src/lib/sso.js"),
  ]);
  resetExternalIdpCache();
  resetOidcCache();
}

// ---------------------------------------------------------------------------
// 网页注册:替用户「收邮件」
// ---------------------------------------------------------------------------

/**
 * 把 email_verifications 那一行的验证码换成一个已知值。
 *
 * 这一步替代的是**用户的收件箱**,不是任何一道闸门:POST /register 已经真的
 * 跑完了(策略、域名、邀请码、honeypot、同意条款、密码策略、人机验证全走过),
 * pending 行里的 payload 是它写的;这里只是把「他从邮件里读到了什么」这件事
 * 变成可知的。随后的 POST /verify-email 照常走真 verifyCode + 真收口函数。
 */
export async function forceVerificationCode(email: string, code = "123456"): Promise<boolean> {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(code).digest("hex");
  const r = await pg.query<{ email: string }>(
    "UPDATE email_verifications SET code_hash = $1 WHERE email = $2 RETURNING email",
    [hash, email],
  );
  return r.rows.length === 1;
}

export async function pendingVerificationCount(): Promise<number> {
  const r = await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM email_verifications");
  return Number(r.rows[0]?.n ?? 0);
}
