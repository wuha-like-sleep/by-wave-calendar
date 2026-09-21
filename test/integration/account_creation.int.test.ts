// 建号闸门的 HTTP 层断言。
//
// 见 security_harness.ts 顶上那段:这一档一律**真 Fastify 实例 + 真路由 + 真请求**,
// 不直调收口函数。直调看不见「路由自己多做了一件事」。
//
// 每条断言的落点都是 **users 表的行数**,不是状态码。状态码可能是别的原因给的
// (路径写错落到 404、zod 校验先挡下、令牌没过)—— 那些也都「没建号」,但它们
// 证明的不是闸门在起作用。所以每条用例都成对地断言:请求确实走到了该走的地方,
// **并且** users 表没多出行。

import { vi, beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";

// 必须在任何 import 之前落地:src/env.ts 在模块求值时就 parse 了 process.env,
// 而 appleClientIds() 读的是 env.SIWA_CLIENT_IDS。dotenv 不覆盖已存在的变量,
// 所以这里设了就是它。晚一步设,苹果那条路会一直 503(feature off),
// 而 503 也是「没建号」—— 一组看起来很绿的空跑。
vi.hoisted(() => {
  process.env.SIWA_CLIENT_IDS = "cn.bywave.calendar.test";
});

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./security_harness.js");
  return { db: h.db, schema: h.schema };
});

// 唯一一处 mock,而且它不是任何一道闸门:SMTP。
// 网页注册那条路会真的去发验证码邮件,mailer 关着时 issueCode 直接回
// { ok:false },用户停在「验证码发送失败」——测试就永远走不到建号那一行。
// 这里换掉的是**发信这件事**,收/发之后的 verifyCode、收口函数、闸门判定
// 一条没动。
vi.mock("../../src/lib/mailer.js", () => ({
  isMailerEnabled: async () => true,
  sendMail: async () => ({ ok: true }),
}));

import type { FastifyInstance } from "fastify";
import {
  ensureSchema, resetDb, db, schema, pg,
  applySettings, userCount, userEmails,
  buildApp, csrfToken, form,
  startFakeIdp, seedIdpProvider, APPLE_CLIENT_ID, type FakeIdp,
  forceVerificationCode, pendingVerificationCount,
} from "./security_harness.js";

let app: FastifyInstance;
let idp: FakeIdp;

beforeAll(async () => {
  await ensureSchema();
  idp = await startFakeIdp();
  app = await buildApp();
});

afterAll(async () => {
  await app?.close();
  await idp?.close();
});

beforeEach(async () => {
  await resetDb();
});

// ---------------------------------------------------------------------------
// 每个入口打一次的统一写法
// ---------------------------------------------------------------------------

type Entry = {
  name: string;
  /** 打一次。返回状态码,供「不是 404 / 不是 500」这类自检用。 */
  hit(email: string): Promise<{ status: number; body: string }>;
};

/** 网页注册:POST /register → 改验证码 → POST /verify-email。两步都是真请求。 */
async function webRegister(email: string): Promise<{ status: number; body: string; stoppedAt: "register" | "verify" }> {
  const csrf = await csrfToken();
  const r1 = await app.inject({
    method: "POST", url: "/register",
    ...form({
      _csrf: csrf, email, password: "Correct-Horse-9", displayName: "网页用户",
      company: "", agreeTerms: "on",
    }),
  });
  // 第一步就被挡住(注册关闭 / 域名不在白名单)→ 不会产生 pending 行。
  if (!await forceVerificationCode(email)) {
    return { status: r1.statusCode, body: String(r1.headers.location ?? r1.body), stoppedAt: "register" };
  }
  const r2 = await app.inject({
    method: "POST", url: "/verify-email",
    ...form({ _csrf: csrf, code: "123456" }, { cookie: `bwc_pending_email=${encodeURIComponent(email)}` }),
  });
  return { status: r2.statusCode, body: String(r2.headers.location ?? r2.body), stoppedAt: "verify" };
}

function entries(): Entry[] {
  return [
    {
      name: "JSON 注册接口 POST /api/v1/auth/register",
      async hit(email) {
        const r = await app.inject({
          method: "POST", url: "/api/v1/auth/register",
          payload: { email, password: "Correct-Horse-9", displayName: "接口用户" },
        });
        return { status: r.statusCode, body: r.body };
      },
    },
    {
      name: "网页注册表单 POST /register → POST /verify-email",
      async hit(email) {
        const r = await webRegister(email);
        return { status: r.status, body: r.body };
      },
    },
    {
      name: "外部 IdP 懒建号（服务客户端令牌 + X-Account，读请求）",
      async hit(email) {
        const token = await idp.signServiceToken();
        const r = await app.inject({
          method: "GET", url: "/api/v1/calendars",
          headers: { authorization: `Bearer ${token}`, "x-account": email },
        });
        return { status: r.statusCode, body: r.body };
      },
    },
    {
      name: "服务客户端批量开通 POST /api/v1/accounts",
      async hit(email) {
        const token = await idp.signServiceToken();
        const r = await app.inject({
          method: "POST", url: "/api/v1/accounts",
          headers: { authorization: `Bearer ${token}` },
          payload: { email, displayName: "批量开通" },
        });
        return { status: r.statusCode, body: r.body };
      },
    },
    {
      name: "苹果登录 POST /api/v1/auth/apple",
      async hit(email) {
        const token = await idp.signAppleToken({
          sub: `apple-sub-${email}`, email, email_verified: "true", is_private_email: "false",
        });
        const r = await app.inject({
          method: "POST", url: "/api/v1/auth/apple",
          payload: { identityToken: token, label: "iPhone", kind: "ios" },
        });
        return { status: r.statusCode, body: r.body };
      },
    },
  ];
}

const IDP_SETTINGS = { idpApiServiceClients: "meeting-platform" } as const;

async function openSite(extra: Parameters<typeof applySettings>[0] = {}): Promise<void> {
  await applySettings({ registrationMode: "public", ...IDP_SETTINGS, ...extra });
  await seedIdpProvider(idp);
}

// ---------------------------------------------------------------------------
// 0. 工装自检 —— 没有这一组,下面所有「没建号」都可能是空跑
// ---------------------------------------------------------------------------

describe("工装自检", () => {
  it("五个入口一个不少", () => {
    expect(entries().map((e) => e.name)).toHaveLength(5);
  });

  it("苹果登录的 feature 开关是开的（否则整组会静默 503）", async () => {
    const { appleSignInConfigured, appleClientIds } = await import("../../src/lib/apple_signin.js");
    expect(appleSignInConfigured()).toBe(true);
    expect(appleClientIds()).toContain(APPLE_CLIENT_ID);
  });

  it("每条路径都真的挂上了（不是 404）", async () => {
    await openSite();
    for (const e of entries()) {
      const r = await e.hit(`route-check-${entries().indexOf(e)}@example.com`);
      expect(r.status, `${e.name} → ${r.body.slice(0, 200)}`).not.toBe(404);
    }
  });
});

// ---------------------------------------------------------------------------
// 1. registrationMode = public:五个入口都必须建得出来
// ---------------------------------------------------------------------------
//
// **这一半和「拒绝」那一半同等重要。** 只测拒绝的话,把收口函数改成「永远拒绝」
// 也全绿 —— 那不是一道闸门,那是把注册功能拆了。

describe("注册开放（public）：五个入口都能建号", () => {
  for (const e of entries()) {
    it(e.name, async () => {
      await openSite();
      expect(await userCount()).toBe(0);
      const email = `open-${Math.random().toString(36).slice(2, 8)}@example.com`;
      const r = await e.hit(email);
      expect(await userEmails(), `${e.name} → ${r.status} ${r.body.slice(0, 300)}`).toEqual([email]);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. registrationMode = closed:五个入口一个都建不出来
// ---------------------------------------------------------------------------

describe("注册关闭（closed）：五个入口一个都建不出来", () => {
  for (const e of entries()) {
    it(e.name, async () => {
      await openSite({ registrationMode: "closed" });
      const email = `closed-${Math.random().toString(36).slice(2, 8)}@example.com`;
      const r = await e.hit(email);
      // 落点是行数。状态码只当诊断信息印出来。
      expect(await userEmails(), `${e.name} → ${r.status} ${r.body.slice(0, 300)}`).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. 域名白名单
// ---------------------------------------------------------------------------

describe("邮箱域名白名单", () => {
  for (const e of entries()) {
    it(`${e.name}：名单外的域名建不出来`, async () => {
      await openSite({ signupDomainAllowlist: "corp.example.com" });
      const r = await e.hit(`blocked-${Math.random().toString(36).slice(2, 8)}@evil.test`);
      expect(await userEmails(), `${e.name} → ${r.status} ${r.body.slice(0, 300)}`).toEqual([]);
    });
  }

  it("名单内的域名照常建得出来（名单不是「全拒」）", async () => {
    await openSite({ signupDomainAllowlist: "corp.example.com" });
    const r = await app.inject({
      method: "POST", url: "/api/v1/auth/register",
      payload: { email: "allowed@corp.example.com", password: "Correct-Horse-9" },
    });
    expect(await userEmails(), r.body.slice(0, 300)).toEqual(["allowed@corp.example.com"]);
  });

  it("裸条目不含子域名", async () => {
    await openSite({ signupDomainAllowlist: "corp.example.com" });
    await app.inject({
      method: "POST", url: "/api/v1/auth/register",
      payload: { email: "sub@mail.corp.example.com", password: "Correct-Horse-9" },
    });
    expect(await userEmails()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. 每日配额
// ---------------------------------------------------------------------------

describe("每日建号配额", () => {
  for (const e of entries()) {
    it(`${e.name}：配额用完之后建不出来`, async () => {
      await openSite({ signupDailyQuota: 1 });
      // 先用掉唯一的名额(走 JSON 接口,和被测入口无关)。
      await app.inject({
        method: "POST", url: "/api/v1/auth/register",
        payload: { email: "first@example.com", password: "Correct-Horse-9" },
      });
      expect(await userCount()).toBe(1);
      const r = await e.hit(`over-${Math.random().toString(36).slice(2, 8)}@example.com`);
      expect(await userEmails(), `${e.name} → ${r.status} ${r.body.slice(0, 300)}`).toEqual(["first@example.com"]);
    });
  }

  it("撞配额会在后台留下一条可见记录", async () => {
    await openSite({ signupDailyQuota: 1 });
    await app.inject({
      method: "POST", url: "/api/v1/auth/register",
      payload: { email: "first@example.com", password: "Correct-Horse-9" },
    });
    await app.inject({
      method: "POST", url: "/api/v1/auth/register",
      payload: { email: "second@example.com", password: "Correct-Horse-9" },
    });
    const rows = await db.select().from(schema.adminAuditLog);
    expect(rows.map((r) => r.action)).toContain("signup.quota_blocked");
  });

  it("配额 0 = 不限制", async () => {
    await openSite({ signupDailyQuota: 0 });
    for (const n of [1, 2, 3]) {
      await app.inject({
        method: "POST", url: "/api/v1/auth/register",
        payload: { email: `n${n}@example.com`, password: "Correct-Horse-9" },
      });
    }
    expect(await userCount()).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 5. 网页注册那条路的两个额外落点
// ---------------------------------------------------------------------------

describe("网页注册：闸门在两步里都拦得住", () => {
  it("注册关闭时，第一步就停住 —— 连待验证的行都不留", async () => {
    await openSite({ registrationMode: "closed" });
    const csrf = await csrfToken();
    const r = await app.inject({
      method: "POST", url: "/register",
      ...form({ _csrf: csrf, email: "a@example.com", password: "Correct-Horse-9", company: "", agreeTerms: "on" }),
    });
    expect(r.statusCode).toBe(302);
    expect(await pendingVerificationCount()).toBe(0);
    expect(await userCount()).toBe(0);
  });

  it("第一步通过之后管理员才关的注册，第二步也要拦住", async () => {
    // 这是收口的意义所在:闸门不在 POST /register 那一处,而在真正建号的那一行。
    await openSite();
    const csrf = await csrfToken();
    await app.inject({
      method: "POST", url: "/register",
      ...form({ _csrf: csrf, email: "late@example.com", password: "Correct-Horse-9", company: "", agreeTerms: "on" }),
    });
    expect(await pendingVerificationCount()).toBe(1);
    // 管理员这会儿把注册关了。
    await applySettings({ registrationMode: "closed", ...IDP_SETTINGS });
    expect(await forceVerificationCode("late@example.com")).toBe(true);
    const r = await app.inject({
      method: "POST", url: "/verify-email",
      ...form({ _csrf: csrf, code: "123456" }, { cookie: "bwc_pending_email=late%40example.com" }),
    });
    expect(r.statusCode).toBe(302);
    expect(await userCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. 已有账号不受闸门影响 —— 关注册不能把老用户挡在门外
// ---------------------------------------------------------------------------

describe("关注册不影响已有账号登录", () => {
  it("closed 时，服务客户端仍然能代已有账号读数据", async () => {
    await openSite({ registrationMode: "closed" });
    await pg.query(
      "INSERT INTO users (email, email_verified, password_hash) VALUES ($1, true, 'x')",
      ["old@example.com"],
    );
    const token = await idp.signServiceToken();
    const r = await app.inject({
      method: "GET", url: "/api/v1/calendars",
      headers: { authorization: `Bearer ${token}`, "x-account": "old@example.com" },
    });
    expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
    expect(await userCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 7. 建出来的号确实是从收口函数出去的
// ---------------------------------------------------------------------------
//
// 为什么要有这一组:上面「public 时五个入口都能建号」只证明了**有一行冒出来**。
// 哪天有人在某个路由里直接 insert 一行,那一组照样全绿 —— 而它绕过了所有闸门。
// signup_source 这一列**只有收口函数写**,所以它是「这一行是从那道门出去的」
// 的凭据。结构门禁(test/no_direct_user_insert.test.ts)从源码那一侧看同一件事,
// 这一组从运行时这一侧看。

describe("建出来的号带着来源标记（= 真的过了收口函数）", () => {
  const EXPECTED: Record<string, string> = {
    "JSON 注册接口 POST /api/v1/auth/register": "self",
    "网页注册表单 POST /register → POST /verify-email": "self",
    "外部 IdP 懒建号（服务客户端令牌 + X-Account，读请求）": "idp:meeting-platform",
    "服务客户端批量开通 POST /api/v1/accounts": "idp:meeting-platform",
    "苹果登录 POST /api/v1/auth/apple": "apple",
  };

  it("五个入口的期望来源一个不缺", () => {
    // 自检:上面那张表和 entries() 对不上的话,下面的循环会静默少测几条。
    for (const e of entries()) expect(EXPECTED[e.name], e.name).toBeDefined();
  });

  for (const e of entries()) {
    it(e.name, async () => {
      await openSite();
      const email = `src-${Math.random().toString(36).slice(2, 8)}@example.com`;
      const r = await e.hit(email);
      const rows = await pg.query<{ signup_source: string | null }>(
        "SELECT signup_source FROM users WHERE email = $1", [email],
      );
      expect(rows.rows.length, `${e.name} → ${r.status} ${r.body.slice(0, 300)}`).toBe(1);
      expect(rows.rows[0]?.signup_source, e.name).toBe(EXPECTED[e.name]);
    });
  }
});

// ---------------------------------------------------------------------------
// 8. 拒绝建号不能回 401
// ---------------------------------------------------------------------------
//
// 401 在已发布的 App 里(api.dart)的意思是「会话没了」,收到就把人登出。
// 「这次不让你开号」跟「你是谁我不认」是两回事。这条是发布过的包改不了的约束,
// 所以只能在服务端这边钉住。

describe("闸门拒绝时不许回 401", () => {
  const API_ENTRIES = ["JSON 注册接口", "外部 IdP 懒建号", "服务客户端批量开通", "苹果登录"];

  for (const mode of ["closed", "invite"] as const) {
    for (const e of entries().filter((x) => API_ENTRIES.some((p) => x.name.startsWith(p)))) {
      it(`${mode} + ${e.name}`, async () => {
        await openSite({ registrationMode: mode });
        const r = await e.hit(`no401-${Math.random().toString(36).slice(2, 8)}@example.com`);
        expect(r.status, `${e.name} → ${r.body.slice(0, 300)}`).not.toBe(401);
        expect(await userCount()).toBe(0);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// 9. 邀请制:带不出邀请码的三条路建不了号
// ---------------------------------------------------------------------------
//
// 这是拍板的规则(「invite = 只有带有效邀请码的能建」),对接了 Keycloak 且开着
// 自动开通的部署,切到邀请制当天就会开始拒绝新用户 —— 发版说明要写的那一条。
// 钉在这里是为了它哪天被「顺手放行」的时候会红。

describe("邀请制（invite）", () => {
  for (const e of entries().filter((x) => !x.name.startsWith("JSON") && !x.name.startsWith("网页"))) {
    it(`${e.name}：带不出邀请码 → 建不了号`, async () => {
      await openSite({ registrationMode: "invite" });
      const r = await e.hit(`inv-${Math.random().toString(36).slice(2, 8)}@example.com`);
      expect(await userEmails(), `${e.name} → ${r.status} ${r.body.slice(0, 300)}`).toEqual([]);
    });
  }

  it("JSON 注册接口：无效邀请码建不了，有效邀请码建得了", async () => {
    await openSite({ registrationMode: "invite" });
    const bad = await app.inject({
      method: "POST", url: "/api/v1/auth/register",
      payload: { email: "bad@example.com", password: "Correct-Horse-9", invite: "no-such-token" },
    });
    expect(await userCount(), bad.body.slice(0, 300)).toBe(0);

    await db.insert(schema.signupInvites).values({
      token: "good-token", createdBy: null, maxUses: 1, usedCount: 0,
    });
    const good = await app.inject({
      method: "POST", url: "/api/v1/auth/register",
      payload: { email: "good@example.com", password: "Correct-Horse-9", invite: "good-token" },
    });
    expect(await userEmails(), good.body.slice(0, 300)).toEqual(["good@example.com"]);
    const rows = await pg.query<{ signup_source: string | null }>(
      "SELECT signup_source FROM users WHERE email = 'good@example.com'",
    );
    // 用掉了邀请码才记成 invite —— 这是收口函数的口径,调用方不自己判。
    expect(rows.rows[0]?.signup_source).toBe("invite");
  });
});
