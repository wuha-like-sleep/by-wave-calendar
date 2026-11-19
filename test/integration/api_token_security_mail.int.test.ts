// API Token 安全变更邮件的 HTTP 断言：自助创建 / 自助撤销 / 管理员签发 /
// 管理员撤销，四条路都要给账号本人发通知；通知里只有打码 prefix，
// 绝不能出现明文（明文只走 flash 在页面上显示一次）。

import { vi, beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

const sentMails: { to: string; subject: string; text: string; html: string }[] = [];
vi.mock("../../src/lib/mailer.js", () => ({
  sendMail: vi.fn(async (a: { to: string; subject: string; text: string; html: string }) => {
    sentMails.push(a);
    return { ok: true };
  }),
  isMailerEnabled: vi.fn(async () => true),
}));

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://unused:unused@localhost:5432/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import { eq } from "drizzle-orm";
import { ensureSchema, resetDb, makeUser, loginAs } from "./harness.js";
import { db, schema } from "../../src/db/client.js";
import { csrfTokenFor } from "../../src/lib/csrf.js";
import { adminRoutes } from "../../src/web/admin.js";
import { webRoutes } from "../../src/web/index.js";
import { createApiToken } from "../../src/lib/api_token.js";
import { getSettings, reloadSettings, updateSettings } from "../../src/lib/site_settings.js";
import { hashPassword } from "../../src/lib/password.js";

const REAL_PASSWORD = "Correct-Horse-9";
const FULL_TOKEN_SHAPE = /bwc_[A-Za-z0-9]{8}_[A-Za-z0-9]{24}/;

let app: FastifyInstance;

async function csrfFor(sess: string) {
  return (await app.inject({ url: "/test/csrf", headers: { cookie: sess } })).json().token as string;
}

function mailsTo(email: string) {
  return sentMails.filter((m) => m.to === email);
}

beforeAll(async () => {
  await ensureSchema();
  app = Fastify({ logger: false });
  await app.register(cookie, { secret: "test-cookie-secret-at-least-32-characters" });
  await app.register(formbody);
  app.decorateReply("view", function (template: string, locals: object) {
    return this.send({ template, locals });
  });
  app.get("/test/csrf", (req) => ({ token: csrfTokenFor(req) }));
  await app.register(adminRoutes);
  await app.register(webRoutes);
  await app.ready();
});
afterAll(async () => { await app.close(); });

beforeEach(async () => {
  await resetDb();
  sentMails.length = 0;
  reloadSettings();
  await getSettings();
  await updateSettings({ apiEnabled: true });
});

describe("Token 安全变更邮件", () => {
  it("自助创建：本人收到创建通知，只有打码 prefix、没有明文", async () => {
    const user = await makeUser("self@example.com");
    await db.update(schema.users)
      .set({ passwordHash: await hashPassword(REAL_PASSWORD) })
      .where(eq(schema.users.id, user.id));
    const sess = await loginAs(app, user.id);
    const csrf = await csrfFor(sess);
    const res = await app.inject({
      method: "POST", url: "/app/settings/api-tokens",
      headers: { cookie: sess },
      payload: { _csrf: csrf, label: "n8n 同步", scope: "read", expiresInDays: "365", currentPassword: REAL_PASSWORD },
    });
    expect(res.statusCode).toBe(302);
    const mails = mailsTo("self@example.com").filter((m) => m.subject.includes("API Token 已创建"));
    expect(mails).toHaveLength(1);
    expect(mails[0]!.text).toContain("n8n 同步");
    expect(mails[0]!.text).toContain("只读");
    expect(mails[0]!.text + mails[0]!.html).not.toMatch(FULL_TOKEN_SHAPE);
  });

  it("自助撤销：本人收到撤销通知", async () => {
    const user = await makeUser("revoker@example.com");
    const issued = await createApiToken({ userId: user.id, label: "旧集成", scope: "write" });
    const sess = await loginAs(app, user.id);
    const csrf = await csrfFor(sess);
    const res = await app.inject({
      method: "POST", url: `/app/settings/api-tokens/${issued.id}/revoke`,
      headers: { cookie: sess },
      payload: { _csrf: csrf },
    });
    expect(res.statusCode).toBe(302);
    const mails = mailsTo("revoker@example.com").filter((m) => m.subject.includes("API Token 已撤销"));
    expect(mails).toHaveLength(1);
    expect(mails[0]!.text).toContain("旧集成");
    expect(mails[0]!.text + mails[0]!.html).not.toMatch(FULL_TOKEN_SHAPE);
  });

  it("管理员签发：通知发给目标账号本人，不是管理员", async () => {
    const admin = await makeUser("admin@example.com", { isAdmin: true });
    const target = await makeUser("target@example.com");
    const sess = await loginAs(app, admin.id);
    const csrf = await csrfFor(sess);
    const res = await app.inject({
      method: "POST", url: "/admin/api/tokens",
      headers: { cookie: sess },
      payload: { _csrf: csrf, label: "内部系统", userId: target.id, scope: "write", expiresInDays: "0" },
    });
    expect(res.statusCode).toBe(302);
    const mails = mailsTo("target@example.com").filter((m) => m.subject.includes("API Token 已创建"));
    expect(mails).toHaveLength(1);
    expect(mails[0]!.text).toContain("管理员刚刚为你的账号新建了");
    expect(mailsTo("admin@example.com").filter((m) => m.subject.includes("API Token"))).toHaveLength(0);
    expect(mails[0]!.text + mails[0]!.html).not.toMatch(FULL_TOKEN_SHAPE);
  });

  it("管理员撤销：通知发给目标账号本人", async () => {
    const admin = await makeUser("admin2@example.com", { isAdmin: true });
    const target = await makeUser("target2@example.com");
    const issued = await createApiToken({ userId: target.id, label: "要撤的", scope: "read" });
    const sess = await loginAs(app, admin.id);
    const csrf = await csrfFor(sess);
    const res = await app.inject({
      method: "POST", url: `/admin/api/tokens/${issued.id}/revoke`,
      headers: { cookie: sess },
      payload: { _csrf: csrf },
    });
    expect(res.statusCode).toBe(302);
    const mails = mailsTo("target2@example.com").filter((m) => m.subject.includes("API Token 已撤销"));
    expect(mails).toHaveLength(1);
    expect(mails[0]!.text).toContain("管理员刚刚撤销了");
  });
});
