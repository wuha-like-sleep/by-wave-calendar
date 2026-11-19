// 90 天闲置 Token 提醒：筛选口径（未撤销 / 未过期 / 主人未禁用 /
// coalesce(lastUsedAt, createdAt) 超过 90 天）、30 天去重台账、
// 邮件只带打码 prefix。

import { vi, beforeAll, beforeEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

const sentMails: { to: string; subject: string; text: string }[] = [];
vi.mock("../../src/lib/mailer.js", () => ({
  sendMail: vi.fn(async (a: { to: string; subject: string; text: string }) => {
    sentMails.push(a);
    return { ok: true };
  }),
  isMailerEnabled: vi.fn(async () => true),
}));

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://unused:unused@localhost:5432/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";

import { eq } from "drizzle-orm";
import { ensureSchema, resetDb, makeUser } from "./harness.js";
import { db, schema } from "../../src/db/client.js";
import { createApiToken } from "../../src/lib/api_token.js";
import { remindIdleApiTokens } from "../../src/lib/token_idle_reminders.js";

const DAY = 24 * 60 * 60 * 1000;
const FULL_TOKEN_SHAPE = /bwc_[A-Za-z0-9]{8}_[A-Za-z0-9]{24}/;

async function agedToken(userId: string, label: string, opts: { createdDaysAgo: number; lastUsedDaysAgo?: number | null; revoked?: boolean }) {
  const issued = await createApiToken({ userId, label, scope: "read" });
  await db.update(schema.apiTokens).set({
    createdAt: new Date(Date.now() - opts.createdDaysAgo * DAY),
    lastUsedAt: opts.lastUsedDaysAgo == null ? null : new Date(Date.now() - opts.lastUsedDaysAgo * DAY),
    revokedAt: opts.revoked ? new Date() : null,
  }).where(eq(schema.apiTokens.id, issued.id));
  return issued;
}

beforeAll(async () => { await ensureSchema(); });
beforeEach(async () => {
  await resetDb();
  sentMails.length = 0;
});

describe("闲置 Token 提醒", () => {
  it("只提醒真正闲置的：新建未用满 90 天的不算、用过的按最后使用日算", async () => {
    const user = await makeUser("owner@example.com");
    await agedToken(user.id, "闲置的", { createdDaysAgo: 120 });
    await agedToken(user.id, "还年轻", { createdDaysAgo: 30 });
    await agedToken(user.id, "老但常用", { createdDaysAgo: 200, lastUsedDaysAgo: 5 });
    await agedToken(user.id, "已撤销", { createdDaysAgo: 120, revoked: true });

    const { sent } = await remindIdleApiTokens();
    expect(sent).toBe(1);
    expect(sentMails).toHaveLength(1);
    expect(sentMails[0]!.to).toBe("owner@example.com");
    expect(sentMails[0]!.text).toContain("闲置的");
    expect(sentMails[0]!.text).not.toMatch(FULL_TOKEN_SHAPE);
  });

  it("30 天内不重复提醒（审计台账去重），31 天后可以再提", async () => {
    const user = await makeUser("owner2@example.com");
    await agedToken(user.id, "闲置的", { createdDaysAgo: 120 });

    expect((await remindIdleApiTokens()).sent).toBe(1);
    expect((await remindIdleApiTokens()).sent).toBe(0);
    const later = new Date(Date.now() + 31 * DAY);
    expect((await remindIdleApiTokens(later)).sent).toBe(1);
  });

  it("主人被禁用的账号不提醒", async () => {
    const user = await makeUser("disabled@example.com");
    await db.update(schema.users).set({ disabledAt: new Date() }).where(eq(schema.users.id, user.id));
    await agedToken(user.id, "闲置的", { createdDaysAgo: 120 });
    expect((await remindIdleApiTokens()).sent).toBe(0);
  });
});
