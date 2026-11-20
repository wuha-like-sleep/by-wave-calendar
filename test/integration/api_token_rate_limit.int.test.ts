// 每 Token 限流的 HTTP 口径（RATE_LIMIT_API_TOKEN_PER_MINUTE，本文件设为 3）：
//   一、配额内正常放行；超限回 429 too_many_requests，带 Retry-After 头
//       和本地化 message；
//   二、不同 Token 互不影响（一枚被限，另一枚照常用）；
//   三、窗口滚动后自动恢复；
//   四、被限流拒绝的请求不算用量（touch 不触发，useCount 不涨）。
// 窗口恢复用 vi.useFakeTimers 只假造 Date（限流判定读 Date.now），
// 网络/DB 的真实异步不受影响。
import { vi, beforeAll, beforeEach, afterEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
vi.mock("../../src/lib/mailer.js", () => ({
  sendMail: vi.fn(async () => ({ ok: true })), isMailerEnabled: vi.fn(async () => true),
}));

import type { FastifyInstance } from "fastify";
import { ensureSchema, resetDb, makeUser, buildRoutedApp } from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
process.env.RATE_LIMIT_API_TOKEN_PER_MINUTE = "3";
const { calendarRoutes } = await import("../../src/routes/calendars.js");
const { createApiToken, listApiTokensForUser } = await import("../../src/lib/api_token.js");
const { resetApiTokenRateLimits } = await import("../../src/lib/api_token_rate_limit.js");
const { getSettings, reloadSettings, updateSettings } = await import("../../src/lib/site_settings.js");

beforeAll(async () => { await ensureSchema(); });

let app: FastifyInstance;

beforeEach(async () => {
  await resetDb();
  resetApiTokenRateLimits();
  reloadSettings();
  await getSettings();
  await updateSettings({ apiEnabled: true });
  app = await buildRoutedApp(async (a) => { await calendarRoutes(a); }, { prefix: "/api/v1" });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
});
afterEach(async () => {
  vi.useRealTimers();
  await app.close();
});

function get(plain: string) {
  return app.inject({
    method: "GET",
    url: "/api/v1/calendars",
    headers: { authorization: `Bearer ${plain}` },
  });
}

describe("api token rate limit (HTTP)", () => {
  it("配额内放行，超限 429 + Retry-After + too_many_requests", async () => {
    const user = await makeUser("a@example.com");
    const issued = await createApiToken({ userId: user.id, label: "script", scope: "read" });
    for (let i = 0; i < 3; i++) {
      expect((await get(issued.plain)).statusCode).toBe(200);
    }
    const res = await get(issued.plain);
    expect(res.statusCode).toBe(429);
    const body = res.json() as { error: string; message: string };
    expect(body.error).toBe("too_many_requests");
    expect(body.message).toBeTruthy();
    const retryAfter = Number(res.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it("不同 Token 互不影响", async () => {
    const user = await makeUser("a@example.com");
    const t1 = await createApiToken({ userId: user.id, label: "one", scope: "read" });
    const t2 = await createApiToken({ userId: user.id, label: "two", scope: "read" });
    for (let i = 0; i < 3; i++) await get(t1.plain);
    expect((await get(t1.plain)).statusCode).toBe(429);
    expect((await get(t2.plain)).statusCode).toBe(200);
  });

  it("窗口滚动后恢复放行", async () => {
    const user = await makeUser("a@example.com");
    const issued = await createApiToken({ userId: user.id, label: "script", scope: "read" });
    for (let i = 0; i < 3; i++) await get(issued.plain);
    expect((await get(issued.plain)).statusCode).toBe(429);
    vi.setSystemTime(new Date("2026-06-01T00:01:01Z"));
    expect((await get(issued.plain)).statusCode).toBe(200);
  });

  it("被拒请求不算用量：useCount 只记放行的 3 次", async () => {
    const user = await makeUser("a@example.com");
    const issued = await createApiToken({ userId: user.id, label: "script", scope: "read" });
    for (let i = 0; i < 3; i++) await get(issued.plain);
    await get(issued.plain);
    await get(issued.plain);
    // touch 是 fire-and-forget，等它落库后核对。
    let useCount = -1;
    for (let i = 0; i < 40; i++) {
      const rows = await listApiTokensForUser(user.id);
      useCount = rows[0]?.useCount ?? -1;
      if (useCount >= 3) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(useCount).toBe(3);
  });
});
