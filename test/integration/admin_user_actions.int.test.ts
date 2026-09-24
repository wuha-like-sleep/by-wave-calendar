// 后台替用户解决登录问题 + 真的删号 —— 从 HTTP 打进去。
//
// 这几条动作都不是「显示」，是真的改库、真的发信、真的删数据，
// 所以判据必须落在**库里那一行**和**有没有真发出去**上，不能只看跳转。
//
// 特别注意发信：这个仓库的 sendMail **不抛异常，只回一个布尔**。
// 用 try/catch 判成败会得到一个永远成功的假象，站长会照着告诉用户
// 「已经发了」，然后让他干等。所以这里专门有一条「发信失败」的用例。

import { vi, beforeAll, beforeEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

const sent: { to: string; subject: string }[] = [];
let mailOk = true;
vi.mock("../../src/lib/mailer.js", () => ({
  sendMail: vi.fn(async (a: { to: string; subject: string }) => {
    if (!mailOk) return { ok: false, reason: "smtp_down" };
    sent.push({ to: a.to, subject: a.subject });
    return { ok: true };
  }),
  isMailerEnabled: vi.fn(async () => true),
}));

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import view from "@fastify/view";
import ejs from "ejs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { ensureSchema, resetDb, db, schema, makeUser, makeCalendar } from "./harness.js";
import { newSessionId } from "../../src/lib/ids.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";

const { adminRoutes } = await import("../../src/web/admin.js");
const { makeT } = await import("../../src/lib/i18n.js");

let app: FastifyInstance;
let adminCookie: string;
let admin: Awaited<ReturnType<typeof makeUser>>;

beforeAll(async () => {
  await ensureSchema();
  app = Fastify({ logger: false });
  await app.register(cookie, { secret: "integration-test-cookie-secret-32-chars-min" });
  await app.register(formbody);
  await app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024 } });
  await app.register(view, {
    engine: { ejs }, root: path.resolve("src/views"), propertyName: "view",
    options: { async: false },
    defaultContext: {
      t: makeT("zh-CN"), siteName: "ByWave", siteLogoUrl: null, icpNumber: null, icpUrl: "",
      assetVersion: "t", jsBasePath: "/static/js", cspNonce: "n",
      currentLocale: "zh-CN", locales: [], siteLocaleOptions: [], currentUser: null,
      themePalette: "indigo", themeDensity: "comfortable", currentPath: "/admin/users",
    },
  });
  await app.register(adminRoutes);
  await app.ready();
});

async function loginAs(userId: string) {
  const sid = newSessionId();
  await db.insert(schema.sessions).values({
    id: sid, userId, mfaSatisfied: true, expiresAt: new Date(Date.now() + 86400_000),
  });
  return `bwc_sid=${encodeURIComponent(app.signCookie(sid))}`;
}
function post(url: string, payload: Record<string, string> = {}, c = adminCookie) {
  return app.inject({ method: "POST", url, headers: { cookie: c }, payload });
}
const flash = (res: { headers: Record<string, unknown> }) =>
  decodeURIComponent(String(res.headers.location ?? ""));
async function row(id: string) {
  const [r] = await db.select().from(schema.users).where(eq(schema.users.id, id));
  return r;
}

beforeEach(async () => {
  await resetDb();
  sent.length = 0;
  mailOk = true;
  admin = await makeUser("admin@example.com", { isAdmin: true });
  adminCookie = await loginAs(admin.id);
});

describe("解除登录锁定", () => {
  it("锁和失败计数一起清掉", async () => {
    const u = await makeUser("locked@example.com");
    await db.update(schema.users)
      .set({ lockedUntil: new Date(Date.now() + 3600_000), failedLoginCount: 9 })
      .where(eq(schema.users.id, u.id));
    const res = await post(`/admin/users/${u.id}/unlock`);
    expect([302, 303]).toContain(res.statusCode);
    const after = await row(u.id);
    expect(after!.lockedUntil, "锁还在").toBeNull();
    expect(
      after!.failedLoginCount,
      "锁解了但失败计数没清 —— 他再错一次就又被锁上，站长会以为解锁没生效",
    ).toBe(0);
  });

  it("记了审计", async () => {
    const u = await makeUser("l2@example.com");
    await post(`/admin/users/${u.id}/unlock`);
    const logs = await db.select().from(schema.adminAuditLog);
    expect(logs.map((l) => l.action)).toContain("user.unlock");
  });
});

describe("重发验证邮件", () => {
  it("真发出去了", async () => {
    const u = await makeUser("nv@example.com");
    await db.update(schema.users).set({ emailVerified: false }).where(eq(schema.users.id, u.id));
    const res = await post(`/admin/users/${u.id}/resend-verification`);
    expect(flash(res)).not.toMatch(/没能发出去/);
    expect(sent.some((m) => m.to === "nv@example.com"), "一封信都没发").toBe(true);
  });

  it("已经验证过的不重发", async () => {
    const u = await makeUser("v@example.com"); // makeUser 默认 emailVerified: true
    const res = await post(`/admin/users/${u.id}/resend-verification`);
    expect(flash(res)).toMatch(/已经验证过/);
    expect(sent.length).toBe(0);
  });

  it("**发信失败时说实话**，不是报成功", async () => {
    // sendMail 不抛异常、只回布尔。看 try/catch 会得到永远成功的假象，
    // 站长照着告诉用户「已经发了」，然后让他干等。
    const u = await makeUser("nv2@example.com");
    await db.update(schema.users).set({ emailVerified: false }).where(eq(schema.users.id, u.id));
    mailOk = false;
    const res = await post(`/admin/users/${u.id}/resend-verification`);
    expect(
      flash(res),
      "发信失败却报了成功 —— 站长会告诉用户「已经发了」，而用户那边什么也没收到",
    ).toMatch(/没能发出去/);
  });
});

describe("发重置密码邮件", () => {
  it("信发到**用户自己**的邮箱，并且生成了一条重置记录", async () => {
    const u = await makeUser("r@example.com");
    const res = await post(`/admin/users/${u.id}/send-password-reset`);
    expect(flash(res)).not.toMatch(/没能发出去/);
    expect(
      sent.map((m) => m.to),
      "信没发到用户自己的邮箱 —— 那就成了站长可以接管任何账号",
    ).toContain("r@example.com");
    expect(sent.every((m) => m.to !== "admin@example.com"), "把重置链接发给了管理员自己").toBe(true);
    const resets = await db.select().from(schema.passwordResets);
    expect(resets.length, "没生成重置记录，链接是死的").toBe(1);
  });

  it("发信失败时说实话", async () => {
    const u = await makeUser("r2@example.com");
    mailOk = false;
    const res = await post(`/admin/users/${u.id}/send-password-reset`);
    expect(flash(res)).toMatch(/没能发出去/);
  });
});

describe("解绑两步验证", () => {
  it("把所有相关的列一起清掉，并给本人发提醒信", async () => {
    const u = await makeUser("m@example.com");
    await db.update(schema.users).set({
      mfaEnabled: true, mfaTotpSecret: "S", mfaPendingSecret: "P", mfaBackupCodes: ["a", "b"],
    }).where(eq(schema.users.id, u.id));
    const res = await post(`/admin/users/${u.id}/disable-mfa`);
    expect([302, 303]).toContain(res.statusCode);
    const a = await row(u.id);
    expect(a!.mfaEnabled).toBe(false);
    expect(a!.mfaTotpSecret, "密钥没清 —— 下次开两步验证会沿用旧的").toBeNull();
    expect(a!.mfaPendingSecret, "半途那份也要清").toBeNull();
    expect(a!.mfaBackupCodes, "备用码没清，旧码还能用").toBeNull();
    expect(
      sent.some((m) => m.to === "m@example.com"),
      "本人没收到提醒信 —— 这是唯一能让被降级的人察觉的东西",
    ).toBe(true);
  });

  it("没开两步验证的不做无用功", async () => {
    const u = await makeUser("m2@example.com");
    const res = await post(`/admin/users/${u.id}/disable-mfa`);
    expect(flash(res)).toMatch(/没有开两步验证/);
  });
});

describe("真的删号", () => {
  async function seedOwner(email: string) {
    const u = await makeUser(email);
    const cal = await makeCalendar(u.id);
    await db.insert(schema.events).values({
      calendarId: cal.id, uid: `e-${email}`, summary: "会",
      startsAt: new Date(), endsAt: new Date(Date.now() + 3600_000),
    });
    return u;
  }

  it("预览页把会删掉的东西列出来，而且什么也没改（presence）", async () => {
    const u = await seedOwner("d1@example.com");
    const res = await app.inject({ method: "GET", url: `/admin/users/${u.id}/delete`, headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("d1@example.com");
    expect(await row(u.id), "只是看一眼预览就把人删了").toBeTruthy();
  });

  it("**邮箱打错什么也不做**", async () => {
    const u = await seedOwner("d2@example.com");
    const res = await post(`/admin/users/${u.id}/delete`, { confirmEmail: "typo@example.com" });
    expect(flash(res)).toMatch(/对不上/);
    expect(await row(u.id), "邮箱对不上却还是删了").toBeTruthy();
  });

  it("不填也什么都不做", async () => {
    const u = await seedOwner("d3@example.com");
    const res = await post(`/admin/users/${u.id}/delete`, {});
    expect(flash(res)).toMatch(/对不上/);
    expect(await row(u.id)).toBeTruthy();
  });

  it("**邮箱打对了就真的删掉，连带他的东西**", async () => {
    const u = await seedOwner("d4@example.com");
    const res = await post(`/admin/users/${u.id}/delete`, { confirmEmail: "D4@Example.com" }); // 大小写不该卡人
    expect(flash(res)).toMatch(/已永久删除/);
    expect(await row(u.id), "说删了其实没删").toBeUndefined();
    const cals = await db.select().from(schema.calendars);
    expect(cals.length, "人删了日历还留着").toBe(0);
  });

  it("删之前先把这件事记进审计，而且带着当时的规模", async () => {
    const u = await seedOwner("d5@example.com");
    await post(`/admin/users/${u.id}/delete`, { confirmEmail: "d5@example.com" });
    const logs = await db.select().from(schema.adminAuditLog);
    const del = logs.find((l) => l.action === "user.delete");
    expect(del, "不可逆的操作没留下记录").toBeTruthy();
    const d = del!.details as { email?: string; impact?: { calendars?: number } };
    expect(d.email, "记录里没留下删的是谁 —— 行都没了，只剩这条记录").toBe("d5@example.com");
    expect(d.impact?.calendars, "没记下当时删掉了多少东西").toBe(1);
  });

  it("不能删自己", async () => {
    const res = await post(`/admin/users/${admin.id}/delete`, { confirmEmail: "admin@example.com" });
    expect(flash(res)).toMatch(/不能删自己/);
    expect(await row(admin.id)).toBeTruthy();
  });

  it("**删掉一个已经停用的管理员是允许的**，哪怕我是唯一在岗的那个", async () => {
    // 第一版的判据是「管理员总数 ≤ 1 就拦」，于是这一步被拦下来了 ——
    // 而删掉一个早就登不进来的账号，不会让任何人失去管理权。
    const stale = await makeUser("old-admin@example.com", { isAdmin: true, disabledAt: new Date() });
    const res = await post(`/admin/users/${stale.id}/delete`, { confirmEmail: "old-admin@example.com" });
    expect(
      flash(res),
      "把一次正常的清理当成「会让站里没人管」拦下来了 —— 这个账号本来就登不进来",
    ).toMatch(/已永久删除/);
    expect(await row(stale.id)).toBeUndefined();
  });

  it("删掉一个在岗的管理员，前提是还有别的在岗管理员", async () => {
    const other = await makeUser("admin2@example.com", { isAdmin: true });
    const res = await post(`/admin/users/${other.id}/delete`, { confirmEmail: "admin2@example.com" });
    expect(flash(res)).toMatch(/已永久删除/);
    expect(await row(other.id)).toBeUndefined();
    // 自己还在，站还有人管。
    expect((await row(admin.id))!.isAdmin).toBe(true);
  });

  it("停用的管理员不能当成「还有人管」的凭据", async () => {
    // 场景：站里只有我一个在岗管理员，另外挂着一个停用的。
    // 我要是能把自己删了，就一个登得进来的管理员都没有了 —— 必须拦。
    await makeUser("ghost@example.com", { isAdmin: true, disabledAt: new Date() });
    const res = await post(`/admin/users/${admin.id}/delete`, { confirmEmail: "admin@example.com" });
    expect(
      flash(res),
      "把自己删了，而剩下那个管理员是停用状态，谁也登不进来管这个站",
    ).toMatch(/不能删自己|最后一个/);
    expect(await row(admin.id)).toBeTruthy();
  });

  it("预览页和真删用的是同一个判据", async () => {
    // 预览页说「不能删」而 POST 照删不误，这种偏差没人看得见。
    const res = await app.inject({ method: "GET", url: `/admin/users/${admin.id}/delete`, headers: { cookie: adminCookie } });
    expect(res.body, "预览页没说不能删自己").toMatch(/不能删自己/);
    expect(res.body, "预览页上还摆着确认输入框").not.toContain('name="confirmEmail"');
  });

  it("非管理员碰不到这几条", async () => {
    const plain = await makeUser("p@example.com");
    const c = await loginAs(plain.id);
    const victim = await makeUser("victim@example.com");
    for (const path of ["unlock", "disable-mfa", "send-password-reset", "resend-verification"]) {
      const res = await post(`/admin/users/${victim.id}/${path}`, {}, c);
      expect([302, 303, 403], `${path} 放行了非管理员`).toContain(res.statusCode);
      expect(String(res.headers.location ?? "")).not.toContain("success");
    }
    const del = await post(`/admin/users/${victim.id}/delete`, { confirmEmail: "victim@example.com" }, c);
    expect([302, 303, 403]).toContain(del.statusCode);
    expect(await row(victim.id), "非管理员把人删了").toBeTruthy();
  });
});
