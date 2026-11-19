// 个人 API Token 的「使用信息」口径：
//   一、每次用 Token 鉴权成功，touchApiToken 在同一条 UPDATE 里更新
//       lastUsedAt / lastUsedIp 并把 useCount +1（累计调用量）；
//   二、listApiTokensForUser（设置页 Token 列表的数据源）把 useCount 与
//       lastUsedIp 一起带出来，用户能判断一个 Token 还活着没、该不该撤；
//   三、真实请求链：拿 Bearer 打 /api/v1/calendars 后，列表里的计数
//       必须真的涨（session 解析 → touch 的整条路是通的）。
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
const { calendarRoutes } = await import("../../src/routes/calendars.js");
const { createApiToken, listApiTokensForUser, touchApiToken } = await import("../../src/lib/api_token.js");
const { getSettings, reloadSettings, updateSettings } = await import("../../src/lib/site_settings.js");

beforeAll(async () => { await ensureSchema(); });

let app: FastifyInstance;

beforeEach(async () => {
  await resetDb();
  reloadSettings();
  await getSettings();
  await updateSettings({ apiEnabled: true });
  app = await buildRoutedApp(async (a) => { await calendarRoutes(a); }, { prefix: "/api/v1" });
});
afterEach(async () => { await app.close(); });

async function waitForUseCount(userId: string, atLeast: number) {
  // touch 是 fire-and-forget（void + catch），请求返回时 UPDATE 可能还没落库，
  // 给它一点时间，轮询到计数达标或超时。
  for (let i = 0; i < 40; i++) {
    const rows = await listApiTokensForUser(userId);
    if ((rows[0]?.useCount ?? 0) >= atLeast) return rows[0]!;
    await new Promise((r) => setTimeout(r, 50));
  }
  const rows = await listApiTokensForUser(userId);
  return rows[0]!;
}

describe("api token usage info", () => {
  it("新 Token 的 useCount 为 0、lastUsedIp 为空", async () => {
    const user = await makeUser("a@example.com");
    await createApiToken({ userId: user.id, label: "script", scope: "read" });
    const rows = await listApiTokensForUser(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.useCount).toBe(0);
    expect(rows[0]!.lastUsedAt).toBeNull();
    expect(rows[0]!.lastUsedIp).toBeNull();
  });

  it("touch 两次后 useCount 为 2，IP 以最后一次为准", async () => {
    const user = await makeUser("a@example.com");
    const issued = await createApiToken({ userId: user.id, label: "script", scope: "read" });
    await touchApiToken(issued.id, "1.1.1.1");
    await touchApiToken(issued.id, "2.2.2.2");
    const rows = await listApiTokensForUser(user.id);
    expect(rows[0]!.useCount).toBe(2);
    expect(rows[0]!.lastUsedIp).toBe("2.2.2.2");
    expect(rows[0]!.lastUsedAt).not.toBeNull();
  });

  it("真实 Bearer 请求打通计数：GET /calendars 后 useCount 增长", async () => {
    const user = await makeUser("a@example.com");
    const issued = await createApiToken({ userId: user.id, label: "script", scope: "read" });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/calendars",
      headers: { authorization: `Bearer ${issued.plain}` },
    });
    expect(res.statusCode).toBe(200);
    const row = await waitForUseCount(user.id, 1);
    expect(row.useCount).toBeGreaterThanOrEqual(1);
    expect(row.lastUsedIp).toBeTruthy();
    expect(row.lastUsedAt).not.toBeNull();
  });
});
