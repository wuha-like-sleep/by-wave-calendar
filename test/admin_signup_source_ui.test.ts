// 后台「账号是从哪来的」这一套的断言:来源归类、来源筛选、批量停用名单,
// 外加三张模板能不能真的渲染出来。
//
// 这一档为什么值得存在:这次加的东西里,最容易在不报错的情况下做错的两件事是
//   1) 把 signup_source 为 NULL 的存量账号当成「自己注册」——
//      管理员照着这个标签勾一批人点停用,停掉的是升级之前的所有老用户;
//   2) 批量停用沿用单行那条「这是不是最后一个管理员」的守卫 ——
//      一次勾中全部管理员时,每一行单看都不是最后一个,做完就是零个管理员。
// 两件事都不会抛异常、不会有红字,只会安静地做错。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import ejs from "ejs";
import {
  signupSourceView,
  signupSourceFilter,
  planBulkDisable,
  type BulkDisableRow,
} from "../src/web/admin.js";

const VIEWS = path.resolve("src/views");

// ---------------------------------------------------------------------------
// 来源归类
// ---------------------------------------------------------------------------

describe("signupSourceView", () => {
  it("把空值归成「未知」,而不是 self", () => {
    for (const empty of [null, undefined, "", "   "]) {
      const v = signupSourceView(empty);
      expect(v.kind).toBe("unknown");
      expect(v.key).toBe("unknown");
      expect(v.raw).toBeNull();
      // 显式再钉一遍:这一条错了,后台的批量停用就会误伤所有存量账号。
      expect(v.kind).not.toBe("self");
    }
  });

  it("认得收口函数会写进去的每一种取值", () => {
    expect(signupSourceView("self").kind).toBe("self");
    expect(signupSourceView("invite").kind).toBe("invite");
    expect(signupSourceView("apple").kind).toBe("apple");
    expect(signupSourceView("admin").kind).toBe("admin");
  });

  it("从 sso:<slug> / idp:<client> 里拆出那个外部标识", () => {
    const sso = signupSourceView("sso:keycloak");
    expect(sso.kind).toBe("sso");
    expect(sso.detail).toBe("keycloak");
    expect(sso.key).toBe("sso:keycloak");

    const idp = signupSourceView("idp:acme-service");
    expect(idp.kind).toBe("idp");
    expect(idp.detail).toBe("acme-service");
    expect(idp.key).toBe("idp:acme-service");
  });

  it("不认识的取值自成一桶,不掉进 self", () => {
    const v = signupSourceView("ldap");
    expect(v.kind).toBe("other");
    expect(v.kind).not.toBe("self");
    // 原值要留着,否则管理员在界面上看到的是一个没有名字的桶。
    expect(v.raw).toBe("ldap");
  });
});

// ---------------------------------------------------------------------------
// 来源筛选
// ---------------------------------------------------------------------------

describe("signupSourceFilter", () => {
  it("没传 = 不筛", () => {
    expect(signupSourceFilter(undefined)).toEqual({ kind: "none" });
    expect(signupSourceFilter("")).toEqual({ kind: "none" });
    expect(signupSourceFilter("   ")).toEqual({ kind: "none" });
  });

  it("unknown 变成「这一列是空的」,不是按字面量相等比较", () => {
    // 写成 { kind: "exact", value: "unknown" } 的话页面照常打开、不报错,
    // 只是永远空表 —— 而管理员读到的意思是「升级前的老账号一个都没有」。
    expect(signupSourceFilter("unknown")).toEqual({ kind: "unknown" });
  });

  it("其余取值按精确匹配", () => {
    expect(signupSourceFilter("self")).toEqual({ kind: "exact", value: "self" });
    expect(signupSourceFilter("sso:keycloak")).toEqual({ kind: "exact", value: "sso:keycloak" });
  });

  it("截断超长输入", () => {
    const f = signupSourceFilter("x".repeat(500));
    expect(f.kind).toBe("exact");
    expect(f.kind === "exact" && f.value.length).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// 批量停用名单
// ---------------------------------------------------------------------------

const row = (id: string, over: Partial<BulkDisableRow> = {}): BulkDisableRow => ({
  id, email: `${id}@example.com`, isAdmin: false, disabled: false, ...over,
});

describe("planBulkDisable", () => {
  it("普通账号全部进停用名单", () => {
    const rows = [row("a"), row("b")];
    const plan = planBulkDisable({ requestedIds: ["a", "b"], rows, actorId: "me", activeAdminCount: 1 });
    expect(plan.disable.map((r) => r.id)).toEqual(["a", "b"]);
    expect(plan.skipped).toEqual([]);
  });

  it("跳过自己", () => {
    const rows = [row("me"), row("a")];
    const plan = planBulkDisable({ requestedIds: ["me", "a"], rows, actorId: "me", activeAdminCount: 1 });
    expect(plan.disable.map((r) => r.id)).toEqual(["a"]);
    expect(plan.skipped).toEqual([{ id: "me", email: "me@example.com", reason: "self" }]);
  });

  it("跳过已经停用的(重复停会把停用时间刷成今天)", () => {
    const rows = [row("a", { disabled: true })];
    const plan = planBulkDisable({ requestedIds: ["a"], rows, actorId: "me", activeAdminCount: 1 });
    expect(plan.disable).toEqual([]);
    expect(plan.skipped[0]?.reason).toBe("already_disabled");
  });

  it("查不到的 id 单独报出来,不当成成功", () => {
    const plan = planBulkDisable({ requestedIds: ["ghost"], rows: [], actorId: "me", activeAdminCount: 1 });
    expect(plan.disable).toEqual([]);
    expect(plan.skipped[0]).toEqual({ id: "ghost", email: "", reason: "not_found" });
  });

  it("两个管理员全勾上:自己跳过,另一个可以停,系统还剩自己", () => {
    const rows = [row("me", { isAdmin: true }), row("adminB", { isAdmin: true })];
    const plan = planBulkDisable({ requestedIds: ["me", "adminB"], rows, actorId: "me", activeAdminCount: 2 });
    expect(plan.disable.map((r) => r.id)).toEqual(["adminB"]);
    expect(plan.skipped).toEqual([{ id: "me", email: "me@example.com", reason: "self" }]);
  });

  it("三个管理员勾两个:停掉两个,剩一个", () => {
    const rows = [row("a", { isAdmin: true }), row("b", { isAdmin: true })];
    const plan = planBulkDisable({ requestedIds: ["a", "b"], rows, actorId: "me", activeAdminCount: 3 });
    expect(plan.disable.map((r) => r.id)).toEqual(["a", "b"]);
    expect(plan.skipped).toEqual([]);
  });

  it("三个管理员勾三个:停两个,第三个拦下", () => {
    const rows = [row("a", { isAdmin: true }), row("b", { isAdmin: true }), row("c", { isAdmin: true })];
    const plan = planBulkDisable({ requestedIds: ["a", "b", "c"], rows, actorId: "me", activeAdminCount: 3 });
    expect(plan.disable.map((r) => r.id)).toEqual(["a", "b"]);
    expect(plan.skipped).toEqual([{ id: "c", email: "c@example.com", reason: "last_admin" }]);
  });

  it("管理员额度不被普通账号消耗", () => {
    const rows = [row("u1"), row("u2"), row("a", { isAdmin: true })];
    const plan = planBulkDisable({ requestedIds: ["u1", "u2", "a"], rows, actorId: "me", activeAdminCount: 2 });
    expect(plan.disable.map((r) => r.id)).toEqual(["u1", "u2", "a"]);
  });

  it("重复的 id 只算一次,也不重复扣管理员额度", () => {
    const rows = [row("a", { isAdmin: true }), row("b", { isAdmin: true })];
    // 额度 = 3 - 1 = 2。a 报了两次,若不去重就会吃掉两格,b 会被误判成最后一个管理员。
    const plan = planBulkDisable({ requestedIds: ["a", "a", "b"], rows, actorId: "me", activeAdminCount: 3 });
    expect(plan.disable.map((r) => r.id)).toEqual(["a", "b"]);
    expect(plan.skipped).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 模板能不能渲染
// ---------------------------------------------------------------------------
//
// t() 在这里直接返回 key。这样断言的是「模板挑了哪个分支」,跟具体译文无关 ——
// 这一档不会因为文案改了一个字就变红。

// 变量也拼进去:带 {n} 这种占位的文案,断言要能看见那个数字真的被传下去了
// (只回 key 的话,「数量没传给文案」这种错就测不出来)。
const tStub = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key} ${JSON.stringify(vars)}` : key;

function render(view: string, data: Record<string, unknown>): string {
  return ejs.render(
    readFileSync(path.join(VIEWS, view), "utf8"),
    { t: tStub, csrfToken: "csrf-token-here", flash: {}, ...data },
    { filename: path.join(VIEWS, view), views: [VIEWS], async: false },
  ) as string;
}

const adminUser = { id: "me", email: "admin@example.com", isAdmin: true };

describe("admin/users.ejs", () => {
  const baseLocals = {
    user: adminUser,
    query: "",
    sourceFilter: "",
    stats: { total: 2, admins: 1, disabled: 0 },
    sourceOptions: [
      { key: "unknown", kind: "unknown", detail: null, raw: null, count: 7 },
      { key: "idp:acme", kind: "idp", detail: "acme", raw: "idp:acme", count: 30 },
    ],
    users: [
      {
        id: "u-legacy", email: "legacy@example.com", displayName: null, isAdmin: false,
        emailVerified: true, mfaEnabled: false, ssoProviderSlug: null, disabledAt: null,
        createdAt: new Date("2024-01-02T03:04:05Z"), passkeyCount: 0, lastLoginMethod: null,
        source: signupSourceView(null),
      },
      {
        id: "u-idp", email: "svc@example.com", displayName: "服务开通", isAdmin: false,
        emailVerified: true, mfaEnabled: false, ssoProviderSlug: null, disabledAt: null,
        createdAt: new Date("2024-06-02T03:04:05Z"), passkeyCount: 0, lastLoginMethod: null,
        source: signupSourceView("idp:acme"),
      },
    ],
  };

  // 来源那一格用 data-source-cell 定位。直接在整页 HTML 里找文字是不行的:
  // 筛选下拉里也有同样的来源名字,来源列整个被删掉都发现不了。
  const sourceCells = (html: string) =>
    [...html.matchAll(/<td[^>]*data-source-cell[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1] ?? "");

  it("每一行都有来源那一格", () => {
    expect(sourceCells(render("admin/users.ejs", baseLocals))).toHaveLength(2);
  });

  it("存量账号那一行显示成「未知」,不显示成「自己注册」", () => {
    const cells = sourceCells(render("admin/users.ejs", baseLocals));
    expect(cells[0]).toContain("adminSource.unknown");
    expect(cells[0]).not.toContain("adminSource.self");
  });

  it("IdP 开通的那一行连客户端名一起显示", () => {
    const cells = sourceCells(render("admin/users.ejs", baseLocals));
    expect(cells[1]).toContain("adminSource.idp");
    expect(cells[1]).toContain("acme");
  });

  it("每一行都能勾选,唯独自己那一行不能", () => {
    const html = render("admin/users.ejs", {
      ...baseLocals,
      users: [...baseLocals.users, {
        ...baseLocals.users[0]!, id: "me", email: "admin@example.com", source: signupSourceView("self"),
      }],
    });
    expect(html).toContain('name="userIds" value="u-legacy"');
    expect(html).toContain('name="userIds" value="u-idp"');
    // 自己那一行没有勾选框 —— 否则勾上、提交、再被服务端跳过,白跑一趟。
    expect(html).not.toContain('name="userIds" value="me"');
  });

  it("勾选框靠 form= 关联到批量表单(HTML 不许 form 套 form)", () => {
    const html = render("admin/users.ejs", baseLocals);
    expect(html).toContain('id="bwc-bulk-disable"');
    expect(html).toContain('form="bwc-bulk-disable"');
    expect(html).toContain('action="/admin/users/bulk-disable"');
  });

  it("批量表单带着当前筛选条件,做完能回到原来那一屏", () => {
    const html = render("admin/users.ejs", { ...baseLocals, query: "acme", sourceFilter: "idp:acme" });
    expect(html).toContain('name="q" value="acme"');
    expect(html).toContain('name="source" value="idp:acme"');
  });

  it("来源下拉里「未知」是独立选项", () => {
    const html = render("admin/users.ejs", baseLocals);
    expect(html).toContain('value="unknown"');
  });
});

describe("admin/signups.ejs", () => {
  const group = (view: ReturnType<typeof signupSourceView>, over: Record<string, unknown> = {}) => ({
    view, total: 30, firstAt: new Date("2024-01-01T00:00:00Z"), lastAt: new Date("2024-02-15T00:00:00Z"),
    neverLoggedIn: 30, disabled: 0,
    firstAtIso: "<time>2024-01-01</time>", lastAtIso: "<time>2024-02-15</time>", ...over,
  });

  const baseLocals = {
    user: adminUser,
    groups: [group(signupSourceView("idp:acme")), group(signupSourceView(null), { total: 4, neverLoggedIn: 0 })],
    gates: { registrationMode: "public", domainAllowlist: "", dailyQuota: 0, createdToday: 3 },
  };

  it("一屏列出每个来源建了多少、多少个从没登录过", () => {
    const html = render("admin/signups.ejs", baseLocals);
    expect(html).toContain("adminSource.idp");
    expect(html).toContain("acme");
    expect(html).toContain("adminSource.unknown");
    expect(html).toContain("adminSignups.col.neverLoggedIn");
    expect(html).toContain(">30<");
  });

  it("每一组都能一键跳到按这个来源筛好的用户列表", () => {
    const html = render("admin/signups.ejs", baseLocals);
    expect(html).toContain("/admin/users?source=idp%3Aacme");
    expect(html).toContain("/admin/users?source=unknown");
  });

  it("两道闸门都关着的时候,各自说「不限制」", () => {
    const html = render("admin/signups.ejs", baseLocals);
    // 空白名单 / 配额 0 = 不限制。显示成空白或者 0,管理员会以为一个都进不来。
    // 数个数:只断言「页面上有这个词」的话,两栏里坏掉一栏是发现不了的。
    expect(html.match(/adminSignups\.gates\.unlimited/g) ?? []).toHaveLength(2);
  });

  it("闸门开着的时候把真实取值摆出来", () => {
    const html = render("admin/signups.ejs", {
      ...baseLocals,
      gates: { registrationMode: "invite", domainAllowlist: "corp.example.com", dailyQuota: 5, createdToday: 3 },
    });
    expect(html).toContain("corp.example.com");
    // 数字必须落在配额那一栏里,不是页面上随便哪儿有个 5。
    expect(html).toMatch(/adminSignups\.gates\.quotaLabel[\s\S]{0,300}?\b5\b/);
    expect(html).toMatch(/adminSignups\.gates\.today[\s\S]{0,80}?\b3\b/);
    expect(html).not.toContain("adminSignups.gates.unlimited");
  });

  it("一个账号都没有时表头和说明还在,不整块消失", () => {
    const html = render("admin/signups.ejs", { ...baseLocals, groups: [] });
    expect(html).toContain("adminSignups.col.source");
    expect(html).toContain("adminSignups.empty");
    expect(html).toContain("adminSignups.neverLoggedInNote");
  });
});

describe("admin/users-bulk-disable.ejs", () => {
  const baseLocals = {
    user: adminUser,
    plan: {
      disable: [{ id: "u-1", email: "a@example.com", isAdmin: false, disabled: false }],
      skipped: [{ id: "me", email: "admin@example.com", reason: "self" as const }],
    },
    sourceById: new Map([["u-1", signupSourceView("idp:acme")]]),
    backQ: "acme",
    backSource: "idp:acme",
  };

  it("确认页列清楚谁会被停、谁被跳过和为什么", () => {
    const html = render("admin/users-bulk-disable.ejs", baseLocals);
    expect(html).toContain("a@example.com");
    expect(html).toContain("adminUsers.bulk.skip.self");
    expect(html).toContain("adminSource.idp");
  });

  it("真正执行的是另一个地址,确认之前不会有任何账号被停", () => {
    const html = render("admin/users-bulk-disable.ejs", baseLocals);
    expect(html).toContain('action="/admin/users/bulk-disable/apply"');
    expect(html).toContain('name="userIds" value="u-1"');
    expect(html).toContain('name="_csrf"');
  });

  it("没有一个能停时,确认按钮是禁用的", () => {
    const html = render("admin/users-bulk-disable.ejs", {
      ...baseLocals,
      plan: { disable: [], skipped: baseLocals.plan.skipped },
    });
    // 按 <button ... disabled> 的形状断言:光找 "disabled" 这个词是找不出问题的,
    // 那个按钮的 class 里本来就写着 disabled:opacity-40。
    // 要断到属性边界上:class 里本来就有 disabled:opacity-40,
    // 只找 "\sdisabled" 的话,disabled 属性被删掉也照样绿。
    expect(html).toMatch(/<button[^>]*\sdisabled[\s>]/);
    expect(html).toContain("adminUsers.bulk.noneEligible");
  });
});

// ---------------------------------------------------------------------------
// 跨文件的两条约定
// ---------------------------------------------------------------------------

describe("批量停用没有另起一份停用实现", () => {
  it("admin.ts 里只有一处写 disabledAt", () => {
    // 这个仓库在封禁上吃过的亏:判定和动作散在多处,就一定有某一处漏掉其中一步
    // (会话删了但 API Token 还在、CalDAV 缓存没清)。批量停用要是自己写一份
    // UPDATE,这里就会变成 2 —— 那正是要拦下的那一刻。
    const src = readFileSync(path.resolve("src/web/admin.ts"), "utf8");
    const hits = src.match(/disabledAt:\s*new Date\(/g) ?? [];
    expect(hits.length, "停用只允许在 disableUserAccount() 里写 disabled_at").toBe(1);
  });
});

describe("模板用的委托钩子在 app.js 里真的存在", () => {
  // CSP 禁内联事件代码,所以勾选交互只能靠 app.js 里的委托监听。钩子名在
  // 那边被改掉的话,页面照常渲染、全选框静默失灵 —— 没有任何报错。
  const appJs = readFileSync(path.resolve("src/public/app.js"), "utf8");

  it("data-bwc-checkall 有对应实现", () => {
    expect(render("admin/users.ejs", {
      user: adminUser, query: "", sourceFilter: "", stats: { total: 0, admins: 0, disabled: 0 },
      sourceOptions: [], users: [],
    })).toContain("data-bwc-checkall");
    expect(appJs).toContain("dataset.bwcCheckall");
  });

  it("data-bwc-autosubmit 有对应实现", () => {
    expect(render("admin/users.ejs", {
      user: adminUser, query: "", sourceFilter: "", stats: { total: 0, admins: 0, disabled: 0 },
      sourceOptions: [], users: [],
    })).toContain("data-bwc-autosubmit");
    expect(appJs).toContain("dataset.bwcAutosubmit");
  });
});
