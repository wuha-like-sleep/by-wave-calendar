// 同一个 Apple ID 下的 iPhone 和 iPad 不能互相把对方挤下线 —— 从 HTTP 打进去。
//
// iOS 把设备编号存在走 iCloud 同步的钥匙串里，于是 iPhone 和 iPad 拿到**同一个**
// 编号。服务端原来只按编号认设备：在 iPad 上登录被当成「iPhone 重新登录」，
// 原地换掉 iPhone 的刷新令牌 —— iPhone 一小时内被踢，提示还是「密码已更改或此设备
// 已被移除」；再回 iPhone 登一次，iPad 又被踢。
//
// 判据落在**刷新令牌还能不能用**上：那才是用户会不会被踢的直接原因。

import { vi, beforeAll, beforeEach, afterEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
vi.mock("../../src/lib/mailer.js", () => ({
  sendMail: vi.fn(async () => ({ ok: true })), isMailerEnabled: vi.fn(async () => true),
}));

import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { ensureSchema, resetDb, db, schema, buildRoutedApp, makeUser } from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const { deviceRoutes } = await import("../../src/routes/devices.js");
const { hashPassword } = await import("../../src/lib/password.js");

beforeAll(async () => { await ensureSchema(); });
let app: FastifyInstance;
let userId: string;

beforeEach(async () => {
  await resetDb();
  const { reloadSettings } = await import("../../src/lib/site_settings.js");
  const v = { registrationMode: "public", appsEnabled: true, captchaProvider: "none" };
  await db.insert(schema.siteSettings).values({ id: 1, ...v }).onConflictDoUpdate({ target: schema.siteSettings.id, set: v });
  reloadSettings();
  app = await buildRoutedApp(deviceRoutes, { prefix: "/api/v1" });
  const u = await makeUser("owner@example.com");
  await db.update(schema.users).set({ passwordHash: await hashPassword("Passw0rd!long") }).where(eq(schema.users.id, u.id));
  userId = u.id;
});
afterEach(async () => { await app.close(); });

/** 同一个 Apple ID 同步下来的编号 —— 两台设备一模一样。 */
const SHARED_ID = "a".repeat(32);

async function login(label: string, clientDeviceId = SHARED_ID) {
  const res = await app.inject({
    method: "POST", url: "/api/v1/auth/login-password",
    payload: { email: "owner@example.com", password: "Passw0rd!long", label, kind: "ios", clientDeviceId },
  });
  expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
  return JSON.parse(res.body) as { refreshToken: string; deviceId: string };
}
async function refreshWorks(refreshToken: string) {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/refresh", payload: { refreshToken } });
  return res.statusCode === 200;
}
const liveDevices = async () =>
  (await db.select().from(schema.devices).where(eq(schema.devices.userId, userId))).filter((d) => !d.revokedAt);

describe("共用同一个设备编号的两台设备", () => {
  it("同一台设备退出后再登回来，不会多一行（presence —— 原有的去重没被弄坏）", async () => {
    const first = await login("iPhone (iPhone)");
    const second = await login("iPhone (iPhone)");
    expect(second.deviceId, "同一台设备登两次变成了两行 —— 「我的设备」每登一次就多一台").toBe(first.deviceId);
    expect((await liveDevices()).length).toBe(1);
  });

  it("**在 iPad 上登录，iPhone 不会被挤下线**（这条是核心）", async () => {
    const phone = await login("iPhone (iPhone)");
    expect(await refreshWorks(phone.refreshToken), "iPhone 的令牌一开始就不能用 —— 下面没意义").toBe(true);

    const pad = await login("iPad (iPad)");
    expect(pad.deviceId, "iPad 被当成了 iPhone 重新登录").not.toBe(phone.deviceId);
    expect(
      await refreshWorks(phone.refreshToken),
      "iPad 登录之后 iPhone 的令牌失效了 —— iPhone 一小时内被踢下线，" +
        "提示还说是「密码已更改或此设备已被移除」",
    ).toBe(true);
    expect(await refreshWorks(pad.refreshToken), "iPad 自己的令牌也得能用").toBe(true);
    expect((await liveDevices()).length, "「我的设备」里应当看到两台").toBe(2);
  });
});
