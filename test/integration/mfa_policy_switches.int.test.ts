// 两个两步验证策略开关到底改不改变行为 —— 落点在 sessions 表的 mfa_satisfied 上。
//
// 这一档要防的是「开关存进库里了，但没有任何地方读它」。本仓库为这个形状
// 付过账：OAuth 的 scope 被记录、被展示，就是从来没被执行过；
// 后台那排勾选框看着像在起作用，实际是假的。
//
// 所以断言不看后台页面、不看 getSettings 的返回值，只看**同一次登录**在
// 开关两种状态下写进 sessions 行的 mfa_satisfied 是不是不一样。

import { vi, beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./security_harness.js");
  return { db: h.db, schema: h.schema };
});

import { eq } from "drizzle-orm";
import { ensureSchema, resetDb, db, schema, pg } from "./security_harness.js";

const PW = "Correct-Horse-9";

/** 直接写 site_settings 第 1 行并清进程内缓存。
 *  必须走真表 + reloadSettings()：被测代码读的是带缓存的 getSettings()，
 *  直接 mock 掉的话「有没有人真的去读这个开关」就看不见了 —— 而那正是这一档要防的。 */
async function setSwitches(v: { requirePasskeyUv?: boolean; ssoSatisfiesMfa?: boolean }) {
  const { reloadSettings } = await import("../../src/lib/site_settings.js");
  const row = {
    id: 1,
    requirePasskeyUv: v.requirePasskeyUv ?? true,
    ssoSatisfiesMfa: v.ssoSatisfiesMfa ?? true,
  };
  await db.insert(schema.siteSettings).values(row).onConflictDoUpdate({
    target: schema.siteSettings.id,
    set: { requirePasskeyUv: row.requirePasskeyUv, ssoSatisfiesMfa: row.ssoSatisfiesMfa },
  });
  reloadSettings();
}

async function seedUser(email: string, mfaEnabled: boolean) {
  const { hashPassword } = await import("../../src/lib/password.js");
  const [u] = await db.insert(schema.users).values({
    email, passwordHash: await hashPassword(PW), emailVerified: true,
    mfaEnabled, mfaTotpSecret: mfaEnabled ? "JBSWY3DPEHPK3PXP" : null,
  }).returning({ id: schema.users.id });
  return u!.id;
}

/** 假的 reply —— createSession 只会用到 setCookie。 */
function fakeReply() {
  const cookies: Array<{ name: string; value: string }> = [];
  return {
    cookies,
    setCookie(name: string, value: string) { cookies.push({ name, value }); return this; },
  } as unknown as Parameters<
    Awaited<typeof import("../../src/lib/session.js")>["createSession"]
  >[0] & { cookies: Array<{ name: string; value: string }> };
}

async function mfaSatisfiedOf(userId: string): Promise<boolean | undefined> {
  const rows = await db.select({ m: schema.sessions.mfaSatisfied })
    .from(schema.sessions).where(eq(schema.sessions.userId, userId));
  expect(rows.length, "没建出会话行 —— 这条用例什么也没断言到").toBe(1);
  return rows[0]!.m;
}

beforeAll(async () => { await ensureSchema(); });
afterAll(async () => { await pg?.close(); });
beforeEach(async () => { await resetDb(); });

describe("开关一：Passkey 必须做过用户验证", () => {
  it("开着 + 钥匙没验人 + 账号开了两步验证 → 只算密码，拿到半登录会话", async () => {
    await setSwitches({ requirePasskeyUv: true });
    const id = await seedUser("a@example.com", true);
    const { createSession } = await import("../../src/lib/session.js");
    await createSession(fakeReply(), id, { kind: "passkey", userVerified: false });
    expect(
      await mfaSatisfiedOf(id),
      "没验人的 passkey 被当成了「两个因素都过了」",
    ).toBe(false);
  });

  it("开着 + 钥匙验了人 → 照常算通过（证明不是一刀切全降级）", async () => {
    await setSwitches({ requirePasskeyUv: true });
    const id = await seedUser("b@example.com", true);
    const { createSession } = await import("../../src/lib/session.js");
    await createSession(fakeReply(), id, { kind: "passkey", userVerified: true });
    expect(await mfaSatisfiedOf(id)).toBe(true);
  });

  it("开着 + 钥匙没验人 + 账号**没**开两步验证 → 照常登录（这条开关不关任何人在门外）", async () => {
    await setSwitches({ requirePasskeyUv: true });
    const id = await seedUser("c@example.com", false);
    const { createSession } = await import("../../src/lib/session.js");
    await createSession(fakeReply(), id, { kind: "passkey", userVerified: false });
    expect(
      await mfaSatisfiedOf(id),
      "没开两步验证的人被这个开关挡住了 —— 那就不是「不会关人在门外」了",
    ).toBe(true);
  });

  it("关掉之后，没验人的钥匙又等同于两步验证了（开关真的被读了）", async () => {
    await setSwitches({ requirePasskeyUv: false });
    const id = await seedUser("d@example.com", true);
    const { createSession } = await import("../../src/lib/session.js");
    await createSession(fakeReply(), id, { kind: "passkey", userVerified: false });
    expect(
      await mfaSatisfiedOf(id),
      "关掉开关没有生效 —— 说明这个开关存进了库里但没人读它",
    ).toBe(true);
  });
});

describe("开关二：SSO 算作已通过两步验证", () => {
  it("开着（默认）→ SSO 登录直接是完整会话", async () => {
    await setSwitches({ ssoSatisfiesMfa: true });
    const id = await seedUser("e@example.com", true);
    const { createSession } = await import("../../src/lib/session.js");
    await createSession(fakeReply(), id, { kind: "sso", slug: "keycloak" });
    expect(await mfaSatisfiedOf(id)).toBe(true);
  });

  it("关掉 + 账号开了两步验证 → SSO 登录完仍要补验证码", async () => {
    await setSwitches({ ssoSatisfiesMfa: false });
    const id = await seedUser("f@example.com", true);
    const { createSession } = await import("../../src/lib/session.js");
    await createSession(fakeReply(), id, { kind: "sso", slug: "keycloak" });
    expect(
      await mfaSatisfiedOf(id),
      "关掉开关没有生效 —— SSO 仍然整条绕过了本站的两步验证",
    ).toBe(false);
  });

  it("关掉 + 账号没开两步验证 → 照常登录（没什么可补的）", async () => {
    await setSwitches({ ssoSatisfiesMfa: false });
    const id = await seedUser("g@example.com", false);
    const { createSession } = await import("../../src/lib/session.js");
    await createSession(fakeReply(), id, { kind: "sso", slug: "keycloak" });
    expect(await mfaSatisfiedOf(id)).toBe(true);
  });
});

describe("两个开关都不该碰别的登录方式", () => {
  it("当场验过 TOTP 的会话，不受任何开关影响", async () => {
    await setSwitches({ requirePasskeyUv: true, ssoSatisfiesMfa: false });
    const id = await seedUser("h@example.com", true);
    const { createSession } = await import("../../src/lib/session.js");
    await createSession(fakeReply(), id, { kind: "totp" });
    expect(await mfaSatisfiedOf(id)).toBe(true);
  });

  it("上游已验过的（扫码配对换会话）也不受影响", async () => {
    await setSwitches({ requirePasskeyUv: true, ssoSatisfiesMfa: false });
    const id = await seedUser("i@example.com", true);
    const { createSession } = await import("../../src/lib/session.js");
    await createSession(fakeReply(), id, { kind: "delegated", why: "测试" });
    expect(await mfaSatisfiedOf(id)).toBe(true);
  });

  it("密码登录仍然只看账号有没有开两步验证", async () => {
    await setSwitches({ requirePasskeyUv: false, ssoSatisfiesMfa: true });
    const id = await seedUser("j@example.com", true);
    const { createSession } = await import("../../src/lib/session.js");
    await createSession(fakeReply(), id, { kind: "password" });
    expect(
      await mfaSatisfiedOf(id),
      "两个开关串到密码那条路上去了 —— 它们不该影响密码登录",
    ).toBe(false);
  });
});
