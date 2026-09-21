import { describe, it, expect, vi, beforeEach } from "vitest";

// 纯逻辑档(`npm test`)里没有 Postgres:db/client 一 import 就建连接池,
// env 会校验 DATABASE_URL / SESSION_SECRET 之类的必填项。
// site_settings 只被 dbStore 用到,这里全程喂假 store,挡掉它省一串传递依赖。
vi.mock("../src/db/client.js", () => ({ db: {}, schema: {} }));
vi.mock("../src/env.js", () => ({ env: { NODE_ENV: "test" } }));
vi.mock("../src/lib/site_settings.js", () => ({ getSettings: async () => ({}) }));

import {
  provisionAccount,
  emailDomainAllowed,
  signupSourceFor,
  startOfQuotaDay,
  type ProvisioningStore,
  type SignupGateSettings,
  type SignupOrigin,
  type InsertUserValues,
} from "../src/lib/account_provisioning.js";
import type { InviteValidation } from "../src/lib/signup_invite.js";
import type * as schema from "../src/db/schema.js";

// bcrypt 在 ROUNDS=12 上一次要 ~250ms。绝大多数用例关心的不是占位串怎么来的,
// 所以默认喂一个现成的哈希;只有「无密码账号」那条用例故意不传,单独去验。
const PRESET_HASH = "$2a$12$3GVAJUNGYRfPaWdgnQ2yyOzcQGw.j6sHCk0i9JdRZ7JFqVfTXVfTC";

// ---------------------------------------------------------------------------
// 假 store
//
// 三个地方是**照抄真 SQL 的口径**写的,不照抄就会是假绿:
//   - insertUser 撞邮箱返回 undefined(= onConflictDoNothing),不是抛错;
//   - countUsersCreatedSince 真的按 since 过滤(不过滤的话「跨天重置」那条
//     用例把重置逻辑删了也不会红 —— 窗口是这一层收的);
//   - findUserByEmail 按小写邮箱精确匹配(users_email_unique 就是这么建的)。
// ---------------------------------------------------------------------------

type FakeUser = schema.User & { createdAt: Date };

type Fake = {
  store: ProvisioningStore;
  users: FakeUser[];
  calendars: string[];
  audits: Array<{ email: string; source: string; quota: number; ip: string | null; userAgent: string | null }>;
  consumed: Array<{ token: string; email: string }>;
  inserts: InsertUserValues[];
  calls: { countSince: number; validateInvite: number };
  lastCountSince: Date | null;
  settings: SignupGateSettings;
  invites: Map<string, InviteValidation>;
};

const OK_INVITE: InviteValidation = { ok: true, invite: {} as schema.SignupInvite };

function makeFake(overrides: Partial<SignupGateSettings> = {}): Fake {
  const f: Fake = {
    store: null as unknown as ProvisioningStore,
    users: [],
    calendars: [],
    audits: [],
    consumed: [],
    inserts: [],
    calls: { countSince: 0, validateInvite: 0 },
    lastCountSince: null,
    settings: {
      registrationMode: "public",
      signupDomainAllowlist: "",
      signupDailyQuota: 0,
      ...overrides,
    },
    invites: new Map(),
  };
  let seq = 0;
  f.store = {
    async loadGateSettings() {
      return f.settings;
    },
    async findUserByEmail(email) {
      return f.users.find((u) => u.email === email);
    },
    async insertUser(values) {
      f.inserts.push(values);
      // 唯一索引有两个:email 和 apple_sub。两个都要吃。
      if (f.users.some((u) => u.email === values.email)) return undefined;
      if (values.appleSub && f.users.some((u) => u.appleSub === values.appleSub)) return undefined;
      const row = {
        ...values,
        id: `u${++seq}`,
        createdAt: new Date(),
      } as unknown as FakeUser;
      f.users.push(row);
      return row;
    },
    async createDefaultCalendar(userId) {
      f.calendars.push(userId);
    },
    async countUsersCreatedSince(since) {
      f.calls.countSince++;
      f.lastCountSince = since;
      return f.users.filter((u) => u.createdAt.getTime() >= since.getTime()).length;
    },
    async validateInvite(token) {
      f.calls.validateInvite++;
      return f.invites.get(token) ?? { ok: false, reason: "not_found" };
    },
    async consumeInvite(token, email) {
      f.consumed.push({ token, email });
      return { ok: true };
    },
    async recordQuotaBlock(entry) {
      f.audits.push(entry);
    },
  };
  return f;
}

/** 预置一行「已经存在的老账号」。createdAt 可指定,用来构造跨天场景。 */
function seedUser(f: Fake, email: string, createdAt = new Date(), extra: Partial<FakeUser> = {}): FakeUser {
  const row = {
    id: `seed-${f.users.length + 1}`,
    email,
    emailVerified: true,
    passwordHash: PRESET_HASH,
    displayName: null,
    signupSource: null,
    ssoProviderSlug: null,
    appleSub: null,
    createdAt,
    ...extra,
  } as unknown as FakeUser;
  f.users.push(row);
  return row;
}

const ALL_ORIGINS: SignupOrigin[] = [
  { kind: "self" },
  { kind: "sso", slug: "keycloak" },
  { kind: "idp", client: "svc-a" },
  { kind: "apple", sub: "apple-sub-1" },
  { kind: "admin" },
];

function req(origin: SignupOrigin, over: Record<string, unknown> = {}) {
  return {
    email: "new@example.com",
    origin,
    emailVerified: true,
    passwordHash: PRESET_HASH,
    ...over,
  } as Parameters<typeof provisionAccount>[0];
}

// ---------------------------------------------------------------------------

describe("闸门 a:注册策略 closed", () => {
  // 逐个来源各一条。以前只有网页表单看这个开关,SSO / IdP / Apple 三条路
  // 对它完全免疫 —— 外部 IdP 45 天建出 30 个号就是从那儿进来的。
  for (const origin of ALL_ORIGINS) {
    it(`closed 时拒绝来源 ${origin.kind}`, async () => {
      const f = makeFake({ registrationMode: "closed" });
      const r = await provisionAccount(req(origin), f.store);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason.code).toBe("registration_closed");
      expect(f.inserts).toHaveLength(0);
      expect(f.users).toHaveLength(0);
    });
  }

  it("closed 也拦不住已有账号登录(已有账号不过闸门)", async () => {
    const f = makeFake({ registrationMode: "closed" });
    seedUser(f, "old@example.com");
    const r = await provisionAccount(req({ kind: "sso", slug: "keycloak" }, { email: "old@example.com" }), f.store);
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.created).toBe(false);
    expect(f.inserts).toHaveLength(0);
  });
});

describe("闸门 a:注册策略 invite", () => {
  it("没有邀请码 → invite_required,不建号", async () => {
    const f = makeFake({ registrationMode: "invite" });
    const r = await provisionAccount(req({ kind: "self" }), f.store);
    expect(r.ok === false && r.reason.code).toBe("invite_required");
    expect(f.inserts).toHaveLength(0);
  });

  it("SSO 这类带不出邀请码的来源在 invite 模式下同样被拦", async () => {
    const f = makeFake({ registrationMode: "invite" });
    const r = await provisionAccount(req({ kind: "sso", slug: "keycloak" }), f.store);
    expect(r.ok === false && r.reason.code).toBe("invite_required");
    expect(f.inserts).toHaveLength(0);
  });

  it("有效邀请码 → 建号成功,且邀请码被消费一次", async () => {
    const f = makeFake({ registrationMode: "invite" });
    f.invites.set("tok-ok", OK_INVITE);
    const r = await provisionAccount(req({ kind: "self" }, { inviteToken: "tok-ok" }), f.store);
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.created).toBe(true);
    expect(r.ok === true && r.inviteConsumed).toBe(true);
    expect(f.consumed).toEqual([{ token: "tok-ok", email: "new@example.com" }]);
  });

  it("用掉邀请码建出来的号,来源记成 invite 而不是 self", async () => {
    const f = makeFake({ registrationMode: "invite" });
    f.invites.set("tok-ok", OK_INVITE);
    const r = await provisionAccount(req({ kind: "self" }, { inviteToken: "tok-ok" }), f.store);
    expect(r.ok === true && r.source).toBe("invite");
    expect(f.inserts[0]!.signupSource).toBe("invite");
  });

  for (const reason of ["exhausted", "expired", "revoked", "not_found", "email_mismatch"] as const) {
    it(`邀请码 ${reason} → 拒绝且原因原样透传,不建号不消费`, async () => {
      const f = makeFake({ registrationMode: "invite" });
      f.invites.set("tok-bad", { ok: false, reason });
      const r = await provisionAccount(req({ kind: "self" }, { inviteToken: "tok-bad" }), f.store);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason.code).toBe("invite_invalid");
      expect(r.ok === false && r.reason.code === "invite_invalid" && r.reason.inviteReason).toBe(reason);
      expect(f.inserts).toHaveLength(0);
      expect(f.consumed).toHaveLength(0);
    });
  }

  it("public 模式下不去校验、也不消费邀请码", async () => {
    const f = makeFake({ registrationMode: "public" });
    const r = await provisionAccount(req({ kind: "self" }, { inviteToken: "tok-ok" }), f.store);
    expect(r.ok).toBe(true);
    expect(f.calls.validateInvite).toBe(0);
    expect(f.consumed).toHaveLength(0);
    expect(r.ok === true && r.source).toBe("self");
  });
});

describe("闸门 a:注册策略 public", () => {
  for (const origin of ALL_ORIGINS) {
    it(`public 时放行来源 ${origin.kind}`, async () => {
      const f = makeFake({ registrationMode: "public" });
      const r = await provisionAccount(req(origin), f.store);
      expect(r.ok).toBe(true);
      expect(r.ok === true && r.created).toBe(true);
    });
  }

  it("来源字符串按来源落库,外部标识跟 users 行同一条 INSERT 一起写", async () => {
    const cases: Array<[SignupOrigin, string]> = [
      [{ kind: "self" }, "self"],
      [{ kind: "sso", slug: "keycloak" }, "sso:keycloak"],
      [{ kind: "idp", client: "svc-a" }, "idp:svc-a"],
      [{ kind: "apple", sub: "apple-sub-1" }, "apple"],
      [{ kind: "admin" }, "admin"],
    ];
    for (const [origin, expected] of cases) {
      const f = makeFake();
      await provisionAccount(req(origin), f.store);
      expect(f.inserts[0]!.signupSource).toBe(expected);
    }
    const fSso = makeFake();
    await provisionAccount(req({ kind: "sso", slug: "keycloak" }), fSso.store);
    expect(fSso.inserts[0]!.ssoProviderSlug).toBe("keycloak");
    const fApple = makeFake();
    await provisionAccount(req({ kind: "apple", sub: "apple-sub-1" }), fApple.store);
    expect(fApple.inserts[0]!.appleSub).toBe("apple-sub-1");
  });
});

describe("闸门 b:邮箱域名白名单", () => {
  it("空名单 → 任意域名放行", () => {
    expect(emailDomainAllowed("a@whatever.example", "")).toBe(true);
    expect(emailDomainAllowed("a@whatever.example", "   \n ")).toBe(true);
    expect(emailDomainAllowed("a@whatever.example", null)).toBe(true);
  });

  it("非空名单:名单内放行,名单外拒绝", () => {
    expect(emailDomainAllowed("a@corp.com", "corp.com, partner.net")).toBe(true);
    expect(emailDomainAllowed("a@partner.net", "corp.com, partner.net")).toBe(true);
    expect(emailDomainAllowed("a@evil.com", "corp.com, partner.net")).toBe(false);
  });

  it("大小写不敏感,条目和邮箱两边的空白都要吃掉", () => {
    expect(emailDomainAllowed("User@EXAMPLE.com", "  Example.COM  ")).toBe(true);
    expect(emailDomainAllowed("  User@Example.Com  ".trim(), "\n example.com \n")).toBe(true);
    expect(emailDomainAllowed("a@EXAMPLE.COM", "example.com")).toBe(true);
  });

  // 规则见 emailDomainAllowed 的注释:裸域名**不含子域名**,想含要显式写点号。
  it("裸条目不匹配子域名(这是本仓库定下的规则)", () => {
    expect(emailDomainAllowed("a@mail.example.com", "example.com")).toBe(false);
    expect(emailDomainAllowed("a@evilexample.com", "example.com")).toBe(false);
    expect(emailDomainAllowed("a@example.com.evil.net", "example.com")).toBe(false);
  });

  it("点号 / 星号开头的条目才含子域名,且同时匹配裸域名本身", () => {
    expect(emailDomainAllowed("a@mail.example.com", ".example.com")).toBe(true);
    expect(emailDomainAllowed("a@example.com", ".example.com")).toBe(true);
    expect(emailDomainAllowed("a@deep.mail.example.com", "*.example.com")).toBe(true);
    expect(emailDomainAllowed("a@example.com", "*.example.com")).toBe(true);
    expect(emailDomainAllowed("a@evilexample.com", ".example.com")).toBe(false);
  });

  it("粘贴进来的 @example.com / 尾点 FQDN 都认", () => {
    expect(emailDomainAllowed("a@example.com", "@example.com")).toBe(true);
    expect(emailDomainAllowed("a@example.com.", "example.com")).toBe(true);
  });

  it("没有 @ 的串一律不放行", () => {
    expect(emailDomainAllowed("not-an-email", "example.com")).toBe(false);
  });

  // 这个函数是导出的,后台要拿它预览名单效果,喂进来的串不保证干净。
  // 域名按定义在**最后一个** @ 之后 —— 取第一个的话 a@b@example.com 会被算成
  // 域名 "b@example.com",于是名单里写了 example.com 也匹配不上。
  it("多个 @ 时按最后一个 @ 之后取域名", () => {
    expect(emailDomainAllowed("a@b@example.com", "example.com")).toBe(true);
    expect(emailDomainAllowed("a@example.com@evil.net", "example.com")).toBe(false);
  });

  it("名单外的邮箱建不了号,原因码带上被拒的域名", async () => {
    const f = makeFake({ signupDomainAllowlist: "corp.com" });
    const r = await provisionAccount(req({ kind: "self" }, { email: "a@evil.com" }), f.store);
    expect(r.ok === false && r.reason.code).toBe("domain_not_allowed");
    expect(r.ok === false && r.reason.code === "domain_not_allowed" && r.reason.domain).toBe("evil.com");
    expect(f.inserts).toHaveLength(0);
  });

  it("名单同样管着 IdP 懒建号那条路", async () => {
    const f = makeFake({ signupDomainAllowlist: "corp.com" });
    const bad = await provisionAccount(req({ kind: "idp", client: "svc-a" }, { email: "x@evil.com" }), f.store);
    expect(bad.ok === false && bad.reason.code).toBe("domain_not_allowed");
    const good = await provisionAccount(req({ kind: "idp", client: "svc-a" }, { email: "x@corp.com" }), f.store);
    expect(good.ok).toBe(true);
  });
});

describe("闸门 c:每日配额", () => {
  it("0 = 不限,而且连 count 查询都不打", async () => {
    const f = makeFake({ signupDailyQuota: 0 });
    for (let i = 0; i < 5; i++) {
      const r = await provisionAccount(req({ kind: "self" }, { email: `u${i}@example.com` }), f.store);
      expect(r.ok).toBe(true);
    }
    expect(f.users).toHaveLength(5);
    expect(f.calls.countSince).toBe(0);
  });

  it("配额 N:第 N 个还能建,第 N+1 个被拒", async () => {
    const f = makeFake({ signupDailyQuota: 2 });
    expect((await provisionAccount(req({ kind: "self" }, { email: "a@example.com" }), f.store)).ok).toBe(true);
    expect((await provisionAccount(req({ kind: "self" }, { email: "b@example.com" }), f.store)).ok).toBe(true);
    const third = await provisionAccount(req({ kind: "self" }, { email: "c@example.com" }), f.store);
    expect(third.ok).toBe(false);
    expect(third.ok === false && third.reason.code).toBe("daily_quota_reached");
    expect(third.ok === false && third.reason.code === "daily_quota_reached" && third.reason.quota).toBe(2);
    expect(f.users).toHaveLength(2);
  });

  it("撞配额要留一条可见记录(带邮箱、来源、IP)", async () => {
    const f = makeFake({ signupDailyQuota: 1 });
    await provisionAccount(req({ kind: "self" }, { email: "a@example.com" }), f.store);
    await provisionAccount(
      req({ kind: "idp", client: "svc-a" }, { email: "b@example.com", ctx: { ip: "203.0.113.9", userAgent: "svc/1" } }),
      f.store,
    );
    expect(f.audits).toEqual([
      { email: "b@example.com", source: "idp:svc-a", quota: 1, ip: "203.0.113.9", userAgent: "svc/1" },
    ]);
  });

  it("策略 / 域名这两道拒绝不写审计(否则机器人能把表刷爆)", async () => {
    const closed = makeFake({ registrationMode: "closed" });
    await provisionAccount(req({ kind: "self" }), closed.store);
    expect(closed.audits).toHaveLength(0);
    const domain = makeFake({ signupDomainAllowlist: "corp.com" });
    await provisionAccount(req({ kind: "self" }, { email: "a@evil.com" }), domain.store);
    expect(domain.audits).toHaveLength(0);
  });

  it("跨天重置:昨天建满的号不算进今天的配额", async () => {
    const f = makeFake({ signupDailyQuota: 2 });
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    seedUser(f, "old1@example.com", yesterday);
    seedUser(f, "old2@example.com", yesterday);
    seedUser(f, "old3@example.com", yesterday);
    const r = await provisionAccount(req({ kind: "self" }, { email: "fresh@example.com" }), f.store);
    expect(r.ok).toBe(true);
    // 顺带钉死窗口起点:必须是今天零点,不是「最近 24 小时」这种滑动窗口
    // (滑动窗口会让「每天 N 个」在昨晚建过号的那几个钟头里莫名其妙地变少)。
    expect(f.lastCountSince?.getTime()).toBe(startOfQuotaDay(new Date()).getTime());
  });

  it("今天已经建满时不重置", async () => {
    const f = makeFake({ signupDailyQuota: 2 });
    seedUser(f, "t1@example.com", new Date());
    seedUser(f, "t2@example.com", new Date());
    const r = await provisionAccount(req({ kind: "self" }, { email: "fresh@example.com" }), f.store);
    expect(r.ok === false && r.reason.code).toBe("daily_quota_reached");
  });

  it("startOfQuotaDay 给的是本地零点", () => {
    const d = startOfQuotaDay(new Date("2026-03-15T13:45:12.345Z"));
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
    expect(d.getMilliseconds()).toBe(0);
  });
});

describe("已有邮箱", () => {
  it("adopt(默认):交回已有账号,created:false,不再插行", async () => {
    const f = makeFake();
    const old = seedUser(f, "old@example.com");
    const r = await provisionAccount(req({ kind: "sso", slug: "keycloak" }, { email: "old@example.com" }), f.store);
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.created).toBe(false);
    expect(r.ok === true && r.user.id).toBe(old.id);
    expect(f.inserts).toHaveLength(0);
  });

  it("refuse:回 email_taken,不认领别人的号", async () => {
    const f = makeFake();
    seedUser(f, "old@example.com");
    const r = await provisionAccount(
      req({ kind: "self" }, { email: "old@example.com", onExistingEmail: "refuse" }),
      f.store,
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason.code).toBe("email_taken");
    expect(f.inserts).toHaveLength(0);
  });

  it("邮箱大小写 / 空白归一后再认人", async () => {
    const f = makeFake();
    const old = seedUser(f, "old@example.com");
    const r = await provisionAccount(req({ kind: "self" }, { email: "  OLD@Example.COM " }), f.store);
    expect(r.ok === true && r.user.id).toBe(old.id);
  });
});

describe("竞态", () => {
  it("同一邮箱并发两次:只建出一个号,另一次 created:false 而不是报错", async () => {
    const f = makeFake();
    const [a, b] = await Promise.all([
      provisionAccount(req({ kind: "self" }, { email: "race@example.com" }), f.store),
      provisionAccount(req({ kind: "self" }, { email: "race@example.com" }), f.store),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(f.users).toHaveLength(1);
    expect(f.inserts).toHaveLength(2);           // 两边都真的试着插了 —— 是真竞态
    expect(f.calendars).toEqual([f.users[0]!.id]); // 默认日历只建一次
    const created = [a, b].filter((r) => r.ok === true && r.created);
    expect(created).toHaveLength(1);
    expect(a.ok === true && b.ok === true && a.user.id === b.user.id).toBe(true);
  });

  it("输掉竞态的那一次不消费邀请码", async () => {
    const f = makeFake({ registrationMode: "invite" });
    f.invites.set("tok-ok", OK_INVITE);
    await Promise.all([
      provisionAccount(req({ kind: "self" }, { email: "race@example.com", inviteToken: "tok-ok" }), f.store),
      provisionAccount(req({ kind: "self" }, { email: "race@example.com", inviteToken: "tok-ok" }), f.store),
    ]);
    expect(f.consumed).toHaveLength(1);
  });

  it("撞的是 apple_sub(邮箱不同)→ create_failed,绝不认领别人的号", async () => {
    const f = makeFake();
    seedUser(f, "first@example.com", new Date(), { appleSub: "dup-sub" } as Partial<FakeUser>);
    const r = await provisionAccount(
      req({ kind: "apple", sub: "dup-sub" }, { email: "second@example.com" }),
      f.store,
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason.code).toBe("create_failed");
    expect(f.users).toHaveLength(1);
  });
});

describe("落库的字段", () => {
  it("emailVerified 按传入值落库,不被强制改写成 true", async () => {
    const f = makeFake();
    await provisionAccount(req({ kind: "sso", slug: "keycloak" }, { email: "a@example.com", emailVerified: false }), f.store);
    expect(f.inserts[0]!.emailVerified).toBe(false);
    await provisionAccount(req({ kind: "sso", slug: "keycloak" }, { email: "b@example.com", emailVerified: true }), f.store);
    expect(f.inserts[1]!.emailVerified).toBe(true);
  });

  it("不传 passwordHash 的无密码账号存的是真 bcrypt 哈希,不是哨兵串", async () => {
    const f = makeFake();
    await provisionAccount(
      { email: "nopw@example.com", origin: { kind: "apple", sub: "s1" }, emailVerified: true },
      f.store,
    );
    const stored = f.inserts[0]!.passwordHash;
    expect(stored).toMatch(/^\$2[aby]\$\d{2}\$/);
    expect(stored).toHaveLength(60);
  });

  it("传了 passwordHash 就原样落库", async () => {
    const f = makeFake();
    await provisionAccount(req({ kind: "self" }), f.store);
    expect(f.inserts[0]!.passwordHash).toBe(PRESET_HASH);
  });

  it("新建号一定配一个默认日历", async () => {
    const f = makeFake();
    const r = await provisionAccount(req({ kind: "self" }), f.store);
    expect(f.calendars).toEqual([r.ok === true ? r.user.id : "??"]);
  });

  it("显示名去空白,空的落 null", async () => {
    const f = makeFake();
    await provisionAccount(req({ kind: "self" }, { email: "a@example.com", displayName: "  阿伟  " }), f.store);
    expect(f.inserts[0]!.displayName).toBe("阿伟");
    await provisionAccount(req({ kind: "self" }, { email: "b@example.com", displayName: "   " }), f.store);
    expect(f.inserts[1]!.displayName).toBeNull();
  });

  it("邮箱按小写落库", async () => {
    const f = makeFake();
    await provisionAccount(req({ kind: "self" }, { email: "MiXeD@Example.COM" }), f.store);
    expect(f.inserts[0]!.email).toBe("mixed@example.com");
  });
});

describe("入参校验", () => {
  // 两个 @ 和内嵌空白必须挡在门外:这道门的输入不全是 zod 校验过的
  // (外部 IdP 那条路的邮箱直接来自令牌 claim),而域名白名单按 @ 后面那段判。
  for (const bad of ["", "   ", "no-at-sign", "@example.com", "a@", "a@b@example.com", "a b@example.com", "a@exa mple.com"]) {
    it(`不合法的邮箱 ${JSON.stringify(bad)} → invalid_email,不建号`, async () => {
      const f = makeFake();
      const r = await provisionAccount(req({ kind: "self" }, { email: bad }), f.store);
      expect(r.ok === false && r.reason.code).toBe("invalid_email");
      expect(f.inserts).toHaveLength(0);
    });
  }
});

describe("signupSourceFor", () => {
  it("self 只有在真用掉邀请码时才升级成 invite", () => {
    expect(signupSourceFor({ kind: "self" }, false)).toBe("self");
    expect(signupSourceFor({ kind: "self" }, true)).toBe("invite");
    // 别的来源不受影响 —— 它们带不出邀请码,升级了反而丢掉「谁开的号」。
    expect(signupSourceFor({ kind: "sso", slug: "kc" }, true)).toBe("sso:kc");
    expect(signupSourceFor({ kind: "idp", client: "svc" }, true)).toBe("idp:svc");
    expect(signupSourceFor({ kind: "apple", sub: "x" }, true)).toBe("apple");
    expect(signupSourceFor({ kind: "admin" }, true)).toBe("admin");
  });
});

// 这一列的读侧口径(后台筛选 / 批量停用)在别的模块里,这里只钉死写侧:
// **NULL 是存量行的「未知」,收口函数永远不会写出 null**。
describe("signup_source 永不写 null", () => {
  beforeEach(() => vi.clearAllMocks());
  it("每一种来源都写出一个非空字符串", async () => {
    for (const origin of ALL_ORIGINS) {
      const f = makeFake();
      await provisionAccount(req(origin), f.store);
      expect(f.inserts[0]!.signupSource).toBeTruthy();
      expect(f.inserts[0]!.signupSource).not.toBeNull();
    }
  });
});
