// 「认领已有账号」这一档专用的工装。
//
// 为什么又另起一份:security_harness.ts 的假 IdP 只发**发现文档 + JWKS**,够
// external_idp.ts 那条资源服务器的路用(它只验令牌签名),但浏览器 SSO 回调
// 要真的走完 authorization_code:先 POST /token 换令牌,再 GET /userinfo 拿
// claim。这两个端点那边是 404。所以这里补一台会说这两句话的假 Keycloak,
// 其余全部**复用** security_harness 的那份(同一个 PGlite、同一套建表 / 清表、
// 同一个 applySettings),不另开一份数据库。
//
// ===================== 为什么一定要从 HTTP 打进去 =====================
// 本仓库为「直调 lib 函数的测试结构上看不见路由自己多做了一件事」付过账:
// 封禁那次 30 条单元测试全绿,而后台真实路径是坏的。所以抢注链那条断言是
// 真 Fastify 实例 + 真路由 + app.inject() 发真请求,落点在 users / sessions
// 这些真表上。
//
// ===================== 这份工装**复刻不了**什么 =====================
// 和 security_harness 一样:server.ts 挂的全局 rate limit、helmet、CSRF 钩子、
// onResponse 审计、注入 view locals 的 preHandler 都不在。所以会渲染模板的
// 路径测不了,下面用到的全是 redirect / JSON 的路径。

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";

import { db, schema } from "./security_harness.js";

export {
  pg, db, schema,
  ensureSchema, resetDb,
  applySettings, userCount, userEmails,
  csrfToken, form,
  startFakeIdp, seedIdpProvider, APPLE_CLIENT_ID,
  type FakeIdp,
} from "./security_harness.js";

// ---------------------------------------------------------------------------
// 真 Fastify 实例(比 security_harness 的那个多挂一个 ssoRoutes)
// ---------------------------------------------------------------------------

/**
 * 挂 auth / devices / calendars / web / **sso** 五组路由的真实例。
 *
 * 不复用 security_harness.buildApp():那个文件这一轮不归我改,而浏览器 SSO
 * 回调必须挂上 ssoRoutes 才测得到。cookie 的 secret 同样用 env.SESSION_SECRET
 * —— csrfTokenFor() 拿它算 HMAC,换成别的串所有 POST 都会停在 403 上,
 * 测试会「红得很有道理」,但根本没走到被测的判定。
 */
export async function buildClaimApp(): Promise<FastifyInstance> {
  // 全部动态 import:这些模块会 import src/db/client.js,而那是测试文件
  // vi.mock 成 PGlite 的。静态 import 会在本模块求值到一半时绕回来。
  const [{ env }, cookie, formbody, { authRoutes }, { deviceRoutes }, { calendarRoutes }, { webRoutes }, { ssoRoutes }] =
    await Promise.all([
      import("../../src/env.js"),
      import("@fastify/cookie"),
      import("@fastify/formbody"),
      import("../../src/routes/auth.js"),
      import("../../src/routes/devices.js"),
      import("../../src/routes/calendars.js"),
      import("../../src/web/index.js"),
      import("../../src/web/sso.js"),
    ]);

  const app = Fastify({ logger: false });
  await app.register(cookie.default, { secret: env.SESSION_SECRET });
  await app.register(formbody.default);
  await app.register(authRoutes, { prefix: "/api/v1" });
  await app.register(deviceRoutes, { prefix: "/api/v1" });
  await app.register(calendarRoutes, { prefix: "/api/v1" });
  await app.register(webRoutes);
  await app.register(ssoRoutes);
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// 会说完整 authorization_code 的假 Keycloak
// ---------------------------------------------------------------------------

export type SsoIdp = {
  issuer: string;
  clientId: string;
  /**
   * 预置一次登录:返回一个授权码。回调带着它进来时,/token 换出一个不透明的
   * 访问令牌,/userinfo 原样吐出这里给的 claim。
   *
   * 注意 emailVerified 传的是**原始 claim**(true / "true" / false / undefined),
   * 不是布尔化之后的结果 —— 「字段干脆不发」和「发了个 false」是两种不同的
   * IdP 行为,而这一档要分别测它们。
   */
  authorize(claims: { sub: string; email: string; email_verified?: unknown; name?: string }): string;
  close(): Promise<void>;
};

/** 起一台本地 HTTP 服务器冒充 Keycloak:发现文档 + /token + /userinfo。 */
export async function startSsoIdp(clientId = "bywave-web"): Promise<SsoIdp> {
  const pending = new Map<string, Record<string, unknown>>();
  let issuer = "";
  let seq = 0;

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
    if (url.startsWith("/token")) {
      // 授权码就在表单体里。真 Keycloak 会校验 client_secret / PKCE,这台不校验
      // —— 被测的是**我们这边**拿到 claim 之后怎么认账号,不是 OIDC 协议本身。
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const code = new URLSearchParams(body).get("code") ?? "";
        if (!pending.has(code)) {
          res.writeHead(400, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: "invalid_grant" }));
        }
        // 访问令牌就用授权码本身,/userinfo 靠它找回 claim。
        json({ access_token: code, token_type: "Bearer", expires_in: 300 });
      });
      return;
    }
    if (url.startsWith("/userinfo")) {
      const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const claims = pending.get(token);
      if (!claims) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "invalid_token" }));
      }
      return json(claims);
    }
    if (url.startsWith("/jwks")) return json({ keys: [] });
    res.writeHead(404).end("no");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    issuer,
    clientId,
    authorize(claims) {
      const code = `code-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
      const payload: Record<string, unknown> = { sub: claims.sub, email: claims.email };
      // 「字段干脆不发」必须是真的不发,不能发一个 undefined —— JSON 里那是
      // 两件事,而 idpEmailVerified 判的就是「字段在不在」。
      if ("email_verified" in claims && claims.email_verified !== undefined) {
        payload.email_verified = claims.email_verified;
      }
      if (claims.name) payload.name = claims.name;
      pending.set(code, payload);
      return code;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** 往 sso_providers 写一行指向上面那台服务器的 provider,并清掉发现缓存。 */
export async function seedSsoProvider(idp: SsoIdp, slug = "keycloak"): Promise<void> {
  await db.insert(schema.ssoProviders).values({
    slug,
    issuerUrl: idp.issuer,
    clientId: idp.clientId,
    clientSecret: "test-secret",
    label: "Keycloak",
    enabled: true,
  });
  // 发现文档缓存是模块级的:TRUNCATE 之后不清就会拿着上一条用例那台服务器的
  // 地址接着用(端口每次都不一样,于是整组静默走进 catch 分支)。
  const [{ resetOidcCache }, { resetExternalIdpCache }] = await Promise.all([
    import("../../src/lib/sso.js"),
    import("../../src/lib/external_idp.js"),
  ]);
  resetOidcCache();
  resetExternalIdpCache();
}

// ---------------------------------------------------------------------------
// 走一遍浏览器 SSO 登录
// ---------------------------------------------------------------------------

export type SsoLoginResult = {
  /** 回调的响应状态(成功是 302)。 */
  status: number;
  /** 回调把人送去哪儿。成功 → /app;失败 → /login?error=…(已解码)。 */
  location: string;
  /** 回调有没有真的发下来一个会话 cookie。 */
  sessionCookie: string | null;
};

/**
 * 从 GET /auth/idp/:slug/login 开始,一路走到 GET /auth/idp/callback。
 *
 * state 是从第一步下发的 cookie 里解出来的(跟浏览器做的事一模一样),不是
 * 测试自己编的 —— 编的话就把 state 校验那道门一起绕过去了。
 */
export async function ssoLogin(
  app: FastifyInstance,
  idp: SsoIdp,
  slug: string,
  claims: { sub: string; email: string; email_verified?: unknown; name?: string },
): Promise<SsoLoginResult> {
  const start = await app.inject({ method: "GET", url: `/auth/idp/${encodeURIComponent(slug)}/login` });
  const raw = start.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const stateCookie = cookies.map(String).find((c) => c.startsWith("bwc_sso_state="));
  if (!stateCookie) {
    throw new Error(`SSO 登录入口没有下发 state cookie:${start.statusCode} ${String(start.headers.location ?? start.body).slice(0, 200)}`);
  }
  const value = decodeURIComponent(stateCookie.split(";")[0]!.split("=").slice(1).join("="));
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { state: string };

  const code = idp.authorize(claims);
  const cb = await app.inject({
    method: "GET",
    url: `/auth/idp/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(parsed.state)}`,
    headers: { cookie: `bwc_sso_state=${encodeURIComponent(value)}` },
  });
  const setCookies = ((): string[] => {
    const h = cb.headers["set-cookie"];
    return Array.isArray(h) ? h.map(String) : h ? [String(h)] : [];
  })();
  return {
    status: cb.statusCode,
    location: decodeURIComponent(String(cb.headers.location ?? "")),
    sessionCookie: setCookies.find((c) => c.startsWith("bwc_sid=") && !c.includes("Max-Age=0")) ?? null,
  };
}

// ---------------------------------------------------------------------------
// 直接读表的小助手
// ---------------------------------------------------------------------------

export async function userByEmail(email: string) {
  const { eq } = await import("drizzle-orm");
  const [u] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  return u;
}
