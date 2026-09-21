import { describe, it, expect, beforeEach, vi } from "vitest";

// 纯逻辑档(`npm test`)里没有 Postgres:db/client 一 import 就建连接池,
// env 会校验 DATABASE_URL / SESSION_SECRET 之类的必填项。web/sso.ts 的依赖链
// 上挂着一大串会碰这两个模块的东西,所以在最上面挡掉;真正被测的那两段
// (resolveSsoLogin / ssoLoginPatch)全程喂假 store,一条 SQL 都不会打出去。
vi.mock("../src/db/client.js", () => ({ db: {}, schema: {} }));
vi.mock("../src/env.js", () => ({
  env: { NODE_ENV: "test", PUBLIC_BASE_URL: "https://cal.example.com", SESSION_SECRET: "x" },
}));

import {
  idpEmailVerified,
  resolveSsoLogin,
  ssoLoginPatch,
  type SsoLoginStore,
} from "../src/web/sso.js";
import {
  noteServiceClientTouch,
  resetServiceClientTouches,
  serviceClientForensicLine,
} from "../src/lib/session.js";
import type { ProvisionRequest, ProvisionResult } from "../src/lib/account_provisioning.js";
import type * as schema from "../src/db/schema.js";

// ---------------------------------------------------------------------------
// 假 store
//
// 两处是照抄真实现的口径写的,不照抄就会是假绿:
//   - findUserByEmail 按小写邮箱精确匹配(users_email_unique 就是这么建的);
//   - provision 真的按 onExistingEmail 分支 —— 传 "refuse" 且邮箱已存在时回
//     email_taken。假 store 要是无脑建号,「未验证不许接管」那条就永远不会红。
// ---------------------------------------------------------------------------

type Fake = {
  store: SsoLoginStore;
  users: schema.User[];
  identities: Array<{ provider: string; subject: string; userId: string }>;
  links: Array<{ userId: string; provider: string; subject: string; email: string }>;
  provisions: ProvisionRequest[];
  /** 下一次 provision 要回的拒绝;不设就按 users 表正常建号。 */
  denyWith?: ProvisionResult;
};

function mkUser(over: Partial<schema.User> & { id: string; email: string }): schema.User {
  return {
    emailVerified: false,
    ssoProviderSlug: null,
    signupSource: null,
    disabledAt: null,
    ...over,
  } as unknown as schema.User;
}

function makeFake(): Fake {
  const f: Fake = { store: null as unknown as SsoLoginStore, users: [], identities: [], links: [], provisions: [] };
  let seq = 0;
  f.store = {
    async findUserIdByIdentity(provider, subject) {
      return f.identities.find((i) => i.provider === provider && i.subject === subject)?.userId ?? null;
    },
    async loadUserById(id) {
      return f.users.find((u) => u.id === id);
    },
    async findUserByEmail(email) {
      return f.users.find((u) => u.email === email);
    },
    async linkIdentity(input) {
      f.links.push(input);
      f.identities.push({ provider: input.provider, subject: input.subject, userId: input.userId });
      return { ok: true, created: true };
    },
    async provision(req) {
      f.provisions.push(req);
      if (f.denyWith) return f.denyWith;
      const existing = f.users.find((u) => u.email === req.email);
      if (existing) {
        if ((req.onExistingEmail ?? "adopt") === "refuse") {
          return { ok: false, reason: { code: "email_taken" } };
        }
        return { ok: true, user: existing, created: false, source: existing.signupSource ?? null, inviteConsumed: false };
      }
      const created = mkUser({
        id: `new-${++seq}`,
        email: req.email,
        emailVerified: req.emailVerified,
        displayName: req.displayName ?? null,
        signupSource: `sso:${req.origin.kind === "sso" ? req.origin.slug : "?"}`,
      } as Partial<schema.User> & { id: string; email: string });
      f.users.push(created);
      return { ok: true, user: created, created: true, source: created.signupSource ?? null, inviteConsumed: false };
    },
  };
  return f;
}

const BASE = { slug: "keycloak", subject: "sub-1", email: "boss@example.com", displayName: null as string | null };

// ---------------------------------------------------------------------------

describe("idpEmailVerified", () => {
  it("布尔 true 算验证过", () => {
    expect(idpEmailVerified(true)).toBe(true);
  });

  it("字符串 \"true\" 也算 —— 相当一部分 IdP 把这个 claim 序列化成字符串", () => {
    expect(idpEmailVerified("true")).toBe(true);
    expect(idpEmailVerified("TRUE")).toBe(true);
    expect(idpEmailVerified(" true ")).toBe(true);
  });

  it("缺失算没验过(不是算验过)", () => {
    expect(idpEmailVerified(undefined)).toBe(false);
    expect(idpEmailVerified(null)).toBe(false);
  });

  it("false / \"false\" / 空串算没验过", () => {
    expect(idpEmailVerified(false)).toBe(false);
    expect(idpEmailVerified("false")).toBe(false);
    expect(idpEmailVerified("")).toBe(false);
  });

  it("没有哪个 IdP 发 1 / \"1\" / \"yes\",一律不认 —— 每多认一种写法就多一条能被凑出来的路", () => {
    expect(idpEmailVerified(1)).toBe(false);
    expect(idpEmailVerified("1")).toBe(false);
    expect(idpEmailVerified("yes")).toBe(false);
    expect(idpEmailVerified({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P4:接管洞
// ---------------------------------------------------------------------------

describe("SSO 按邮箱接管已有账号", () => {
  let f: Fake;
  beforeEach(() => {
    f = makeFake();
    // 站长的号,邮箱早就验过了。
    f.users.push(mkUser({ id: "boss", email: "boss@example.com", emailVerified: true }));
  });

  for (const [label, claim] of [
    ["false", false],
    ["缺失", undefined],
    ["字符串 \"false\"", "false"],
  ] as const) {
    it(`email_verified 为${label}时,不认领已有账号`, async () => {
      const r = await resolveSsoLogin({ ...BASE, emailVerified: idpEmailVerified(claim) }, f.store);

      // 拿不到站长那个号 —— 这一条就是整个洞。
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.denial.code).toBe("email_taken");
      // 也不许偷偷把 subject 绑到站长号上(绑上了下次就无条件进得去了)。
      expect(f.links).toEqual([]);
      // 走到了建号判定,并且明确要求「邮箱被占就拒绝」。
      expect(f.provisions).toHaveLength(1);
      expect(f.provisions[0]!.onExistingEmail).toBe("refuse");
      expect(f.provisions[0]!.origin).toEqual({ kind: "sso", slug: "keycloak" });
    });
  }

  it("email_verified 为 true 时,按邮箱认领并绑定", async () => {
    const r = await resolveSsoLogin({ ...BASE, emailVerified: idpEmailVerified(true) }, f.store);
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.user.id).toBe("boss");
    expect(r.ok === true && r.created).toBe(false);
    expect(f.links).toEqual([{ userId: "boss", provider: "keycloak", subject: "sub-1", email: "boss@example.com" }]);
    // 认领走的是这一步,不该再去建号。
    expect(f.provisions).toEqual([]);
  });

  it("email_verified 为字符串 \"true\" 时同样认领", async () => {
    const r = await resolveSsoLogin({ ...BASE, emailVerified: idpEmailVerified("true") }, f.store);
    expect(r.ok === true && r.user.id).toBe("boss");
    expect(f.links).toHaveLength(1);
  });

  it("(provider, subject) 已经绑过的,不看 email_verified —— 那条绑定是之前真建立过的", async () => {
    f.identities.push({ provider: "keycloak", subject: "sub-1", userId: "boss" });
    const r = await resolveSsoLogin({ ...BASE, emailVerified: false }, f.store);
    expect(r.ok === true && r.user.id).toBe("boss");
    expect(f.provisions).toEqual([]);
  });

  it("身份行还在但用户行没了,不当成命中(别把 undefined 当登录成功)", async () => {
    f.identities.push({ provider: "keycloak", subject: "sub-1", userId: "deleted-user" });
    const r = await resolveSsoLogin({ ...BASE, emailVerified: false }, f.store);
    // 落到建号判定,而邮箱是站长的 → 拒。
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.denial.code).toBe("email_taken");
  });
});

describe("SSO 建新号", () => {
  let f: Fake;
  beforeEach(() => { f = makeFake(); });

  it("未验证的新邮箱:建得出来,但 emailVerified 按 IdP 的真实值落库,不强行写 true", async () => {
    const r = await resolveSsoLogin(
      { ...BASE, email: "newbie@example.com", emailVerified: idpEmailVerified(undefined), displayName: "阿伟" },
      f.store,
    );
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.created).toBe(true);
    expect(f.provisions[0]!.emailVerified).toBe(false);
    expect(f.users.find((u) => u.email === "newbie@example.com")!.emailVerified).toBe(false);
    // 建完把 subject 绑上,下次直接走第 1 步。
    expect(f.links).toHaveLength(1);
    expect(f.links[0]!.subject).toBe("sub-1");
  });

  it("已验证的新邮箱:emailVerified 落 true", async () => {
    await resolveSsoLogin({ ...BASE, email: "newbie@example.com", emailVerified: true }, f.store);
    expect(f.provisions[0]!.emailVerified).toBe(true);
  });

  it("建号被闸门拒了,原样把原因码交回调用方", async () => {
    f.denyWith = { ok: false, reason: { code: "registration_closed" } };
    const r = await resolveSsoLogin({ ...BASE, email: "newbie@example.com", emailVerified: true }, f.store);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.denial.code).toBe("registration_closed");
    // 拒绝了就不许留下任何绑定。
    expect(f.links).toEqual([]);
  });
});

describe("ssoLoginPatch", () => {
  it("IdP 说验过、本地还没验 → 提升成已验证", () => {
    expect(ssoLoginPatch({ emailVerified: false, ssoProviderSlug: "keycloak" }, "keycloak", true))
      .toEqual({ emailVerified: true });
  });

  it("IdP 没说验过 → 不碰 emailVerified(这是原来那行无条件 true)", () => {
    expect(ssoLoginPatch({ emailVerified: false, ssoProviderSlug: "keycloak" }, "keycloak", false))
      .toEqual({});
  });

  it("本地已验证、IdP 说没验 → 也不降级(不能拿外部 claim 推翻本站验过的事实)", () => {
    const patch = ssoLoginPatch({ emailVerified: true, ssoProviderSlug: "keycloak" }, "keycloak", false);
    expect(patch.emailVerified).toBeUndefined();
  });

  it("换了提供方就刷新 slug", () => {
    expect(ssoLoginPatch({ emailVerified: true, ssoProviderSlug: "old" }, "keycloak", false))
      .toEqual({ ssoProviderSlug: "keycloak" });
  });
});

// ---------------------------------------------------------------------------
// P5:服务客户端取证去重
//
// 放在这一档里是因为它跟上面是同一件事的两半 —— 这次的洞是「建了个号却查不出
// 当时在干什么」,上半修接管、下半修取证。定义在 lib/session.ts。
// ---------------------------------------------------------------------------

describe("IdP 服务客户端:第一次碰这个账号", () => {
  const HOUR = 60 * 60 * 1000;
  beforeEach(() => { resetServiceClientTouches(); });

  it("同一对第一次为真,窗口内再来为假", () => {
    const t0 = 1_700_000_000_000;
    expect(noteServiceClientTouch("svc", "u1", t0)).toBe(true);
    expect(noteServiceClientTouch("svc", "u1", t0 + 1000)).toBe(false);
    expect(noteServiceClientTouch("svc", "u1", t0 + HOUR - 1)).toBe(false);
  });

  it("换账号 / 换客户端各算各的", () => {
    const t0 = 1_700_000_000_000;
    expect(noteServiceClientTouch("svc", "u1", t0)).toBe(true);
    expect(noteServiceClientTouch("svc", "u2", t0)).toBe(true);
    expect(noteServiceClientTouch("other", "u1", t0)).toBe(true);
  });

  it("满一小时之后再记一行(窗口是滑动的,不是永不再记)", () => {
    const t0 = 1_700_000_000_000;
    expect(noteServiceClientTouch("svc", "u1", t0)).toBe(true);
    expect(noteServiceClientTouch("svc", "u1", t0 + HOUR)).toBe(true);
    // 刚记过 → 新窗口起点是这一次,不是 t0。
    expect(noteServiceClientTouch("svc", "u1", t0 + HOUR + 1)).toBe(false);
  });

  it("窗口内的重复访问不会把起点往后推(否则一个一直在刷的客户端永远不再记第二行)", () => {
    const t0 = 1_700_000_000_000;
    expect(noteServiceClientTouch("svc", "u1", t0)).toBe(true);
    for (let i = 1; i <= 10; i++) noteServiceClientTouch("svc", "u1", t0 + i * (HOUR / 20));
    expect(noteServiceClientTouch("svc", "u1", t0 + HOUR)).toBe(true);
  });

  it("重启(表被清空)之后,每一对都会重新记一行", () => {
    const t0 = 1_700_000_000_000;
    expect(noteServiceClientTouch("svc", "u1", t0)).toBe(true);
    expect(noteServiceClientTouch("svc", "u1", t0 + 1000)).toBe(false);
    resetServiceClientTouches();
    expect(noteServiceClientTouch("svc", "u1", t0 + 2000)).toBe(true);
  });

  it("取证日志:读操作只记第一条", () => {
    const acc = { client: "svc", account: "a@example.com", accountId: "u1", method: "GET", path: "/api/v1/events", status: 200 };
    const first = serviceClientForensicLine(acc);
    expect(first).not.toBeNull();
    expect(first!.event).toBe("idp_service_first_touch");
    expect(first!.line.firstTouch).toBe(true);
    expect(first!.line.accountId).toBe("u1");
    // 同一对的后续读不再刷屏 —— 这正是「读量大」当初被整个跳过的理由。
    expect(serviceClientForensicLine(acc)).toBeNull();
    expect(serviceClientForensicLine({ ...acc, path: "/api/v1/calendars" })).toBeNull();
  });

  it("取证日志:写操作每条都记,不受去重影响", () => {
    const acc = { client: "svc", account: "a@example.com", accountId: "u1", method: "POST", path: "/api/v1/events", status: 201 };
    expect(serviceClientForensicLine(acc)!.event).toBe("idp_service_mutation");
    expect(serviceClientForensicLine(acc)!.event).toBe("idp_service_mutation");
    expect(serviceClientForensicLine({ ...acc, method: "DELETE" })!.event).toBe("idp_service_mutation");
  });

  it("取证日志:既是写又是首次时只出一行,记成 mutation 并带 firstTouch", () => {
    const rec = serviceClientForensicLine({
      client: "svc", account: "a@example.com", accountId: "u1", method: "POST", path: "/api/v1/events", status: 201,
    });
    expect(rec!.event).toBe("idp_service_mutation");
    expect(rec!.line.firstTouch).toBe(true);
    // 这一条已经把首次用掉了,紧接着的读不该再出一行。
    expect(serviceClientForensicLine({
      client: "svc", account: "a@example.com", accountId: "u1", method: "GET", path: "/api/v1/events", status: 200,
    })).toBeNull();
  });

  it("取证日志:PROPFIND / REPORT 按写操作那样每条都记 —— 一次能读走整个日历的读最该留痕", () => {
    for (const m of ["PROPFIND", "REPORT"]) {
      const acc = { client: "svc", account: "a@example.com", accountId: "u1", method: m, path: "/dav/", status: 207 };
      expect(serviceClientForensicLine(acc)!.event).toBe("idp_service_mutation");
      expect(serviceClientForensicLine(acc)!.event).toBe("idp_service_mutation");
    }
  });

  it("取证日志:拿不到账号 id 时宁可多记一行,不许静默丢掉", () => {
    const acc = { client: "svc", account: undefined, accountId: undefined, method: "GET", path: "/api/v1/events", status: 200 };
    expect(serviceClientForensicLine(acc)).not.toBeNull();
    expect(serviceClientForensicLine(acc)).not.toBeNull();
  });

  it("表满了按最久没用到的淘汰,窗口内回访过的那一对不会被挤掉", () => {
    const t0 = 1_700_000_000_000;
    // 这条用例的形状是特意凑的:不这么凑就分不出「真 LRU」和「按首次出现的先后
    // 淘汰」—— 一个被淘汰之后又回访的 key 会以新身份重新插到队尾,于是两种策略
    // 看起来一样。所以回访必须发生在**被淘汰之前**,之后不再碰它。
    noteServiceClientTouch("svc", "hot", t0);           // hot 是最早插进去的
    for (let i = 0; i < 4999; i++) noteServiceClientTouch("svc", `cold-${i}`, t0 + 1);
    // 刚好到上限 5000。此刻回访 hot(窗口内,fresh=false)。
    expect(noteServiceClientTouch("svc", "hot", t0 + 1)).toBe(false);
    // 再灌 10 个,挤掉 10 个最久没用到的 —— 应该是 cold-0..cold-9,不是 hot。
    for (let i = 5000; i < 5010; i++) noteServiceClientTouch("svc", `cold-${i}`, t0 + 1);
    expect(noteServiceClientTouch("svc", "hot", t0 + 2)).toBe(false);
    expect(noteServiceClientTouch("svc", "cold-0", t0 + 2)).toBe(true);
  });
});
