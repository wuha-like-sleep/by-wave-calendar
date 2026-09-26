// 同一个接口挂在 /api 和 /api/v1 两个前缀下，限流额度不能各算各的。
//
// 实测过：限每分钟 6 次的接口，换着两个前缀打能过 12 次。受影响的正是最怕被
// 猜的几条 —— 密码登录、两步验证的 6 位验证码、6 位配对码。
//
// 这里用**真的** deviceRoutes，按 server.ts 的样子挂两遍，接真的限流插件和
// 真的 store。只看状态码是不是 429：被限流拦下的请求根本进不了处理函数。

import { vi, beforeAll, afterEach, beforeEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
vi.mock("../../src/lib/mailer.js", () => ({
  sendMail: vi.fn(async () => ({ ok: true })), isMailerEnabled: vi.fn(async () => true),
}));

import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { readFileSync } from "node:fs";
import { ensureSchema, resetDb } from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";

const { deviceRoutes } = await import("../../src/routes/devices.js");
const { makeSharedRouteStore, rateLimitRouteKey } = await import("../../src/lib/rate_limit_store.js");

beforeAll(async () => { await ensureSchema(); });
let app: FastifyInstance;

async function build(shared: boolean) {
  const a = Fastify({ logger: false });
  await a.register(rateLimit, {
    global: true, max: 10_000, timeWindow: "1 minute", hook: "preHandler",
    keyGenerator: (req) => req.ip,
    ...(shared ? { store: makeSharedRouteStore() } : {}),
  });
  for (const prefix of ["/api", "/api/v1"]) await a.register(deviceRoutes, { prefix });
  await a.ready();
  return a;
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await app?.close(); });

/** 换着两个前缀连打 n 次，数有几次没被限流拦下。 */
async function passed(path: string, n: number, body: Record<string, unknown>) {
  let ok = 0;
  for (let i = 0; i < n; i++) {
    const res = await app.inject({ method: "POST", url: (i % 2 ? "/api" : "/api/v1") + path, payload: body });
    if (res.statusCode !== 429) ok++;
  }
  return ok;
}

const LOGIN = { email: "x@example.com", password: "wrong-password-1", label: "p", kind: "ios" };

describe("两个前缀共用一份限流额度", () => {
  it("不共用时确实会翻倍（presence —— 证明这组用例测得出翻倍）", async () => {
    app = await build(false);
    expect(await passed("/auth/login-password", 20, LOGIN), "测不出翻倍，下面那条就是空的").toBe(12);
  });

  it("**密码登录：换着前缀打也只有 6 次**（这条是核心）", async () => {
    app = await build(true);
    expect(
      await passed("/auth/login-password", 20, LOGIN),
      "换着 /api 和 /api/v1 打，猜密码的额度翻倍了",
    ).toBe(6);
  });

  it("两步验证码、配对码也一样", async () => {
    app = await build(true);
    expect(await passed("/auth/login-mfa-verify", 40, { mfaToken: "x", code: "000000" }),
      "6 位验证码的猜测额度翻倍了").toBe(12);
    expect(await passed("/devices/pair-claim", 60, { code: "ABC123", label: "p", kind: "ios" }),
      "6 位配对码的猜测额度翻倍了").toBe(20);
  });

  it("不同的接口各有各的额度，不能被搅到一起", async () => {
    // 共享表按「方法 + 路径」分开。少了这条，「所有接口共用一个计数器」的实现也会让上面几条绿。
    app = await build(true);
    await passed("/auth/login-password", 20, LOGIN);
    const r = await app.inject({ method: "POST", url: "/api/v1/auth/refresh", payload: { refreshToken: "x" } });
    expect(r.statusCode, "登录被限流之后连刷新令牌也被拦了 —— 计数器搅到一起了").not.toBe(429);
  });

  it("归一只去掉 /api/v1 的 v1，别的路径不动", () => {
    expect(rateLimitRouteKey("POST", "/api/v1/auth/login-password")).toBe(rateLimitRouteKey("POST", "/api/auth/login-password"));
    expect(rateLimitRouteKey("POST", "/api/v1x/foo")).not.toBe(rateLimitRouteKey("POST", "/api/x/foo"));
    expect(rateLimitRouteKey("GET", "/api/v1/x")).not.toBe(rateLimitRouteKey("POST", "/api/v1/x"));
  });

  it("server.ts 真的用上了共享 store", () => {
    const src = readFileSync("src/server.ts", "utf8");
    const block = src.slice(src.indexOf("await app.register(rateLimit"), src.indexOf("await app.register(rateLimit") + 1500);
    expect(block, "server.ts 的限流插件没接共享 store，线上仍然是翻倍的").toMatch(/store:\s*makeSharedRouteStore\(\)/);
  });
});
