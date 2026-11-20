// 个人 API Token 每日用量（api_token_daily_usage）的口径：
//   一、touchApiToken 在更新 lastUsedAt 的同时，用一条 upsert 给当天
//       （UTC 日）计数 +1；并发打进来也不能丢数（单语句原子递增）；
//   二、getApiTokenUsageSummary 是设置页「近 30 天用量」的数据源：窗口
//       固定 30 天、缺的日子补零、按 Token 分列、只算本人的、已撤销的
//       Token 不出现；
//   三、purgeOldApiTokenUsage 按 90 天保留期清理（housekeeping 每日调用）。
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
import { db, schema } from "../../src/db/client.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const { calendarRoutes } = await import("../../src/routes/calendars.js");
const {
  createApiToken, touchApiToken, revokeApiTokenForUser,
  getApiTokenUsageSummary, purgeOldApiTokenUsage, apiTokenDayKey,
} = await import("../../src/lib/api_token.js");
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

async function dailyRows(tokenId: string) {
  const { eq } = await import("drizzle-orm");
  return db.select().from(schema.apiTokenDailyUsage)
    .where(eq(schema.apiTokenDailyUsage.tokenId, tokenId));
}

describe("api token daily usage", () => {
  it("touch 一次，当天多一行计数为 1；再 touch 变 2", async () => {
    const user = await makeUser("a@example.com");
    const issued = await createApiToken({ userId: user.id, label: "script", scope: "read" });
    await touchApiToken(issued.id, "1.1.1.1");
    let rows = await dailyRows(issued.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.day).toBe(apiTokenDayKey(new Date()));
    expect(rows[0]!.count).toBe(1);
    await touchApiToken(issued.id, "1.1.1.1");
    rows = await dailyRows(issued.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(2);
  });

  it("并发 touch 20 次，计数一条不丢（upsert 原子递增）", async () => {
    const user = await makeUser("a@example.com");
    const issued = await createApiToken({ userId: user.id, label: "script", scope: "read" });
    await Promise.all(Array.from({ length: 20 }, () => touchApiToken(issued.id, "1.1.1.1")));
    const rows = await dailyRows(issued.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(20);
  });

  it("真实 Bearer 请求后当天计数增长", async () => {
    const user = await makeUser("a@example.com");
    const issued = await createApiToken({ userId: user.id, label: "script", scope: "read" });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/calendars",
      headers: { authorization: `Bearer ${issued.plain}` },
    });
    expect(res.statusCode).toBe(200);
    // touch 是 fire-and-forget，轮询等它落库。
    let count = 0;
    for (let i = 0; i < 40 && count < 1; i++) {
      const rows = await dailyRows(issued.id);
      count = rows[0]?.count ?? 0;
      if (count < 1) await new Promise((r) => setTimeout(r, 50));
    }
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("汇总：30 天补零、按 Token 分列、只算本人、撤销的不出现", async () => {
    const alice = await makeUser("alice@example.com");
    const bob = await makeUser("bob@example.com");
    const t1 = await createApiToken({ userId: alice.id, label: "one", scope: "read" });
    const t2 = await createApiToken({ userId: alice.id, label: "two", scope: "write" });
    const t3 = await createApiToken({ userId: bob.id, label: "bob's", scope: "read" });
    const today = apiTokenDayKey(new Date());
    const tenDaysAgo = apiTokenDayKey(new Date(Date.now() - 10 * 86400000));
    const fortyDaysAgo = apiTokenDayKey(new Date(Date.now() - 40 * 86400000));
    await db.insert(schema.apiTokenDailyUsage).values([
      { tokenId: t1.id, day: today, count: 5 },
      { tokenId: t1.id, day: tenDaysAgo, count: 3 },
      { tokenId: t1.id, day: fortyDaysAgo, count: 100 }, // 窗口外，不算
      { tokenId: t2.id, day: today, count: 2 },
      { tokenId: t3.id, day: today, count: 7 },          // 别人的，不算
    ]);
    const s = await getApiTokenUsageSummary(alice.id, 30);
    expect(s.perDay).toHaveLength(30);
    expect(s.perDay[29]!.day).toBe(today);
    expect(s.perDay[29]!.count).toBe(7);        // t1 5 + t2 2
    expect(s.perDay[19]!.count).toBe(3);        // 10 天前
    expect(s.perDay.filter((d) => d.count === 0)).toHaveLength(28);
    expect(s.total).toBe(10);
    expect(s.perToken).toEqual([
      { tokenId: t1.id, label: "one", count: 8 },
      { tokenId: t2.id, label: "two", count: 2 },
    ]);
    // 撤销后从视图消失（连同它的历史）。
    await revokeApiTokenForUser(alice.id, t1.id);
    const s2 = await getApiTokenUsageSummary(alice.id, 30);
    expect(s2.perToken.map((t) => t.tokenId)).toEqual([t2.id]);
    expect(s2.total).toBe(2);
  });

  it("清理：90 天前的行删掉，窗口内的保留", async () => {
    const user = await makeUser("a@example.com");
    const t = await createApiToken({ userId: user.id, label: "script", scope: "read" });
    const day = (n: number) => apiTokenDayKey(new Date(Date.now() - n * 86400000));
    await db.insert(schema.apiTokenDailyUsage).values([
      { tokenId: t.id, day: day(120), count: 1 },
      { tokenId: t.id, day: day(90), count: 1 },
      { tokenId: t.id, day: day(89), count: 1 },
      { tokenId: t.id, day: day(0), count: 1 },
    ]);
    const { purged } = await purgeOldApiTokenUsage();
    expect(purged).toBe(2);
    const rows = await dailyRows(t.id);
    expect(rows.map((r) => r.day).sort()).toEqual([day(0), day(89)].sort());
  });
});
