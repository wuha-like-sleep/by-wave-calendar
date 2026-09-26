// 两步验证码输错，也要算进账号锁定 —— 网页和 App 两条路都从 HTTP 打进去。
//
// 以前只有密码输错才计入锁定。拿到密码的人停在验证码那一步：
//   · 网页上的半登录能活好几天，只受「每个 IP 每分钟 10 次」限制；
//   · App 那张票输错之后还留着，5 分钟里每分钟能猜 12 次。
// 都可以一直猜下去，而站长在后台设的「连续失败 N 次锁定」对这一步不起作用。
//
// 锁定的次数和时长用的就是后台已经在配的那一套，这里没有另起一套。

import { vi, beforeAll, beforeEach, afterEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
vi.mock("../../src/lib/mailer.js", () => ({
  sendMail: vi.fn(async () => ({ ok: true })), isMailerEnabled: vi.fn(async () => true),
}));

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import { eq } from "drizzle-orm";
import { createHmac } from "node:crypto";
import { generateSync } from "otplib";
import { ensureSchema, resetDb, db, schema, buildRoutedApp, makeUser } from "./harness.js";
import { newSessionId } from "../../src/lib/ids.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const { deviceRoutes } = await import("../../src/routes/devices.js");
const { mfaRoutes } = await import("../../src/web/mfa.js");
const { newTotpSecret } = await import("../../src/lib/mfa.js");
const { hashPassword } = await import("../../src/lib/password.js");
const { env } = await import("../../src/env.js");

const THRESHOLD = 5;
beforeAll(async () => { await ensureSchema(); });

let secret: string;
let userId: string;

beforeEach(async () => {
  await resetDb();
  const { reloadSettings } = await import("../../src/lib/site_settings.js");
  const v = { registrationMode: "public", appsEnabled: true, captchaProvider: "none",
    lockoutEnabled: true, lockoutThreshold: THRESHOLD, lockoutMinutes: 15 };
  await db.insert(schema.siteSettings).values({ id: 1, ...v }).onConflictDoUpdate({ target: schema.siteSettings.id, set: v });
  reloadSettings();
  secret = newTotpSecret();
  const u = await makeUser("mfa@example.com");
  await db.update(schema.users).set({
    passwordHash: await hashPassword("Passw0rd!long"), mfaEnabled: true, mfaTotpSecret: secret,
  }).where(eq(schema.users.id, u.id));
  userId = u.id;
});

const locked = async () => {
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  return !!u!.lockedUntil && u!.lockedUntil.getTime() > Date.now();
};

// ─────────────────────────────────────────────────────────────────────────
describe("App：验证码输错计入锁定", () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildRoutedApp(deviceRoutes, { prefix: "/api/v1" }); });
  afterEach(async () => { await app.close(); });

  async function mfaToken() {
    const r = await app.inject({ method: "POST", url: "/api/v1/auth/login-password",
      payload: { email: "mfa@example.com", password: "Passw0rd!long", label: "p", kind: "ios" } });
    return (JSON.parse(r.body) as { mfaToken: string }).mfaToken;
  }
  const verify = (mfaToken: string, code: string) =>
    app.inject({ method: "POST", url: "/api/v1/auth/login-mfa-verify", payload: { mfaToken, code } });

  it("正确的验证码登得进去（presence）", async () => {
    expect((await verify(await mfaToken(), generateSync({ secret }))).statusCode).toBe(200);
  });

  it("少于阈值的输错不锁", async () => {
    const t = await mfaToken();
    for (let i = 0; i < THRESHOLD - 1; i++) await verify(t, "000000");
    expect(await locked(), "还没到阈值就锁了").toBe(false);
    expect((await verify(t, generateSync({ secret }))).statusCode, "还没锁，正确的验证码应当能进").toBe(200);
  });

  it("**连续输错到阈值 → 账号锁定，正确的验证码也进不去**（这条是核心）", async () => {
    const t = await mfaToken();
    for (let i = 0; i < THRESHOLD; i++) await verify(t, "000000");
    expect(await locked(), "验证码连续输错没有计入锁定 —— 拿到密码的人可以一直猜下去").toBe(true);
    const r = await verify(t, generateSync({ secret }));
    expect(r.statusCode, "锁了之后用原来那张票还能进").not.toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("网页：验证码输错计入锁定", () => {
  let app: FastifyInstance;
  let sess: { cookie: string; csrf: string };
  beforeEach(async () => {
    app = Fastify({ logger: false });
    await app.register(cookie, { secret: env.SESSION_SECRET });
    await app.register(formbody);
    await app.register(mfaRoutes);
    await app.ready();
    // 半登录：密码过了，两步验证还没过。
    const sid = newSessionId();
    await db.insert(schema.sessions).values({ id: sid, userId, mfaSatisfied: false, expiresAt: new Date(Date.now() + 86400_000) });
    sess = { cookie: `bwc_sid=${encodeURIComponent(app.signCookie(sid))}`,
      csrf: createHmac("sha256", env.SESSION_SECRET).update(sid).digest("hex") };
  });
  afterEach(async () => { await app.close(); });

  const submit = (code: string) => app.inject({
    method: "POST", url: "/login/mfa",
    headers: { cookie: sess.cookie, "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ _csrf: sess.csrf, code }).toString(),
  });

  it("正确的验证码登得进去（presence）", async () => {
    const r = await submit(generateSync({ secret }));
    expect(String(r.headers.location), "连正确的验证码都没过").not.toMatch(/login/);
  });

  it("**连续输错到阈值 → 账号锁定，半登录作废**", async () => {
    for (let i = 0; i < THRESHOLD; i++) await submit("000000");
    expect(await locked(), "网页上验证码连续输错没有计入锁定").toBe(true);
    const left = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, userId));
    expect(left.length, "锁了之后半登录还在 —— 等锁一过期就能接着猜，不用再输密码").toBe(0);
  });
});
