// 网页扫码登录（web-pair）的安全口径：
//   一、配对码只是公开标识，兑换必须出示 init 时只发给发起浏览器的
//       轮询秘密（HttpOnly cookie）；无秘密 / 错秘密与码不存在同样是
//       404，不给攻击者区分信号 —— 光拿到二维码（拍照/肩窥）兑不了。
//   二、兑换是原子消费：并发两次轮询只能签出一张会话。
//   三、个人 API Token 不许批准 web 配对（三条批准路径都算），不许它
//       把自己升级成一张 mfaSatisfied 的完整浏览器会话。
//   四、旧流程回归：桌面配对一字不改地能跑通；手机浏览器批准页
//       （/web-pair/<CODE>/approve，会话内批准）不受轮询秘密影响。
import { vi, beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

vi.mock("../../src/lib/mailer.js", () => ({
  sendMail: vi.fn(async () => ({ ok: true })),
  isMailerEnabled: vi.fn(async () => true),
}));

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://localhost:5432/bywave";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";

import type { FastifyInstance } from "fastify";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { ensureSchema, resetDb, makeUser, makeDevice, buildRoutedApp } from "./harness.js";
import { db, schema } from "../../src/db/client.js";

const { deviceRoutes, pairPageRoutes } = await import("../../src/routes/devices.js");
const { signAccessToken } = await import("../../src/lib/device_tokens.js");
const { createApiToken } = await import("../../src/lib/api_token.js");
const { updateSettings, reloadSettings } = await import("../../src/lib/site_settings.js");
const { newSessionId } = await import("../../src/lib/ids.js");

let app: FastifyInstance;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function deviceBearer(userId: string): Promise<string> {
  const d = await makeDevice(userId);
  return signAccessToken(userId, d.id).token;
}

type PairInit = { code: string; pollCookie: string; rawSetCookie: string };

async function initPair(): Promise<PairInit> {
  const res = await app.inject({ method: "POST", url: "/api/v1/devices/web-pair-init", payload: {} });
  expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
  const body = JSON.parse(res.body) as { code: string; approveUrl: string };
  const sc = res.headers["set-cookie"];
  const arr = Array.isArray(sc) ? sc : sc ? [sc] : [];
  const poll = arr.find((c) => c.startsWith("bwc_qr_poll="));
  expect(poll, "init 必须给发起浏览器种轮询秘密 cookie").toBeTruthy();
  const secret = (poll!.split(";")[0] ?? "").slice("bwc_qr_poll=".length);
  expect(secret.length).toBeGreaterThanOrEqual(22); // 128 位 → base64url 22 字符
  return { code: body.code, pollCookie: `bwc_qr_poll=${secret}`, rawSetCookie: poll! };
}

async function status(code: string, cookie?: string) {
  return app.inject({
    method: "GET",
    url: `/api/v1/devices/web-pair-status?code=${encodeURIComponent(code)}`,
    headers: cookie ? { cookie } : {},
  });
}

async function approveViaApp(code: string, token: string, endpoint = "/api/v1/devices/web-pair-approve") {
  return app.inject({ method: "POST", url: endpoint, headers: bearer(token), payload: { code } });
}

async function sessionCount(userId: string): Promise<number> {
  const rows = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, userId));
  return rows.length;
}

beforeAll(async () => { await ensureSchema(); });
afterAll(async () => { await app?.close(); });

beforeEach(async () => {
  await resetDb();
  await db.insert(schema.siteSettings)
    .values({ id: 1, registrationMode: "public", appsEnabled: true, captchaProvider: "none" })
    .onConflictDoNothing();
  reloadSettings();
  // API Token 认证路径受 apiEnabled 门控（verifyApiToken 里查），不开
  // 的话 Token 根本进不了 requireUserOrSend，也就测不到批准收紧。
  await updateSettings({ apiEnabled: true } as never);
  reloadSettings();
  app = await buildRoutedApp(async (a) => {
    await a.register(deviceRoutes, { prefix: "/api/v1" });
    await a.register(pairPageRoutes);
  });
});

describe("轮询秘密（配对标识与兑换凭据分离）", () => {
  it("init 种 HttpOnly + Path 限定的秘密 cookie，二维码内容不变", async () => {
    const { code, rawSetCookie } = await initPair();
    expect(rawSetCookie).toContain("HttpOnly");
    expect(rawSetCookie).toContain("Path=/api/v1/devices/web-pair-status");
    const res = await app.inject({ method: "POST", url: "/api/v1/devices/web-pair-init", payload: {} });
    const body = JSON.parse(res.body) as { approveUrl: string; code: string };
    // 二维码仍编码 /desktop-pair/<CODE>（兼容旧 App 扫码正则），且响应里不带秘密明文。
    expect(body.approveUrl.endsWith(`/desktop-pair/${body.code}`)).toBe(true);
    expect(res.body).not.toContain("pollSecret");
    expect(code).toBeTruthy();
  });

  it("无秘密轮询：与码不存在不可区分（同状态码、同响应体）", async () => {
    const { code } = await initPair();
    const noSecret = await status(code);
    const unknown = await status("ZZZZZZZZ", "bwc_qr_poll=whatever");
    expect(noSecret.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(JSON.parse(noSecret.body)).toEqual(JSON.parse(unknown.body));
  });

  it("错秘密轮询：同样 404，且不泄露 pending 状态", async () => {
    const { code } = await initPair();
    const wrong = await status(code, "bwc_qr_poll=AAAAAAAAAAAAAAAAAAAAAA");
    expect(wrong.statusCode).toBe(404);
    expect(JSON.parse(wrong.body)).toEqual({ status: "expired" });
  });

  it("带正确秘密：pending → 202", async () => {
    const { code, pollCookie } = await initPair();
    const res = await status(code, pollCookie);
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body)).toEqual({ status: "pending" });
  });

  it("全流程：批准后带秘密兑换成功，种下 bwc_sid 且只消费一次", async () => {
    const u = await makeUser("redeem@example.com");
    const { code, pollCookie } = await initPair();
    const ok = await approveViaApp(code, await deviceBearer(u.id));
    expect(ok.statusCode, ok.body.slice(0, 300)).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ ok: true, kind: "web" });

    const res = await status(code, pollCookie);
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "approved", redirectTo: "/app" });
    const sc = res.headers["set-cookie"];
    const arr = Array.isArray(sc) ? sc : sc ? [sc] : [];
    expect(arr.some((c) => c.startsWith("bwc_sid="))).toBe(true);
    expect(await sessionCount(u.id)).toBe(1);

    // 单次消费：再轮询（带秘密）也只是 404。
    const again = await status(code, pollCookie);
    expect(again.statusCode).toBe(404);
    expect(await sessionCount(u.id)).toBe(1);
  });

  it("批准后无秘密抢兑失败，且不烧掉真浏览器的兑换机会", async () => {
    const u = await makeUser("race@example.com");
    const { code, pollCookie } = await initPair();
    await approveViaApp(code, await deviceBearer(u.id));
    const stolen = await status(code); // 只有码、没有秘密
    expect(stolen.statusCode).toBe(404);
    expect(await sessionCount(u.id)).toBe(0);
    const legit = await status(code, pollCookie);
    expect(legit.statusCode).toBe(200);
    expect(await sessionCount(u.id)).toBe(1);
  });
});

describe("原子消费", () => {
  it("并发两次兑换只签出一张会话", async () => {
    const u = await makeUser("concurrent@example.com");
    const { code, pollCookie } = await initPair();
    await approveViaApp(code, await deviceBearer(u.id));
    const [r1, r2] = await Promise.all([status(code, pollCookie), status(code, pollCookie)]);
    const codes = [r1.statusCode, r2.statusCode].sort();
    expect(codes).toEqual([200, 404]);
    expect(await sessionCount(u.id)).toBe(1);
  });

  it("兑换时账号已被停用 → 403，且配对码就此消费（再轮询 404）", async () => {
    const u = await makeUser("disabled@example.com");
    const { code, pollCookie } = await initPair();
    await approveViaApp(code, await deviceBearer(u.id));
    await db.update(schema.users).set({ disabledAt: new Date() }).where(eq(schema.users.id, u.id));
    const res = await status(code, pollCookie);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ status: "account_disabled" });
    expect(await sessionCount(u.id)).toBe(0);
    const again = await status(code, pollCookie);
    expect(again.statusCode).toBe(404);
  });
});

describe("批准侧收紧（API Token 不许批准）", () => {
  it("web-pair-approve：写 Token 批准被拒，配对仍是 pending", async () => {
    const u = await makeUser("tok1@example.com");
    const { code, pollCookie } = await initPair();
    const tok = await createApiToken({ userId: u.id, label: "t", scope: "write" });
    const res = await approveViaApp(code, tok.plain);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "api_token_cannot_approve" });
    const st = await status(code, pollCookie);
    expect(st.statusCode).toBe(202);
  });

  it("desktop-pair-approve 的 webPairs 回退：写 Token 同样被拒", async () => {
    const u = await makeUser("tok2@example.com");
    const { code, pollCookie } = await initPair();
    const tok = await createApiToken({ userId: u.id, label: "t", scope: "write" });
    const res = await approveViaApp(code, tok.plain, "/api/v1/devices/desktop-pair-approve");
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "api_token_cannot_approve" });
    const st = await status(code, pollCookie);
    expect(st.statusCode).toBe(202);
  });

  it("设备令牌经 desktop-pair-approve 回退批准 web 配对仍然可以", async () => {
    const u = await makeUser("fallback@example.com");
    const { code, pollCookie } = await initPair();
    const res = await approveViaApp(code, await deviceBearer(u.id), "/api/v1/devices/desktop-pair-approve");
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, kind: "web" });
    const st = await status(code, pollCookie);
    expect(st.statusCode).toBe(200);
  });
});

describe("旧流程回归", () => {
  it("桌面配对：init → App 批准 → status 取走令牌，只消费一次", async () => {
    const u = await makeUser("desktop@example.com");
    const init = await app.inject({ method: "POST", url: "/api/v1/devices/desktop-pair-init", payload: {} });
    expect(init.statusCode, init.body.slice(0, 300)).toBe(200);
    const { code } = JSON.parse(init.body) as { code: string };

    const ok = await approveViaApp(code, await deviceBearer(u.id), "/api/v1/devices/desktop-pair-approve");
    expect(ok.statusCode, ok.body.slice(0, 300)).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ ok: true, kind: "desktop" });

    const st = await app.inject({ method: "GET", url: `/api/v1/devices/desktop-pair-status?code=${code}` });
    expect(st.statusCode, st.body.slice(0, 300)).toBe(200);
    const body = JSON.parse(st.body) as { status: string; accessToken?: string; refreshToken?: string; userId?: string };
    expect(body.status).toBe("approved");
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    expect(body.userId).toBe(u.id);

    const again = await app.inject({ method: "GET", url: `/api/v1/devices/desktop-pair-status?code=${code}` });
    expect(again.statusCode).toBe(404);
  });

  it("手机浏览器批准页路径：会话内批准后，浏览器带秘密正常兑换", async () => {
    const u = await makeUser("webpage@example.com");
    const { code, pollCookie } = await initPair();
    // 造一个已登录的手机浏览器会话（生产同一条路：sessions 表真行）。
    const sid = newSessionId();
    await db.insert(schema.sessions).values({
      id: sid, userId: u.id, mfaSatisfied: true,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const cookie = `bwc_sid=${encodeURIComponent(app.signCookie(sid))}`;
    const csrf = createHmac("sha256", process.env.SESSION_SECRET!).update(sid).digest("hex");
    const approve = await app.inject({
      method: "POST",
      url: `/web-pair/${code}/approve`,
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      payload: {},
    });
    expect(approve.statusCode, approve.body.slice(0, 300)).toBe(302);
    const st = await status(code, pollCookie);
    expect(st.statusCode, st.body.slice(0, 300)).toBe(200);
    expect(JSON.parse(st.body)).toEqual({ status: "approved", redirectTo: "/app" });
    expect(await sessionCount(u.id)).toBe(2); // 手机浏览器那条 + 新兑换的这条
  });
});
