// 苹果登录被拒时,**真的从 HTTP 打进去**看响应体里那句 message。
//
// 为什么不能只测 appleProvisionDenial 那张表:直调那个函数的测试结构上看不见
// 三件事 ——
//   ① 路由到底有没有把 message 发出去(表里有键、send 的时候漏掉,函数测试照样全绿);
//   ② 语言是谁算的。tForRequest 读的 req.locale 是 src/server.ts 那个全局钩子写的,
//      读不到时它**安静地回落 zh-CN**;这条路自己算,而「自己算」只有真发一个
//      带 Accept-Language 的请求才看得出来;
//   ③ 建号收口那一条是 `t(m.messageKey)`,键从函数里出来、文案在路由里查 ——
//      两边对不上的时候,只有真跑一次才知道。
//
// 所以这里一律:真 Fastify + 真路由 + 真 PGlite + 真 site_settings 行。
// 只有苹果那把公钥是假的 —— 验签要连 Apple 的 JWKS,那是外网。
import { vi, beforeAll, beforeEach, afterEach, describe, it, expect } from "vitest";

// 把生产的 db/schema 指到内存里的 PGlite。
vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

// 苹果验签:真的要去 appleid.apple.com 取 JWKS。这里只替换「这张票是真的吗」,
// 后面的建号 / 认领 / 闸门判定全是生产代码。
class FakeAppleVerifyError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}
const appleClaims = {
  sub: "apple-sub-0001",
  email: "someone@example.com",
  emailVerified: true,
  isPrivateRelay: false,
};
vi.mock("../../src/lib/apple_signin.js", () => ({
  appleSignInConfigured: () => true,
  verifyAppleIdentityToken: async () => appleClaims,
  AppleVerifyError: FakeAppleVerifyError,
  appleClientIds: () => ["cn.bywave.calendar"],
}));

import type { FastifyInstance } from "fastify";
import { ensureSchema, resetDb, db, schema, buildRoutedApp } from "./harness.js";
import { ja } from "../../src/lib/i18n/locales/ja.js";
import { de } from "../../src/lib/i18n/locales/de.js";
import { zhCN } from "../../src/lib/i18n/locales/zh-CN.js";

// routes/devices.ts 一路拉到 env.ts,而 env 解析不过是 process.exit(1):整个
// vitest 进程当场消失,连一条红都留不下。先兜底再动态 import。
process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const { deviceRoutes } = await import("../../src/routes/devices.js");

beforeAll(async () => { await ensureSchema(); });

let app: FastifyInstance;

/** 写 site_settings 第 1 行 + 清缓存。被测代码读的是带缓存的 getSettings()。 */
async function applySettings(opts: { registrationMode?: string; defaultLocale?: string } = {}) {
  const { reloadSettings } = await import("../../src/lib/site_settings.js");
  const values = {
    registrationMode: opts.registrationMode ?? "public",
    defaultLocale: opts.defaultLocale ?? "auto",
    appsEnabled: true,
    captchaProvider: "none",
  };
  await db.insert(schema.siteSettings).values({ id: 1, ...values })
    .onConflictDoUpdate({ target: schema.siteSettings.id, set: values });
  reloadSettings();
}

beforeEach(async () => {
  await resetDb();
  // 前缀和生产一致(server.ts 的 ["/api", "/api/v1"] 里 App 实际用的那个)。
  app = await buildRoutedApp(deviceRoutes, { prefix: "/api/v1" });
  appleClaims.sub = "apple-sub-0001";
  appleClaims.email = "someone@example.com";
  appleClaims.emailVerified = true;
  appleClaims.isPrivateRelay = false;
});

afterEach(async () => { await app.close(); });

type Denial = { status: number; error: string; message: string };

async function signIn(acceptLanguage?: string): Promise<Denial> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/apple",
    headers: acceptLanguage ? { "accept-language": acceptLanguage } : {},
    payload: {
      identityToken: "x".repeat(40),
      label: "iPhone",
      kind: "ios",
      appVersion: "1.6.0",
      clientDeviceId: "device-0001-aaaa",
    },
  });
  const body = JSON.parse(res.body) as { error?: string; message?: string };
  return { status: res.statusCode, error: body.error ?? "", message: body.message ?? "" };
}

/** 这一档跑过的分支,最后统一验数量 —— 不然哪天分支走不到了,下面每条都还是绿的。 */
const seen = new Set<string>();
function record(d: Denial): Denial {
  seen.add(`${d.status}:${d.error}`);
  return d;
}

describe("苹果登录被拒:响应体里必须有一句人话", () => {
  it("站长把注册关了 —— 403 + 非空 message，不是光一个码", async () => {
    await applySettings({ registrationMode: "closed" });
    const d = record(await signIn("ja-JP,ja;q=0.9"));
    expect(d.status).toBe(403);
    expect(d.error).toBe("signup_closed");
    expect(d.message.length).toBeGreaterThan(0);
  });

  it("语言跟着请求走：日语的请求拿到日语，德语的请求拿到德语", async () => {
    // 站点语言设成「跟随浏览器」(auto) 时,设备语言说了算。
    // iOS 没显式发 Accept-Language,URLSession 按系统偏好语言自动带一条 —— 这
    // 就是登录这一刻服务端唯一能拿到的语言信号(还不知道他是谁,没有 cookie)。
    await applySettings({ registrationMode: "closed", defaultLocale: "auto" });
    const jaRes = record(await signIn("ja-JP,ja;q=0.9,en;q=0.8"));
    expect(jaRes.message).toBe(ja["appleLogin.signupClosed"]);

    const deRes = record(await signIn("de-DE,de;q=0.9"));
    expect(deRes.message).toBe(de["appleLogin.signupClosed"]);

    // 两句话真的不一样 —— 否则上面两条可能只是碰巧相等。
    expect(jaRes.message).not.toBe(deRes.message);
  });

  it("站长指定了网站语言时，网站语言压过设备语言（已知取舍）", async () => {
    // 口径跟网页一致:default_locale 不是 auto 就是管理员的明确选择。
    // 代价写在 devices.ts 的 appleT 注释里:这一列的建表默认值是 zh-CN,
    // 站长没动过的话,日语用户收到的是中文。
    await applySettings({ registrationMode: "closed", defaultLocale: "de" });
    const d = record(await signIn("ja-JP,ja;q=0.9"));
    expect(d.message).toBe(de["appleLogin.signupClosed"]);
  });

  it("一个语言信号都没有时回落中文，而不是回落成空", async () => {
    await applySettings({ registrationMode: "closed", defaultLocale: "auto" });
    const d = record(await signIn(undefined));
    expect(d.message).toBe(zhCN["appleLogin.signupClosed"]);
  });

  it("邮箱这边已经有账号、苹果又没证明它是本人 —— 409 + 教他怎么办", async () => {
    // 苹果没断言这个邮箱(emailVerified=false),于是走不到按邮箱认领那一步,
    // 落到建号前的撞号检查。这正是用户看到「HTTP 409 - email_taken」的那条路。
    await applySettings({ registrationMode: "public" });
    await db.insert(schema.users).values({
      email: "someone@example.com",
      emailVerified: true,
      passwordHash: "x",
    });
    appleClaims.emailVerified = false;
    const d = record(await signIn("ja-JP,ja;q=0.9"));
    expect(d.status).toBe(409);
    expect(d.error).toBe("email_taken");
    expect(d.message).toBe(ja["appleLogin.emailTaken"]);
  });

  it("每日配额用完 —— 403 + 非空 message，且不把配额数字告诉 App", async () => {
    await applySettings({ registrationMode: "public" });
    // 配额是 site_settings 上的另一列,单独写一次。
    const { reloadSettings } = await import("../../src/lib/site_settings.js");
    await db.update(schema.siteSettings).set({ signupDailyQuota: 1 });
    reloadSettings();
    // 先用掉今天唯一的名额。
    await db.insert(schema.users).values({
      email: "first@example.com", emailVerified: true, passwordHash: "x", signupSource: "self",
    });
    const d = record(await signIn("ja-JP,ja;q=0.9"));
    expect(d.status).toBe(403);
    expect(d.error).toBe("signup_quota_reached");
    expect(d.message.length).toBeGreaterThan(0);
    expect(d.message).not.toContain("1");
  });

  it("App 同步被管理员关掉 —— 也带 message", async () => {
    const { reloadSettings } = await import("../../src/lib/site_settings.js");
    await applySettings({});
    await db.update(schema.siteSettings).set({ appsEnabled: false });
    reloadSettings();
    const d = record(await signIn("ja-JP,ja;q=0.9"));
    expect(d.status).toBe(403);
    expect(d.error).toBe("apps_disabled");
    expect(d.message.length).toBeGreaterThan(0);
  });
});

describe("拒绝响应的共同约束", () => {
  it("跑到的分支不止一条（presence：扫空了要红）", () => {
    // 上面每条 it 都往 seen 里记一笔。哪天路由改了形状、几条 it 全都走到同一个
    // 分支(比如全被 400 bad_request 挡在门口),这一行先红。
    expect([...seen].sort()).toEqual([
      "403:apps_disabled",
      "403:signup_closed",
      "403:signup_quota_reached",
      "409:email_taken",
    ]);
  });
});

describe("message 里不许有内部词", () => {
  it("码名 / 状态码 / 接口路径都不出现在用户看到的那句话里", async () => {
    await applySettings({ registrationMode: "closed" });
    const d = await signIn("ja-JP,ja;q=0.9");
    expect(d.message.length).toBeGreaterThan(0);
    for (const bad of ["signup_closed", "email_taken", "HTTP", "/api", "auth/apple"]) {
      expect(d.message, `message 里出现了「${bad}」`).not.toContain(bad);
    }
    expect(/\d{3}/.test(d.message)).toBe(false);
  });
});
