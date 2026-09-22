// 开了二次验证的账号,能不能只凭账号密码拿到一个能用的会话 —— 全程从 HTTP 打进去。
//
// 修之前的实情:POST /api/auth/login 调 createSession(reply, user.id) 不传第三个参数,
// 而 createSession 里是 `mfaSatisfied: opts.mfaSatisfied ?? true` ——「不说就算过了」。
// 于是任何人只要有账号密码(撞库、泄露库、钓鱼),打这个接口就拿到一个**已过
// 二次验证**的完整会话:网页、后台、API 全放行,连 forceAdminMfa 也拦不住
// (它信的是会话行上那个 flag)。网页表单那条路一直是对的,两条路口径不同,
// 而没防住的恰好是不需要浏览器的那条。
//
// 第二组用例守的是另一半:**半登录会话**(密码过了、验证码还没过)能做什么。
// 以前它能给账号注册一个新 passkey —— 之后永远免密登录,受害者改密码也清不掉。

import { vi, beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./security_harness.js");
  return { db: h.db, schema: h.schema };
});

vi.mock("../../src/lib/mailer.js", () => ({
  isMailerEnabled: async () => true,
  sendMail: async () => ({ ok: true }),
}));

import Fastify, { type FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { ensureSchema, resetDb, db, schema, pg, applySettings, csrfToken, form } from "./security_harness.js";

let app: FastifyInstance;

const PW = "Correct-Horse-9";
const MFA_USER = "mfa@example.com";
const PLAIN_USER = "plain@example.com";

async function buildAuthApp(): Promise<FastifyInstance> {
  const [{ env }, cookie, formbody, { authRoutes }, { webRoutes }, { webauthnRoutes }, { mfaRoutes }] =
    await Promise.all([
      import("../../src/env.js"),
      import("@fastify/cookie"),
      import("@fastify/formbody"),
      import("../../src/routes/auth.js"),
      import("../../src/web/index.js"),
      import("../../src/web/webauthn.js"),
      import("../../src/web/mfa.js"),
    ]);
  const a = Fastify({ logger: false });
  await a.register(cookie.default, { secret: env.SESSION_SECRET });
  await a.register(formbody.default);
  await a.register(authRoutes, { prefix: "/api/v1" });
  await a.register(webRoutes);
  await a.register(webauthnRoutes);
  await a.register(mfaRoutes);
  await a.ready();
  return a;
}

async function seedUser(email: string, mfa: boolean) {
  const { hashPassword } = await import("../../src/lib/password.js");
  const [u] = await db.insert(schema.users).values({
    email,
    passwordHash: await hashPassword(PW),
    emailVerified: true,
    mfaEnabled: mfa,
    // 真实的 base32 secret 形状;这一档不验码,只验「有没有被放行」。
    mfaTotpSecret: mfa ? "JBSWY3DPEHPK3PXP" : null,
  }).returning({ id: schema.users.id });
  return u!.id;
}

/** 库里这个人名下的会话行。断言落在这儿,不落在状态码上 ——
 *  状态码可能是别的原因给的(404 也是「没登录成功」)。 */
async function sessionsOf(userId: string) {
  return db.select({ id: schema.sessions.id, mfaSatisfied: schema.sessions.mfaSatisfied })
    .from(schema.sessions).where(eq(schema.sessions.userId, userId));
}

function sidFrom(res: { headers: Record<string, unknown> }): string | null {
  const raw = res.headers["set-cookie"];
  const all = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const hit = all.find((c) => c.startsWith("bwc_sid="));
  return hit ? hit.split(";")[0]! : null;
}

beforeAll(async () => {
  await ensureSchema();
  app = await buildAuthApp();
});

afterAll(async () => {
  await app?.close();
  await pg?.close();
});

beforeEach(async () => {
  await resetDb();
  await applySettings({});
});

describe("JSON 登录接口不许绕过二次验证", () => {
  it("没开二次验证的账号照常能登（presence —— 没有这条,下面那条会因为『这个接口本来就不通』而假绿）", async () => {
    const id = await seedUser(PLAIN_USER, false);
    const res = await app.inject({
      method: "POST", url: "/api/v1/auth/login",
      payload: { email: PLAIN_USER, password: PW },
    });
    expect(res.statusCode, `本来就该通。响应: ${res.body.slice(0, 200)}`).toBe(200);
    expect(sidFrom(res), "没下发会话 cookie").not.toBeNull();

    const rows = await sessionsOf(id);
    expect(rows.length).toBe(1);
    expect(rows[0]!.mfaSatisfied, "没开二次验证的人,会话本来就该是「已满足」").toBe(true);
  });

  it("开了二次验证的账号:密码对也不发会话", async () => {
    const id = await seedUser(MFA_USER, true);
    const res = await app.inject({
      method: "POST", url: "/api/v1/auth/login",
      payload: { email: MFA_USER, password: PW },
    });

    // 最要紧的断言:库里一行会话都不该有。
    // 只看状态码不够 —— 它可能在发完 cookie 之后才拐去别的分支。
    const rows = await sessionsOf(id);
    expect(
      rows.length,
      "开了二次验证,只凭密码就建出了会话。这正是那个洞:" +
        `建出来的行 mfaSatisfied=${rows.map((r) => r.mfaSatisfied).join(",")}`,
    ).toBe(0);

    expect(sidFrom(res), "不该下发任何会话 cookie").toBeNull();
    // 403 不是 401 —— 401 在原生端的含义是「会话没了,去重新登录」。
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("mfa_required");
  });

  it("密码错的时候,回的不是「要验证码」（否则这个接口变成密码正确与否的探测器）", async () => {
    await seedUser(MFA_USER, true);
    const res = await app.inject({
      method: "POST", url: "/api/v1/auth/login",
      payload: { email: MFA_USER, password: "Wrong-Horse-0" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.body, "密码错却回 mfa_required —— 等于告诉攻击者「密码是对的」").not.toContain("mfa_required");
  });
});

describe("网页表单那条路给的是半登录会话", () => {
  it("开了二次验证:表单登录建出的会话 mfaSatisfied=false,且到不了 /app", async () => {
    const id = await seedUser(MFA_USER, true);
    const csrf = await csrfToken();
    // form() 返回的是 { payload, headers } —— 要展开,不能整个当 payload 传。
    const res = await app.inject({
      method: "POST", url: "/login",
      ...form({ email: MFA_USER, password: PW, _csrf: csrf }),
    });

    const rows = await sessionsOf(id);
    expect(rows.length, "表单登录连半登录会话都没建出来 —— 这条用例什么也没测到").toBe(1);
    expect(rows[0]!.mfaSatisfied, "表单这条路把会话直接标成「已过二次验证」").toBe(false);

    const sid = sidFrom(res);
    expect(sid).not.toBeNull();

    // 拿这个半登录 cookie 去打受保护的页面,必须被推去补验证码。
    const app_ = await app.inject({ method: "GET", url: "/app", headers: { cookie: sid! } });
    expect([302, 303]).toContain(app_.statusCode);
    expect(String(app_.headers.location), "半登录会话直接进了 /app").toContain("/login/mfa");
  });

  it("半登录会话不许给账号注册新 passkey（注册成了就是一个改密码也清不掉的后门）", async () => {
    const id = await seedUser(MFA_USER, true);
    const csrf = await csrfToken();
    const login = await app.inject({
      method: "POST", url: "/login",
      ...form({ email: MFA_USER, password: PW, _csrf: csrf }),
    });
    const sid = sidFrom(login);
    expect(sid, "布置失败:没拿到半登录 cookie").not.toBeNull();
    // 确认这确实是半登录状态,否则下面那条断言测的是别的东西。
    expect((await sessionsOf(id))[0]!.mfaSatisfied).toBe(false);

    const res = await app.inject({
      method: "POST", url: "/webauthn/register/options",
      headers: { cookie: sid!, "content-type": "application/json" },
      payload: { _csrf: csrf },
    });
    expect(
      res.statusCode,
      "半登录状态下拿到了 passkey 注册挑战 —— 注册成功之后此人永远免密登录,受害者改密码也清不掉",
    ).toBe(401);
  });
});
