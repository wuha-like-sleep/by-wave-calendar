// 「认领已有账号」的判定表。
//
// 这张表是三条路(浏览器 SSO / 苹果 / 外部 IdP)共用的那一份判定,所以它错一格,
// 三条路一起错。把它单独钉在这里,是因为在 HTTP 那一档里每格都要摆一套真实例 +
// 真 IdP,慢到没人愿意把八格都摆全 —— 而这种表恰恰是「少摆一格就少堵一个洞」。
//
// HTTP 那一档在 test/integration/account_claim.int.test.ts:那边验的是**路由
// 真的在用这份判定**(以及作废动作真的落到表上),这边验的是判定本身。两边都要。

import { describe, it, expect, vi } from "vitest";

// 纯逻辑档(`npm test`)里没有 Postgres:db/client 一 import 就建连接池,
// env 会校验 DATABASE_URL / SESSION_SECRET 之类的必填项。被测的那几个函数
// 全是纯的,一条 SQL 都不会打出去。
vi.mock("../src/db/client.js", () => ({ db: {}, schema: {} }));
vi.mock("../src/env.js", () => ({ env: { NODE_ENV: "test" } }));
vi.mock("../src/lib/site_settings.js", () => ({ getSettings: async () => ({}) }));

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  dbProvisioningStore,
  decideEmailClaim,
  isUnprovenSelfSignup,
  provisionAccount,
  type InsertUserValues,
  type ProvisioningStore,
  type QuotaWindow,
} from "../src/lib/account_provisioning.js";
import type * as schema from "../src/db/schema.js";

const SLUG = "keycloak";

// ---------------------------------------------------------------------------
// decideEmailClaim:八格全摆
// ---------------------------------------------------------------------------
//
// 两个输入各两种取值,加上被认领那一行的 emailVerified —— 一共八格。逐格写死,
// 不用循环生成:循环生成的表读起来看不出「哪一格是安全边界」,而这张表里
// 只有一格是 adopt_after_eviction,它就是这次要修的那个洞。

describe("decideEmailClaim：IdP 证明了邮箱", () => {
  it("这一行验过 + 不是同一个 IdP → 直接认领（密码号首次绑 SSO，最常见的一格）", () => {
    expect(decideEmailClaim({
      row: { emailVerified: true, ssoProviderSlug: null },
      claimProvider: SLUG,
      provenEmail: true,
    })).toBe("adopt");
  });

  it("这一行验过 + 同一个 IdP → 直接认领", () => {
    expect(decideEmailClaim({
      row: { emailVerified: true, ssoProviderSlug: SLUG },
      claimProvider: SLUG,
      provenEmail: true,
    })).toBe("adopt");
  });

  it("这一行没验过 + 不是同一个 IdP → 先作废再认领（**抢注就是这一格**）", () => {
    expect(decideEmailClaim({
      row: { emailVerified: false, ssoProviderSlug: null },
      claimProvider: SLUG,
      provenEmail: true,
    })).toBe("adopt_after_eviction");
  });

  it("这一行没验过 + 同一个 IdP → 直接认领，不动它自己的东西", () => {
    expect(decideEmailClaim({
      row: { emailVerified: false, ssoProviderSlug: SLUG },
      claimProvider: SLUG,
      provenEmail: true,
    })).toBe("adopt");
  });

  it("换了一个 IdP 来认领没验过的行 → 也是先作废（延续关系是按 slug 认的，不是「只要有 slug」）", () => {
    expect(decideEmailClaim({
      row: { emailVerified: false, ssoProviderSlug: "other-idp" },
      claimProvider: SLUG,
      provenEmail: true,
    })).toBe("adopt_after_eviction");
  });
});

describe("decideEmailClaim：IdP 没证明邮箱", () => {
  it("这一行上次就是从这个 IdP 进来的 → 认领（老 SSO 用户走的就是这一格）", () => {
    expect(decideEmailClaim({
      row: { emailVerified: true, ssoProviderSlug: SLUG },
      claimProvider: SLUG,
      provenEmail: false,
    })).toBe("adopt");
  });

  it("这一行没有这条历史 → 拒绝（上一轮堵的洞，这次没放开）", () => {
    expect(decideEmailClaim({
      row: { emailVerified: true, ssoProviderSlug: null },
      claimProvider: SLUG,
      provenEmail: false,
    })).toBe("refuse");
  });

  it("这一行也没验过、也没有这条历史 → 照样拒绝（两边都不成立时不许瞎认）", () => {
    expect(decideEmailClaim({
      row: { emailVerified: false, ssoProviderSlug: null },
      claimProvider: SLUG,
      provenEmail: false,
    })).toBe("refuse");
  });
});

describe("decideEmailClaim：苹果这类没有 slug 的来路", () => {
  // claimProvider 传 null 的意思是「我拿不出任何延续关系」。这一条必须单独钉住:
  // 把 null 当成「跟 null 相等所以是延续」写的话,苹果就能无条件认领任何
  // ssoProviderSlug 为空的账号 —— 也就是本站绝大多数账号。
  it("null 不跟 ssoProviderSlug 为 null 的行凑成「延续」", () => {
    expect(decideEmailClaim({
      row: { emailVerified: false, ssoProviderSlug: null },
      claimProvider: null,
      provenEmail: true,
    })).toBe("adopt_after_eviction");
  });

  it("没有断言又没有 slug → 拒绝（苹果没验过 / 私有转发地址走的就是这一格）", () => {
    expect(decideEmailClaim({
      row: { emailVerified: true, ssoProviderSlug: null },
      claimProvider: null,
      provenEmail: false,
    })).toBe("refuse");
  });
});

// ---------------------------------------------------------------------------
// isUnprovenSelfSignup
// ---------------------------------------------------------------------------

describe("isUnprovenSelfSignup：抢注留下的形状", () => {
  it("自助注册 + 没验过 → 是", () => {
    expect(isUnprovenSelfSignup({ emailVerified: false, signupSource: "self" })).toBe(true);
    expect(isUnprovenSelfSignup({ emailVerified: false, signupSource: "invite" })).toBe(true);
  });

  it("验过了就不是（验过说明这个邮箱已经有人证明过归谁）", () => {
    expect(isUnprovenSelfSignup({ emailVerified: true, signupSource: "self" })).toBe(false);
  });

  it("SSO / IdP / 苹果 / 管理员开的号都不是（那些不是自助注册出来的）", () => {
    for (const src of ["sso:keycloak", "idp:meeting-platform", "apple", "admin"]) {
      expect(isUnprovenSelfSignup({ emailVerified: false, signupSource: src }), src).toBe(false);
    }
  });

  it("signup_source 为 null 的存量行不算", () => {
    // 这一列是后加的、明确不回填。把「不知道」当成「自助注册」的话,一整批
    // 老账号会在外部 IdP 那条路上被挡死,而他们什么都没做错。
    expect(isUnprovenSelfSignup({ emailVerified: false, signupSource: null })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 门禁:生产那份 store 必须带并发安全的配额插入
// ---------------------------------------------------------------------------
//
// insertUserWithinQuota 在端口上是**可选**的(喂假 store 的纯逻辑测试背后没有
// Postgres,谈不上并发),而可选就意味着「生产那份哪天被删掉也编译得过、跑得过、
// 只是配额悄悄变回先数再插」。这条断言就是拿来堵这个的。

describe("配额并发：生产 store 的门禁", () => {
  it("dbProvisioningStore 上带着 insertUserWithinQuota", () => {
    expect(typeof dbProvisioningStore.insertUserWithinQuota).toBe("function");
  });

  it("它接两个参数（values + 窗口）—— 少一个就说明窗口又被塞回全局了", () => {
    expect(dbProvisioningStore.insertUserWithinQuota!.length).toBe(2);
  });

  // 下面这条是**读源码**的门禁,写成这样有一个具体的理由,不是偷懒:
  //
  // 行锁(`.for("update")`)在 PGlite 上测不出来。PGlite 只有一条连接,事务本来
  // 就是排队跑的 —— 把 `.for("update")` 删掉,整个并发那一档照样全绿(已实测)。
  // 它真正起作用的是「多连接的真 Postgres」,而这套测试里没有那个东西。
  //
  // 于是只剩两条路:要么不写(那么哪天有人顺手删掉这行,线上的配额就静默退回
  // 超发,而且是本地永远复现不了的那种),要么盯源码。盯源码这条至少是能红的。
  it("配额插入必须是「事务 + 行锁」，不是裸的两句 SQL", () => {
    const src = readFileSync(path.resolve("src/lib/account_provisioning.ts"), "utf8");
    const at = src.indexOf("async insertUserWithinQuota(");
    expect(at, "找不到 insertUserWithinQuota 的实现").toBeGreaterThan(0);
    // 截到下一个方法之前:整段实现都要在这一段里。
    const body = src.slice(at, src.indexOf("\n  async createDefaultCalendar(", at));
    expect(body.length, "截出来的实现是空的").toBeGreaterThan(200);
    expect(body, "数和插必须在同一个事务里").toContain("db.transaction(");
    expect(body, "缺了行锁 = 并发下两个事务各数各的").toContain('.for("update")');
  });
});

// ---------------------------------------------------------------------------
// 收口函数把配额插入接上了没有
// ---------------------------------------------------------------------------
//
// 上面那组盯的是「那段 SQL 对不对」,这一组盯的是「配额开着的时候,收口函数
// 到底走不走它」。两件事各坏各的:SQL 写得再对,provisionAccount 里那个分支
// 改回 store.insertUser,配额就又是先数再插了 —— 而这种改动在 HTTP 那一档上
// 是全绿的(PGlite 复现不了竞态,见 test/integration/signup_quota_race.int.test.ts
// 顶上那段)。

describe("配额开着时，收口函数走的是那条带锁的插入", () => {
  type Calls = { plain: number; quota: Array<{ values: InsertUserValues; window: QuotaWindow }> };

  function makeStore(quota: number, over = false): { store: ProvisioningStore; calls: Calls } {
    const calls: Calls = { plain: 0, quota: [] };
    const mkRow = (values: InsertUserValues) => ({ ...values, id: "u1", createdAt: new Date() }) as unknown as schema.User;
    const store: ProvisioningStore = {
      async loadGateSettings() {
        return { registrationMode: "public", signupDomainAllowlist: "", signupDailyQuota: quota };
      },
      async findUserByEmail() { return undefined; },
      async insertUser(values) { calls.plain++; return mkRow(values); },
      async insertUserWithinQuota(values, window) {
        calls.quota.push({ values, window });
        return over ? { over: true } : { over: false, user: mkRow(values) };
      },
      async createDefaultCalendar() { /* 建默认日历跟这一组无关 */ },
      async countUsersCreatedSince() { return 0; },
      async validateInvite() { return { ok: false, reason: "not_found" }; },
      async consumeInvite() { return { ok: true }; },
      async recordQuotaBlock() { /* 下面单独断言 */ },
    };
    return { store, calls };
  }

  const req = { email: "a@example.com", origin: { kind: "self" } as const, emailVerified: false, passwordHash: "h" };

  it("配额 > 0：走 insertUserWithinQuota，不走裸的 insertUser", async () => {
    const { store, calls } = makeStore(5);
    const r = await provisionAccount(req, store);
    expect(r.ok).toBe(true);
    expect(calls.quota).toHaveLength(1);
    expect(calls.plain, "还在走两步式那条").toBe(0);
    expect(calls.quota[0]!.window.max).toBe(5);
  });

  it("配额 = 0（关着）：不去打那条带锁的插入，省掉每次建号的事务", async () => {
    const { store, calls } = makeStore(0);
    await provisionAccount(req, store);
    expect(calls.plain).toBe(1);
    expect(calls.quota).toHaveLength(0);
  });

  it("带锁的插入说满了 → 回 daily_quota_reached，并留下一条审计", async () => {
    const { store } = makeStore(2, true);
    const audits: unknown[] = [];
    store.recordQuotaBlock = async (entry) => { audits.push(entry); };
    const r = await provisionAccount(req, store);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason.code).toBe("daily_quota_reached");
    // 「拒绝要留一条可见记录」——粗判那一层拒绝时会写,细判这一层也必须写,
    // 否则并发下被挡掉的那些人在后台一条都看不见。
    expect(audits).toHaveLength(1);
  });
});
