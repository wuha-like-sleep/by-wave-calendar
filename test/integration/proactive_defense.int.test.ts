// 主动防御第一批的留痕断言：Token 验证失败 / 登录失败 / 限流触发，
// 都要按窗口采样写进 admin_audit_log —— 而且**不能**一条失败写一行
// （量由攻击者决定，全量写等于把留痕机制变成打爆存储的工具）。
//
// 采样口径（lib/security_events.ts）：10 分钟窗口内跨里程碑（1、10、…）
// 才写一行，每行 failures 是自上一行以来的增量，SUM 起来仍是精确总数。

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
process.env.DATABASE_URL ??= "postgres://unused:unused@localhost:5432/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";

import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { eq } from "drizzle-orm";
import { ensureSchema, resetDb, makeUser, buildRoutedApp } from "./harness.js";
import { db, schema } from "../../src/db/client.js";
import { createApiToken } from "../../src/lib/api_token.js";
import { hashPassword } from "../../src/lib/password.js";
import { getSettings, reloadSettings, updateSettings } from "../../src/lib/site_settings.js";
import {
  recordApiTokenAuthFailure,
  recordLoginAuthFailure,
  recordRateLimitExceeded,
  __resetSecurityEventsForTest,
} from "../../src/lib/security_events.js";
import { calendarRoutes } from "../../src/routes/calendars.js";
import { authRoutes } from "../../src/routes/auth.js";

function fakeReq(ip: string, url = "/api/v1/events"): FastifyRequest {
  return {
    ip,
    url,
    method: "GET",
    headers: { "user-agent": "test-agent" },
    log: { warn: () => undefined },
  } as unknown as FastifyRequest;
}

async function auditRows(action: string) {
  const rows = await db.select().from(schema.adminAuditLog);
  return rows.filter((r) => r.action === action);
}

beforeAll(async () => { await ensureSchema(); });
beforeEach(async () => {
  await resetDb();
  __resetSecurityEventsForTest();
  reloadSettings();
  await getSettings();
});

describe("Token 验证失败采样", () => {
  it("第一条必落库、之后攒到里程碑才落第二行，增量加总等于总数", async () => {
    const user = await makeUser("victim@example.com");
    const issued = await createApiToken({ userId: user.id, label: "n8n", scope: "read" });

    await recordApiTokenAuthFailure(fakeReq("203.0.113.9"), issued.prefix);
    let rows = await auditRows("api_token.auth_failed");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorUserId).toBe(user.id);
    const d0 = rows[0]!.details as Record<string, unknown>;
    expect(d0.prefix).toBe(issued.prefix);
    expect(d0.failures).toBe(1);
    // 红线：审计行里绝不能出现完整 token。
    expect(JSON.stringify(rows[0])).not.toContain(issued.plain);
    expect(JSON.stringify(rows[0])).not.toMatch(/bwc_[A-Za-z0-9]{8}_[A-Za-z0-9]{24}/);

    // 再打 9 次：中间 8 次只计数，第 10 次跨里程碑落第二行（增量 9）。
    for (let i = 0; i < 9; i++) {
      await recordApiTokenAuthFailure(fakeReq("203.0.113.9"), issued.prefix);
    }
    rows = await auditRows("api_token.auth_failed");
    expect(rows).toHaveLength(2);
    const deltas = rows.map((r) => (r.details as Record<string, unknown>).failures as number);
    expect(deltas.reduce((a, b) => a + b, 0)).toBe(10);
    expect((rows[1]!.details as Record<string, unknown>).totalInWindow).toBe(10);
  });

  it("换个 IP 是另一个桶；不存在的 prefix 归不到任何账号", async () => {
    const user = await makeUser("victim2@example.com");
    const issued = await createApiToken({ userId: user.id, label: "x", scope: "read" });
    await recordApiTokenAuthFailure(fakeReq("203.0.113.1"), issued.prefix);
    await recordApiTokenAuthFailure(fakeReq("203.0.113.2"), issued.prefix);
    await recordApiTokenAuthFailure(fakeReq("203.0.113.1"), "ZZZZ9999");
    const rows = await auditRows("api_token.auth_failed");
    expect(rows).toHaveLength(3);
    const unknown = rows.find((r) => (r.details as Record<string, unknown>).prefix === "ZZZZ9999");
    expect(unknown!.actorUserId).toBeNull();
  });
});

describe("HTTP 路径：坏 token 打 API", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildRoutedApp(async (a) => { await a.register(calendarRoutes); }, { prefix: "/api/v1" });
  });
  afterAll(async () => { await app.close(); });

  it("错 secret 回统一 401 并留痕；真 token 200 且不留痕", async () => {
    await updateSettings({ apiEnabled: true });
    const user = await makeUser("api-user@example.com");
    const issued = await createApiToken({ userId: user.id, label: "n8n", scope: "read" });
    const wrong = `bwc_${issued.prefix}_AAAAAAAAAAAAAAAAAAAAAAAA`;

    const bad = await app.inject({
      method: "GET", url: "/api/v1/calendars",
      headers: { authorization: `Bearer ${wrong}` },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toEqual({ error: "invalid_token" });
    // 留痕是异步飘走的，给它一拍落库时间。
    await new Promise((r) => setTimeout(r, 50));
    let rows = await auditRows("api_token.auth_failed");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorUserId).toBe(user.id);

    const good = await app.inject({
      method: "GET", url: "/api/v1/calendars",
      headers: { authorization: `Bearer ${issued.plain}` },
    });
    expect(good.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    rows = await auditRows("api_token.auth_failed");
    expect(rows).toHaveLength(1);
  });
});

describe("登录失败留痕", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildRoutedApp(async (a) => { await a.register(authRoutes); }, { prefix: "/api/v1" });
  });
  afterAll(async () => { await app.close(); });

  it("密码错留痕到账号；查无此人留痕到邮箱、actor 为空", async () => {
    const user = await makeUser("login-user@example.com");
    await db.update(schema.users)
      .set({ passwordHash: await hashPassword("Correct-Horse-9") })
      .where(eq(schema.users.id, user.id));

    const wrong = await app.inject({
      method: "POST", url: "/api/v1/auth/login",
      payload: { email: "login-user@example.com", password: "Wrong-Horse-1" },
    });
    expect(wrong.statusCode).toBe(401);
    await new Promise((r) => setTimeout(r, 50));
    let rows = await auditRows("auth.login_failed");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorUserId).toBe(user.id);
    expect((rows[0]!.details as Record<string, unknown>).email).toBe("login-user@example.com");

    const ghost = await app.inject({
      method: "POST", url: "/api/v1/auth/login",
      payload: { email: "ghost@example.com", password: "Whatever-123" },
    });
    expect(ghost.statusCode).toBe(401);
    await new Promise((r) => setTimeout(r, 50));
    rows = await auditRows("auth.login_failed");
    expect(rows).toHaveLength(2);
    const ghostRow = rows.find((r) => (r.details as Record<string, unknown>).email === "ghost@example.com");
    expect(ghostRow!.actorUserId).toBeNull();
  });

  it("直调采样器：登录失败同样攒到里程碑才写第二行", async () => {
    const user = await makeUser("burst@example.com");
    for (let i = 0; i < 10; i++) {
      await recordLoginAuthFailure(fakeReq("198.51.100.7", "/login"), "burst@example.com", user.id);
    }
    const rows = await auditRows("auth.login_failed");
    expect(rows).toHaveLength(2);
    const total = rows.reduce((a, r) => a + ((r.details as Record<string, unknown>).failures as number), 0);
    expect(total).toBe(10);
  });
});

describe("限流触发留痕", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(rateLimit, {
      global: true, max: 10_000, timeWindow: "1 minute", hook: "preHandler",
      keyGenerator: (req) => req.ip,
      onExceeded: (req) => { recordRateLimitExceeded(req); },
    });
    app.post("/login", { config: { rateLimit: { max: 2, timeWindow: "1 minute" } } }, async () => ({ ok: true }));
    app.post("/other", { config: { rateLimit: { max: 1, timeWindow: "1 minute" } } }, async () => ({ ok: true }));
    await app.ready();
  });
  afterAll(async () => { await app.close(); });

  it("敏感路由顶到 429 才留痕，且按里程碑采样；非敏感路由不留痕", async () => {
    // 前 2 次放行，第 3 次起 429 —— onExceeded 只在被拦时触发。
    for (let i = 0; i < 12; i++) {
      await app.inject({ method: "POST", url: "/login", payload: {} });
    }
    await new Promise((r) => setTimeout(r, 50));
    let rows = await auditRows("rate_limit.exceeded");
    // 10 次被拦：里程碑 1 和 10 → 两行，增量 1 + 9。
    expect(rows).toHaveLength(2);
    expect((rows[0]!.details as Record<string, unknown>).route).toBe("POST /login");
    const total = rows.reduce((a, r) => a + ((r.details as Record<string, unknown>).failures as number), 0);
    expect(total).toBe(10);

    for (let i = 0; i < 3; i++) {
      await app.inject({ method: "POST", url: "/other", payload: {} });
    }
    await new Promise((r) => setTimeout(r, 50));
    rows = await auditRows("rate_limit.exceeded");
    expect(rows).toHaveLength(2);
  });
});
