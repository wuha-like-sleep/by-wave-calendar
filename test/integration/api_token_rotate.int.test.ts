// Token 自助轮换（POST /app/settings/api-tokens/:id/rotate）的口径：
//   一、全流程：验密通过 → 新 Token 一次性展示（flash）、旧 Token 打上
//       rotatedAt 且 expiresAt 压到 7 天后（宽限）、宽限期内旧 Token 仍
//       可鉴权、宽限一过 verify 立即拒绝；
//   二、安全口径与创建一致：密码错 → 拒绝 + 计入失败锁定 + 不签发；
//       写 Token 在 MFA 账号上缺 TOTP → 拒绝，补上才行；纯 SSO 账号
//       （无密码无 MFA）走不通自助；
//   三、越权：拿别人的 Token id 来轮换，什么都不发生；
//   四、已过期的 Token 不能轮换（防「借死凭据的壳签活凭据」）；
//   五、通知：轮换发安全邮件（只有打码 prefix、无明文）+ 站内镜像；
//   六、自助轮换的新 Token 继承旧 Token 的到期口径，不偷偷变成永不过期。
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
process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import { eq } from "drizzle-orm";
import { generateSync } from "otplib";
import { ensureSchema, resetDb, makeUser, loginAs } from "./harness.js";
import { db, schema } from "../../src/db/client.js";
// 依赖 env 的模块必须动态 import：env.ts 在被 import 的瞬间就校验并可能
// process.exit，静态 import 会赶在上面的 ??= 赋值之前执行（同
// api_token_usage.int.test.ts 的处理）。
const { csrfTokenFor } = await import("../../src/lib/csrf.js");
const { webRoutes } = await import("../../src/web/index.js");
const { createApiToken, listApiTokensForUser, verifyApiToken, apiTokenPrefix } = await import("../../src/lib/api_token.js");
const { getSettings, reloadSettings, updateSettings } = await import("../../src/lib/site_settings.js");
const { hashPassword } = await import("../../src/lib/password.js");
const { newTotpSecret } = await import("../../src/lib/mfa.js");

const REAL_PASSWORD = "correct horse battery staple";
const FULL_TOKEN_SHAPE = /bwc_[A-Za-z0-9]{8}_[A-Za-z0-9]{24}/;

let app: FastifyInstance;

async function csrfFor(sess: string) {
  return (await app.inject({ url: "/test/csrf", headers: { cookie: sess } })).json().token as string;
}

function flashCookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const arr = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const hit = arr.find((c) => String(c).startsWith("bwc_flash="));
  return hit ? String(hit).split(";")[0]! : "";
}

async function devicesLocals(sess: string, flash = "") {
  const res = await app.inject({
    url: "/app/settings/devices",
    headers: { cookie: flash ? `${sess}; ${flash}` : sess },
  });
  return res.json().locals as {
    flash: { success?: string; error?: string };
    issuedToken: string | null;
    apiTokens: { id: string; inGrace: boolean }[];
  };
}

async function rotate(sess: string, csrf: string, tokenId: string, payload: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url: `/app/settings/api-tokens/${tokenId}/rotate`,
    headers: { cookie: sess },
    payload: { _csrf: csrf, ...payload },
  });
}

async function makePasswordUser(email: string) {
  const user = await makeUser(email);
  await db.update(schema.users)
    .set({ passwordHash: await hashPassword(REAL_PASSWORD) })
    .where(eq(schema.users.id, user.id));
  return user;
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

describe("Token 自助轮换", () => {
  it("全流程：新 Token 一次性展示、旧 Token 宽限中且仍可鉴权、邮件与站内镜像齐全", async () => {
    const user = await makePasswordUser("rot@example.com");
    const old = await createApiToken({ userId: user.id, label: "n8n 同步", scope: "read" });
    const sess = await loginAs(app, user.id);
    const csrf = await csrfFor(sess);
    const res = await rotate(sess, csrf, old.id, { currentPassword: REAL_PASSWORD });
    expect(res.statusCode).toBe(302);

    const locals = await devicesLocals(sess, flashCookieOf(res));
    expect(locals.flash.success).toBeTruthy();
    // 新明文只在 flash 里出现一次。
    expect(locals.issuedToken).toMatch(FULL_TOKEN_SHAPE);
    const newPlain = locals.issuedToken!;
    const again = await devicesLocals(sess);
    expect(again.issuedToken).toBeNull();

    // 列表：两枚，旧的宽限中、新的不是；新明文与列表里的新 Token 对得上。
    const rows = await listApiTokensForUser(user.id);
    expect(rows).toHaveLength(2);
    const oldRow = rows.find((r) => r.id === old.id)!;
    const newRow = rows.find((r) => r.id !== old.id)!;
    expect(oldRow.rotatedAt).not.toBeNull();
    expect(newRow.rotatedAt).toBeNull();
    expect(newRow.prefix).toBe(apiTokenPrefix(newPlain));
    const graceMs = oldRow.expiresAt!.getTime() - Date.now();
    expect(graceMs).toBeGreaterThan(6.9 * 86400000);
    expect(graceMs).toBeLessThan(7.1 * 86400000);
    expect(locals.apiTokens.find((t) => t.id === old.id)!.inGrace).toBe(true);

    // 宽限期内新旧都能鉴权。
    expect((await verifyApiToken(old.plain))?.tokenId).toBe(old.id);
    expect((await verifyApiToken(newPlain))?.userId).toBe(user.id);

    // 安全邮件：轮换主题、带标签、无明文。
    const mails = sentMails.filter((m) => m.to === "rot@example.com" && m.subject.includes("API Token 已轮换"));
    expect(mails).toHaveLength(1);
    expect(mails[0]!.text).toContain("n8n 同步");
    expect(mails[0]!.text + mails[0]!.html).not.toMatch(FULL_TOKEN_SHAPE);

    // 站内镜像：一条 security_alert，内容是轮换。
    const notes = await db.select().from(schema.notifications)
      .where(eq(schema.notifications.userId, user.id));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.type).toBe("security_alert");
    expect(notes[0]!.body).toContain("已轮换");
  });

  it("宽限一过，旧 Token 立即失效（verify 时判定，无需等清理）", async () => {
    const user = await makePasswordUser("grace@example.com");
    const old = await createApiToken({ userId: user.id, label: "script", scope: "read" });
    const sess = await loginAs(app, user.id);
    const csrf = await csrfFor(sess);
    await rotate(sess, csrf, old.id, { currentPassword: REAL_PASSWORD });
    expect(await verifyApiToken(old.plain)).not.toBeNull();
    await db.update(schema.apiTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.apiTokens.id, old.id));
    expect(await verifyApiToken(old.plain)).toBeNull();
  });

  it("新 Token 继承旧 Token 的到期口径（365 天的轮换后仍是约 365 天，不是永不过期）", async () => {
    const user = await makePasswordUser("inherit@example.com");
    const old = await createApiToken({ userId: user.id, label: "script", scope: "read", expiresInDays: 365 });
    const [oldRowBefore] = await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.id, old.id));
    const sess = await loginAs(app, user.id);
    const csrf = await csrfFor(sess);
    await rotate(sess, csrf, old.id, { currentPassword: REAL_PASSWORD });
    const rows = await listApiTokensForUser(user.id);
    const newRow = rows.find((r) => r.id !== old.id)!;
    expect(newRow.expiresAt).not.toBeNull();
    const driftMs = Math.abs(newRow.expiresAt!.getTime() - oldRowBefore!.expiresAt!.getTime());
    expect(driftMs).toBeLessThan(2 * 86400000);
  });

  it("密码错：拒绝、计入失败次数、不签发、旧 Token 不动", async () => {
    const user = await makePasswordUser("wrongpw@example.com");
    const old = await createApiToken({ userId: user.id, label: "script", scope: "read" });
    const sess = await loginAs(app, user.id);
    const csrf = await csrfFor(sess);
    const res = await rotate(sess, csrf, old.id, { currentPassword: "wrong password" });
    expect(res.statusCode).toBe(302);
    const locals = await devicesLocals(sess, flashCookieOf(res));
    expect(locals.flash.error).toBeTruthy();
    expect(locals.issuedToken).toBeNull();
    const rows = await listApiTokensForUser(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rotatedAt).toBeNull();
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, user.id));
    expect(u!.failedLoginCount).toBeGreaterThanOrEqual(1);
    expect(sentMails.filter((m) => m.subject.includes("已轮换"))).toHaveLength(0);
  });

  it("越权：拿别人的 Token id 轮换，什么都不发生", async () => {
    const alice = await makePasswordUser("alice@example.com");
    const bob = await makePasswordUser("bob@example.com");
    const alices = await createApiToken({ userId: alice.id, label: "alice's", scope: "write" });
    const sess = await loginAs(app, bob.id);
    const csrf = await csrfFor(sess);
    const res = await rotate(sess, csrf, alices.id, { currentPassword: REAL_PASSWORD });
    expect(res.statusCode).toBe(302);
    const locals = await devicesLocals(sess, flashCookieOf(res));
    expect(locals.flash.error).toBeTruthy();
    expect(await listApiTokensForUser(alice.id)).toHaveLength(1);
    expect((await listApiTokensForUser(alice.id))[0]!.rotatedAt).toBeNull();
    expect(await listApiTokensForUser(bob.id)).toHaveLength(0);
  });

  it("写 Token 在 MFA 账号上：缺 TOTP 拒绝，补上才放行", async () => {
    const user = await makePasswordUser("mfa@example.com");
    const secret = newTotpSecret();
    await db.update(schema.users)
      .set({ mfaEnabled: true, mfaTotpSecret: secret })
      .where(eq(schema.users.id, user.id));
    const old = await createApiToken({ userId: user.id, label: "writer", scope: "write" });
    const sess = await loginAs(app, user.id);
    const csrf = await csrfFor(sess);
    const denied = await rotate(sess, csrf, old.id, { currentPassword: REAL_PASSWORD });
    const deniedLocals = await devicesLocals(sess, flashCookieOf(denied));
    expect(deniedLocals.flash.error).toBeTruthy();
    expect(await listApiTokensForUser(user.id)).toHaveLength(1);

    const code = generateSync({ strategy: "totp", secret, digits: 6, period: 30 });
    const ok = await rotate(sess, csrf, old.id, { currentPassword: REAL_PASSWORD, mfaCode: code });
    const okLocals = await devicesLocals(sess, flashCookieOf(ok));
    expect(okLocals.flash.success).toBeTruthy();
    expect(await listApiTokensForUser(user.id)).toHaveLength(2);
  });

  it("已过期的 Token 不能轮换", async () => {
    const user = await makePasswordUser("expired@example.com");
    const old = await createApiToken({ userId: user.id, label: "dead", scope: "read" });
    await db.update(schema.apiTokens)
      .set({ expiresAt: new Date(Date.now() - 86400000) })
      .where(eq(schema.apiTokens.id, old.id));
    const sess = await loginAs(app, user.id);
    const csrf = await csrfFor(sess);
    const res = await rotate(sess, csrf, old.id, { currentPassword: REAL_PASSWORD });
    const locals = await devicesLocals(sess, flashCookieOf(res));
    expect(locals.flash.error).toContain("过期");
    expect(await listApiTokensForUser(user.id)).toHaveLength(1);
  });
});
