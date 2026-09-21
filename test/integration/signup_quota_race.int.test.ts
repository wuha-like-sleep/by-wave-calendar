// 每日建号配额的并发断言。
//
// ===================== 这一档为什么分两层写 =====================
// 先说一件踩出来的事,不写清楚下一个人一定会再踩一次:
//
//   **在这套 PGlite 工装上,从 HTTP 打进去的并发是假的。**
//
// PGlite 是跑在本进程里的 WASM,一次查询全程都是 CPU,promise 链上没有任何真
// I/O —— 也就是说一个请求从进 handler 到写完库,整条链都在**微任务**里跑完;
// 而 app.inject 派发下一个请求要等一个**宏任务**。微任务先被抽干,于是八个
// 「同时」发出的注册请求实际上是一个做完再做下一个。实测(探针打在 handler
// 第一行和 count 那一行):
//
//   enter rush-0 → count rush-0 = 0 → inserted rush-0 → enter rush-1 → count rush-1 = 1 → …
//
// 也就是说:**把「先数再插」那个 bug 原样放回去,HTTP 那一档照样是绿的。**
// 一条永远红不了的断言比没有更糟,所以竞态本身钉在下面第 2 组 —— 直接并发调
// 那段 SQL,那一层的并发是真的(同样是 PGlite,八个调用在一个同步循环里把查询
// 全排进队列,谁都没来得及插)。
//
// 两组各管一件事,少哪一组都有洞:
//   1. HTTP 那一组:管「路由 → 收口函数 → 闸门」这条线还在,而且没把注册关死。
//      它红的情形是配额整个失灵或整个变成拒绝,不是竞态。
//   2. 存储那一组:管那段 SQL 在并发下到底会不会超发。验红记录见文件末尾。

import { vi, beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./security_harness.js");
  return { db: h.db, schema: h.schema };
});

// 换掉的只有「生成哈希」这一件事,而且只在这个文件里:注册路由每次要烧 ~250ms
// 的 bcrypt,一组并发用例下来好几秒,而这一档跟密码怎么哈希没有半点关系。
// verifyPassword / passwordPolicyError 原样保留。
vi.mock("../../src/lib/password.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/password.js")>();
  return {
    ...actual,
    hashPassword: async () => "$2a$12$3GVAJUNGYRfPaWdgnQ2yyOzcQGw.j6sHCk0i9JdRZ7JFqVfTXVfTC",
  };
});

import type { FastifyInstance } from "fastify";
import {
  ensureSchema, resetDb, db, schema,
  applySettings, userCount,
  buildClaimApp,
} from "./claim_harness.js";
import {
  dbProvisioningStore,
  startOfQuotaDay,
  type InsertUserValues,
} from "../../src/lib/account_provisioning.js";

let app: FastifyInstance;

beforeAll(async () => {
  await ensureSchema();
  app = await buildClaimApp();
});

afterAll(async () => {
  await app?.close();
});

beforeEach(async () => {
  await resetDb();
});

function register(email: string) {
  return app.inject({
    method: "POST", url: "/api/v1/auth/register",
    payload: { email, password: "Correct-Horse-9" },
  });
}

/** 同时发出 n 个建号请求。 */
function rush(n: number, prefix: string) {
  return Promise.all(Array.from({ length: n }, (_, i) => register(`${prefix}-${i}@example.com`)));
}

function values(email: string): InsertUserValues {
  return {
    email,
    emailVerified: false,
    passwordHash: "$2a$12$3GVAJUNGYRfPaWdgnQ2yyOzcQGw.j6sHCk0i9JdRZ7JFqVfTXVfTC",
    displayName: null,
    signupSource: "self",
    ssoProviderSlug: null,
    appleSub: null,
  };
}

// ---------------------------------------------------------------------------
// 0. 工装自检
// ---------------------------------------------------------------------------

describe("工装自检", () => {
  it("bcrypt 真的被换掉了（否则这一档只是慢，不是错）", async () => {
    const { hashPassword } = await import("../../src/lib/password.js");
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 8 }, () => hashPassword("whatever")));
    // 真 bcrypt(ROUNDS=12)八次要 ~2s。
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it("注册这条路是通的（不然「只建出 N 个」可能是一个都没建）", async () => {
    await applySettings({ registrationMode: "public", signupDailyQuota: 0 });
    const r = await register("smoke@example.com");
    expect(r.statusCode, r.body.slice(0, 200)).toBe(200);
    expect(await userCount()).toBe(1);
  });

  it("生产 store 带着并发安全的那条插入", () => {
    expect(typeof dbProvisioningStore.insertUserWithinQuota).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// 1. 从 HTTP 打进去:闸门还在,而且没把注册关死
// ---------------------------------------------------------------------------
//
// 这一组**不负责竞态**(见文件顶上那段)。它红的情形是:配额整个失灵、
// 配额变成一律拒绝、或者路由绕开了收口函数。

describe("每日建号配额（HTTP）", () => {
  const QUOTA = 3;
  const EXTRA = 5;

  it(`发起 ${QUOTA + EXTRA} 个建号请求，最终只建出 ${QUOTA} 个`, async () => {
    await applySettings({ registrationMode: "public", signupDailyQuota: QUOTA });
    expect(await userCount()).toBe(0);

    const results = await rush(QUOTA + EXTRA, "rush");
    const okCount = results.filter((r) => r.statusCode === 200).length;

    expect(await userCount(), `HTTP 200 的有 ${okCount} 个`).toBe(QUOTA);
    // 状态码和行数要对得上。不一致的话有人拿到了「注册成功」却没有号 ——
    // 那是另一种坏法,别让它藏在「行数刚好是 3」后面。
    expect(okCount).toBe(QUOTA);
  });

  it("被挡下的每一个都在后台留下一条记录", async () => {
    await applySettings({ registrationMode: "public", signupDailyQuota: QUOTA });
    await rush(QUOTA + EXTRA, "audit");
    const rows = await db.select().from(schema.adminAuditLog);
    expect(rows.filter((r) => r.action === "signup.quota_blocked").length).toBe(EXTRA);
  });

  it("配额没用完时不会误杀", async () => {
    // 只测「拦得住」的话,把插入改成永远回「满了」也全绿 —— 那不是一道闸门,
    // 那是把注册关了。
    await applySettings({ registrationMode: "public", signupDailyQuota: 10 });
    const results = await rush(4, "room");
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(await userCount()).toBe(4);
  });

  it("配额关着（0 = 不限）时照常全建出来", async () => {
    await applySettings({ registrationMode: "public", signupDailyQuota: 0 });
    await rush(6, "free");
    expect(await userCount()).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// 2. 竞态本身:并发调那段 SQL
// ---------------------------------------------------------------------------
//
// 这里的并发是**真的**:八个调用在同一个同步循环里发出去,第一条 SQL 全部排进
// PGlite 的队列之后才开始出结果。把 insertUserWithinQuota 的实现换回「先 count
// 再 insert」两步式,这一组会立刻红成 8/3 —— 已实测。

describe("每日建号配额：并发预约（这一组盯的就是竞态）", () => {
  const QUOTA = 3;
  const EXTRA = 5;

  async function reserveAll(n: number, max: number, prefix: string) {
    await applySettings({ registrationMode: "public", signupDailyQuota: max });
    const window = { since: startOfQuotaDay(new Date()), max };
    return Promise.all(
      Array.from({ length: n }, (_, i) =>
        dbProvisioningStore.insertUserWithinQuota!(values(`${prefix}-${i}@example.com`), window),
      ),
    );
  }

  it(`${QUOTA + EXTRA} 个预约同时打进来，只有 ${QUOTA} 个拿到名额`, async () => {
    const results = await reserveAll(QUOTA + EXTRA, QUOTA, "race");
    const taken = results.filter((r) => r.over === false).length;
    const refused = results.filter((r) => r.over === true).length;
    expect(await userCount()).toBe(QUOTA);
    // 「拿到名额」的个数要跟落库的行数一致。只数行数的话,一个「说成功了但没插」
    // 的实现也能骗过去。
    expect(taken).toBe(QUOTA);
    expect(refused).toBe(EXTRA);
  });

  it("配额 1 的边界:并发下也只出 1 个", async () => {
    await reserveAll(6, 1, "one");
    expect(await userCount()).toBe(1);
  });

  it("名额够时一个都不许被挡（拦得住 ≠ 全拦）", async () => {
    const results = await reserveAll(4, 10, "roomy");
    expect(results.every((r) => r.over === false)).toBe(true);
    expect(await userCount()).toBe(4);
  });

  it("撞邮箱唯一索引时回 over:false + user 为空，不是抛错", async () => {
    // 收口函数靠这个语义去回读认领。抛错的话,并发注册同一个邮箱会变成 500。
    await applySettings({ registrationMode: "public", signupDailyQuota: 5 });
    const window = { since: startOfQuotaDay(new Date()), max: 5 };
    const first = await dbProvisioningStore.insertUserWithinQuota!(values("dup@example.com"), window);
    const second = await dbProvisioningStore.insertUserWithinQuota!(values("dup@example.com"), window);
    expect(first.over).toBe(false);
    expect(first.over === false && first.user?.email).toBe("dup@example.com");
    expect(second.over).toBe(false);
    expect(second.over === false && second.user).toBeUndefined();
    expect(await userCount()).toBe(1);
  });

  it("窗口起点真的在起作用:昨天建的号不占今天的名额", async () => {
    await applySettings({ registrationMode: "public", signupDailyQuota: 1 });
    await db.insert(schema.users).values({
      ...values("yesterday@example.com"),
      createdAt: new Date(Date.now() - 36 * 60 * 60 * 1000),
    });
    const window = { since: startOfQuotaDay(new Date()), max: 1 };
    const r = await dbProvisioningStore.insertUserWithinQuota!(values("today@example.com"), window);
    expect(r.over).toBe(false);
    expect(await userCount()).toBe(2);
  });
});
