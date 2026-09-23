// 匿名引导接口能不能过 CSRF 闸门 —— 装真钩子、打真路由。
//
// ── 这条的形状 ────────────────────────────────────────────────────────
//
// /api/* 的写请求要带 X-CSRF-Token，除非①走 Bearer，或②在豁免名单里。
// 匿名引导接口属于②：那会儿还没有会话可保护，凭据是请求体里那个一次性的
// 东西（密码、配对码、上一步发的 mfaToken、Apple 的 identityToken）。
//
// 名单漏了两条，线上实测：
//   POST /api/v1/auth/login-mfa-verify → 403 csrf_invalid
//   POST /api/v1/auth/apple            → 403 csrf_invalid
// 也就是说**凡是开了两步验证的人，在 iOS / 安卓 / 桌面端一个都登不进来**：
// 第一步输密码拿到 mfaToken，第二步输验证码，服务端在进路由之前就把它 403 了。
// 「通过 Apple 登录」同理，从来没成功过。
//
// 而整套测试全绿 —— 因为这个钩子原来写在 server.ts 顶层，集成测试都是自己
// 拼实例、只注册被测的那几个路由，钩子根本不在场。现在它是一个模块，
// 这个文件把它装到真实的 auth 路由上，从 HTTP 打进去。
//
// 反过来的风险同样要守：往名单里多塞一条读 cookie 的路，就是真把 CSRF 关了。
// 所以下面既有「该放行的放行」，也有「该拦的仍然拦」。

import { vi, beforeAll, beforeEach, afterEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
vi.mock("../../src/lib/mailer.js", () => ({
  sendMail: vi.fn(async () => ({ ok: true })),
  isMailerEnabled: vi.fn(async () => true),
}));

import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { ensureSchema, resetDb } from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";

const { authRoutes } = await import("../../src/routes/auth.js");
const { eventRoutes } = await import("../../src/routes/events.js");
const { registerApiCsrf } = await import("../../src/lib/api_csrf.js");

beforeAll(async () => { await ensureSchema(); });

let app: FastifyInstance;

beforeEach(async () => {
  await resetDb();
  // 和生产一致：同一批路由挂在 /api 和 /api/v1 两个前缀下，钩子装在最外层。
  // 这里不用 buildRoutedApp —— 它内部已经 ready() 了，而钩子必须在注册路由之前装上。
  app = Fastify({ logger: false });
  await app.register(cookie, { secret: "integration-test-cookie-secret-32-chars-min" });
  registerApiCsrf(app);
  for (const prefix of ["/api", "/api/v1"]) {
    await app.register(async (s) => { await authRoutes(s); await eventRoutes(s); }, { prefix });
  }
  await app.ready();
});
afterEach(async () => { await app?.close(); });

function post(url: string, payload: unknown = {}) {
  return app.inject({ method: "POST", url, payload });
}
/** 被 CSRF 闸门拦下来的特征。路由自己的校验错（400 bad_request）不算。 */
async function blockedByCsrf(url: string): Promise<boolean> {
  const res = await post(url);
  return res.statusCode === 403 && /csrf/i.test(res.body);
}

// 匿名引导接口：还没有会话，凭据在请求体里。
const ANONYMOUS_BOOTSTRAP = [
  "/api/v1/auth/login-password",
  "/api/v1/auth/login-mfa-verify",
  "/api/v1/auth/apple",
  "/api/v1/auth/refresh",
  "/api/v1/devices/pair-claim",
  "/api/v1/devices/desktop-pair-init",
  "/api/v1/devices/web-pair-init",
];

describe("CSRF 闸门不能挡住匿名登录", () => {
  it("闸门确实装上了：一条要会话的写接口仍然被 403（presence）", async () => {
    // 少了这条，下面所有「没被 CSRF 拦」的断言在「钩子根本没装」时也全绿 ——
    // 那正是这个 bug 能活到线上的原因。
    expect(
      await blockedByCsrf("/api/v1/events"),
      "连要会话的写接口都没被拦 —— 说明这个实例上闸门根本没生效，下面的断言全是空的",
    ).toBe(true);
  });

  it.each(ANONYMOUS_BOOTSTRAP)("%s 不该被 CSRF 拦", async (url) => {
    expect(
      await blockedByCsrf(url),
      `${url} 是匿名引导接口，凭据在请求体里、不靠 cookie，却被 CSRF 闸门 403 了。` +
        "对用户来说就是这条路彻底不通，而且报错完全看不懂。",
    ).toBe(false);
  });

  it("**开了两步验证的人登得进来**（这条是这个文件的核心）", async () => {
    // 第一步 login-password 回 mfaToken，第二步 login-mfa-verify 交验证码。
    // 第二步被拦 = 在三个 App 上一个都登不进来。
    expect(
      await blockedByCsrf("/api/v1/auth/login-mfa-verify"),
      "第二步的 MFA 校验被 CSRF 挡住 —— 凡是开了两步验证的用户，" +
        "在 iOS / 安卓 / 桌面端全都登不进来。第一步输完密码，第二步输验证码就是一个 403。",
    ).toBe(false);
  });

  it("两个前缀行为一致（/api 和 /api/v1 挂的是同一批路由）", async () => {
    for (const p of ["/api/auth/login-mfa-verify", "/api/v1/auth/login-mfa-verify"]) {
      expect(await blockedByCsrf(p), `${p} 被拦了`).toBe(false);
    }
  });

  it("该拦的仍然拦：带会话 cookie 的写请求没有 token 一律 403", async () => {
    for (const u of ["/api/v1/events", "/api/v1/calendars", "/api/v1/booking-links"]) {
      expect(await blockedByCsrf(u), `${u} 没被拦 —— 名单放得太宽，CSRF 形同虚设`).toBe(true);
    }
  });

  it("豁免名单里不许出现读 cookie 的路", async () => {
    // 名单是人手维护的，最容易的出错方式是「为了让某个报错消失」往里加一条。
    const { API_CSRF_EXEMPT_PATHS } = await import("../../src/lib/api_csrf.js");
    const mustNeverBeExempt = [
      "/api/v1/events", "/api/v1/calendars", "/api/v1/booking-links",
      "/api/v1/account/delete", "/api/v1/account/password",
      "/api/v1/account/mfa/disable", "/api/v1/auth/logout",
      "/api/v1/devices/pair-init",
    ];
    for (const p of mustNeverBeExempt) {
      expect(
        API_CSRF_EXEMPT_PATHS.has(p),
        `${p} 被放进了 CSRF 豁免名单 —— 这条路是读会话 cookie 的，豁免它等于关掉 CSRF`,
      ).toBe(false);
    }
  });
});
