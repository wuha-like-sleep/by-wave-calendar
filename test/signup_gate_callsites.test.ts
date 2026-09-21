// 建号入口的门禁 + 四张「拒绝原因 → 错误形态」对照表。
//
// 为什么这一档必须存在:建号判定收口成一个函数之后,它唯一会坏的方式不是
// 函数本身写错,而是**某天有人在某个入口又开一个口子**——直接 insert 一行、
// 或者顺手把 emailVerified 写成 true。这正是这次要修的洞本来的样子:五个
// 入口里只有一个看注册策略,而那四个是一个一个长出来的,每一次都编译通过、
// 部署成功、线上静默失效。人眼 review 拦不住,只能在源码层面禁掉。
//
// 对照表那几条测的是「拒绝了要怎么说」。两条硬约束在里面:
//   - 一条都不能回 401。401 在 App 的 api.dart 里的意思是「会话没了」,收到
//     就把人登出;「这次不让你开号」跟「你是谁我不认」是两回事,而已发布的
//     包改不了那个判断。
//   - 配额数字不能漏给终端用户。那是管理员设的闸门。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ProvisionDenial } from "../src/lib/account_provisioning.js";
import { registerDenialResponse } from "../src/routes/auth.js";
import { appleProvisionDenial } from "../src/routes/devices.js";
import { idpProvisionDenial } from "../src/lib/external_idp.js";
import { registerDenialCopy } from "../src/web/index.js";

// ---------------------------------------------------------------------------
// 门禁:这五个入口不许自己建号
// ---------------------------------------------------------------------------

const ENTRY_POINTS = [
  "src/routes/auth.ts",
  "src/web/index.ts",
  "src/routes/devices.ts",
  "src/routes/accounts.ts",
  "src/lib/external_idp.ts",
];

function read(rel: string): string {
  return readFileSync(path.resolve(rel), "utf8");
}

// ---------------------------------------------------------------------------
// 判定前先把源码洗成「只剩代码」
// ---------------------------------------------------------------------------
//
// 注释不参与判定:注释里写「以前这里 insert(schema.users)」不该把门禁喂饱。
// 反过来,把真代码藏进 /* */ 也不行。两个方向都不对,所以判定前统一洗一遍。
//
// **上一版这一步是按行做的**(「本行第一个 // 之后全扔」),而这五个文件的
// 字符串常量里就带着网址。实测上一版正在造成的截断,光 src/web/index.ts
// 就有 8 行,例如:
//
//     原文  if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
//     剥完  if (raw.startsWith("
//
//     原文  iosAppStoreUrl: "https://apps.apple.com/us/app/bywavecalendar/…",
//     剥完  iosAppStoreUrl: "https:
//
// 后果有两层:
//   - 下面的 callTextsOf 靠数括号截调用文本,而截断会留下不配对的引号和括号;
//   - 更要命的是「这一行里的 insert 凭空消失」—— 在同一行里写个网址就能从
//     这道门底下走过去。
//
// 所以换成一个小词法器:按字符走一遍,认得注释、单双引号字符串、模板字符串
// (含 ${} 回到代码态)、正则字面量。注释和字符串**内容**换成等量空格,
// 长度和行号原样保留。仓库里的 typescript 7 只导出 version、没有可用的语法树
// API,依赖又不许动,所以这份词法器是自带的。
//
// 这份实现和 test/no_direct_user_insert.test.ts 里那份是**各写各的**,不共用。
// 两道门共用一份实现的话,那一份写坏就同时瞎掉两道门 —— 而这两道门恰恰是
// 互为对方的兜底(那档盯「第六个新文件」,这档盯「这五个老文件」)。

const REGEX_OK_AFTER_WORD = new Set([
  "return", "typeof", "instanceof", "in", "of", "case", "new", "delete",
  "void", "do", "else", "yield", "await", "throw",
]);

/** 注释和字符串内容 → 等量空格;长度与原文一致。 */
function codeOf(src: string): string {
  const n = src.length;
  const out = src.split("");
  const blank = (a: number, b: number): void => {
    for (let i = Math.max(0, a); i < Math.min(b, n); i++) if (out[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  let mode: "code" | "template" = "code";
  const tmplStack: number[] = [];
  let depth = 0;
  let prevSig = "";
  let prevWord = "";
  const regexAllowed = (): boolean => {
    if (prevWord) return REGEX_OK_AFTER_WORD.has(prevWord);
    if (!prevSig) return true;
    return !/[A-Za-z0-9_$)\]}"'`]/.test(prevSig);
  };

  while (i < n) {
    if (mode === "template") {
      const ch = src[i]!;
      if (ch === "\\") { blank(i, i + 2); i += 2; continue; }
      if (ch === "`") { mode = "code"; prevSig = "`"; prevWord = ""; i++; continue; }
      if (ch === "$" && src[i + 1] === "{") {
        tmplStack.push(depth); mode = "code"; prevSig = ""; prevWord = "";
        i += 2; continue;
      }
      blank(i, i + 1); i++; continue;
    }

    const c = src[i]!;
    if (c === "/" && src[i + 1] === "/") {
      let j = i; while (j < n && src[j] !== "\n") j++;
      blank(i, j); i = j; prevWord = ""; continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      const j = e < 0 ? n : e + 2;
      blank(i, j); i = j; prevWord = ""; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      for (; j < n; j++) {
        const ch = src[j]!;
        if (ch === "\\") { j++; continue; }
        if (ch === c || ch === "\n") break;
      }
      blank(i + 1, j);
      i = src[j] === c ? j + 1 : j;
      prevSig = c; prevWord = ""; continue;
    }
    if (c === "`") { mode = "template"; i++; continue; }
    if (c === "/" && regexAllowed()) {
      let j = i + 1; let inClass = false; let closed = false;
      for (; j < n; j++) {
        const ch = src[j]!;
        if (ch === "\\") { j++; continue; }
        if (ch === "\n") break;
        if (inClass) { if (ch === "]") inClass = false; continue; }
        if (ch === "[") { inClass = true; continue; }
        if (ch === "/") { closed = true; break; }
      }
      if (closed) {
        blank(i + 1, j);
        j++;
        while (j < n && /[a-z]/.test(src[j]!)) j++;
        i = j; prevSig = ")"; prevWord = ""; continue;
      }
      prevSig = "/"; prevWord = ""; i++; continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i; while (j < n && /[\w$]/.test(src[j]!)) j++;
      prevWord = src.slice(i, j); prevSig = src[j - 1]!;
      i = j; continue;
    }
    if (c === "{") { depth++; }
    else if (c === "}") {
      if (tmplStack.length > 0 && tmplStack[tmplStack.length - 1] === depth) {
        tmplStack.pop(); mode = "template"; i++; continue;
      }
      depth--;
    }
    if (!/\s/.test(c)) { prevSig = c; prevWord = ""; }
    i++;
  }
  return out.join("");
}

/**
 * 这五个文件里每一处 `.insert(` 的第一个实参文本。
 *
 * 为什么不只搜 "insert(schema.users)" 这个串:表名一存进变量就搜不到了
 * (`const t = schema.users; db.insert(t)` 在 drizzle 里是很自然的写法)。
 * 所以这里不去猜「它是不是 users」,而是要求**实参必须是明写的 schema.<表名>**。
 * 这五个是人手写的路由文件,不存在需要动态表名的理由;凡是算不出来的形状
 * 一律红 —— 默认答案是红,不是绿。
 */
function insertArgsOf(code: string): { line: number; arg: string }[] {
  const out: { line: number; arg: string }[] = [];
  const re = /\.\s*insert\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const open = m.index + m[0].length - 1;
    let d = 0; let end = code.length;
    for (let i = open; i < code.length; i++) {
      const c = code[i]!;
      if (c === "(") d++;
      else if (c === ")") { d--; if (d === 0) { end = i; break; } }
    }
    let line = 1;
    for (let i = 0; i < m.index; i++) if (code[i] === "\n") line++;
    out.push({ line, arg: code.slice(open + 1, end).replace(/\s+/g, " ").trim() });
  }
  return out;
}

/**
 * 从 `callee(` 开始按括号配平截出整个调用的文本。
 * 跳过函数**声明**:`function provisionAccountByEmail(… emailVerified: boolean)`
 * 的形参类型里也有 emailVerified,拿它当调用实参判会得出相反的结论。
 */
function callTextsOf(src: string, callee: string): string[] {
  const out: string[] = [];
  const needle = `${callee}(`;
  let from = 0;
  for (;;) {
    const at = src.indexOf(needle, from);
    if (at < 0) break;
    if (/\bfunction\s+$/.test(src.slice(Math.max(0, at - 40), at))) {
      from = at + needle.length;
      continue;
    }
    let depth = 0;
    let end = at + needle.length - 1;
    for (let i = end; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    out.push(src.slice(at, end + 1));
    from = end + 1;
  }
  return out;
}

describe("建号门禁：五个入口全部走收口函数", () => {
  // 自检。少了这条,把路径写错一个字母就会让下面整组断言空跑变绿。
  it("五个源文件都真的读到了", () => {
    expect(ENTRY_POINTS.length).toBe(5);
    for (const rel of ENTRY_POINTS) {
      expect(read(rel).length, rel).toBeGreaterThan(2000);
    }
  });

  // 洗源码这一步自己的活体检验。少了这两条,词法器哪天写坏成「整个文件洗成
  // 空白」,下面每一条 absence 断言都会因为「什么都没匹配到」而保持绿色。
  it("洗过的源码与原文等长，且真代码还在", () => {
    for (const rel of ENTRY_POINTS) {
      const raw = read(rel);
      const code = codeOf(raw);
      expect(code.length, rel).toBe(raw.length);
      expect(code, rel).toContain("import");
    }
  });

  it("字符串里的网址不会把同一行的代码一起洗掉", () => {
    // src/web/index.ts:120 就是这个形状,上一版在这里把 `if (raw.startsWith("`
    // 之后的半行全丢了。
    const sample = `const DOCS = "https://example.com/docs"; await db.insert(schema.users).values(v);`;
    expect(codeOf(sample)).toContain("db.insert(schema.users)");
    expect(codeOf(sample).length).toBe(sample.length);
    // 真文件上也验一遍:这一行洗完必须还带着 return
    const line = read("src/web/index.ts").split("\n").find((l) => l.includes(`raw.startsWith("//")`));
    expect(line, "src/web/index.ts 里那行 startsWith(\"//\") 不见了").toBeDefined();
    expect(codeOf(line!)).toContain("return");
  });

  it("一处都不许再往 users 表插行（表名存进变量也算）", () => {
    // 不搜 "insert(schema.users)" 这个串 —— 见 insertArgsOf 的说明。
    // 要求:这五个文件里每一处 insert 的实参都是明写的 schema.<表名>,且不是 users。
    const offenders: string[] = [];
    for (const rel of ENTRY_POINTS) {
      for (const { line, arg } of insertArgsOf(codeOf(read(rel)))) {
        const m = /^schema\s*\.\s*([A-Za-z_$][\w$]*)$/.exec(arg);
        if (!m) { offenders.push(`${rel}:${line} 实参不是明写的 schema.<表名>：${arg}`); continue; }
        if (m[1] === "users") offenders.push(`${rel}:${line} 直接往 users 插行`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("每个入口都确实调了收口函数（不是把建号一起删了）", () => {
    for (const rel of ENTRY_POINTS) {
      const src = codeOf(read(rel));
      // accounts.ts 走的是 external_idp 的薄壳 provisionAccountByEmail,
      // 那个壳自己过收口函数 —— 两种写法都算过门。
      expect(/provisionAccount(ByEmail)?\s*\(/.test(src), rel).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// emailVerified 不许硬写 true
// ---------------------------------------------------------------------------
//
// 这两条路以前都无条件写 true,于是「IdP / 苹果说这个邮箱没验过」这个事实
// 在库里消失了,后面没有任何一层还能知道。网页那条 true 是挣来的(验证码
// 刚刚校验通过),所以不在这组里。

describe("emailVerified 跟随外部断言，不是硬写的", () => {
  it("苹果登录传的是 claims.emailVerified，不是字面量 true", () => {
    const calls = callTextsOf(codeOf(read("src/routes/devices.ts")), "provisionAccount");
    expect(calls.length).toBe(1);
    const m = /emailVerified\s*:\s*([^,\n]+)/.exec(calls[0]!);
    expect(m, "provisionAccount 调用里没有 emailVerified").not.toBeNull();
    expect(m![1]!.trim()).not.toBe("true");
    expect(m![1]!.trim()).toContain("claims.emailVerified");
  });

  it("外部 IdP 懒建号不把别人的 email_verified 当成目标邮箱的断言", () => {
    const src = codeOf(read("src/lib/external_idp.ts"));
    // 声明已被 callTextsOf 跳过,剩下的就是本文件里那一处调用。
    const calls = callTextsOf(src, "provisionAccountByEmail");
    expect(calls.length).toBe(1);
    const m = /emailVerified\s*:\s*([^,\n}]+)/.exec(calls[0]!);
    expect(m, "provisionAccountByEmail 调用里没有 emailVerified 实参").not.toBeNull();
    const v = m![1]!.trim();
    expect(v).not.toBe("true");
    // 服务客户端用 X-Account 替别人开号时,令牌里的 email_verified 说的是令牌
    // 主体自己 —— 只有目标就是它自己那个邮箱时才作数。
    expect(v).toContain("selfTarget");
  });

  it("/accounts 批量开通写 false（服务客户端没验过任何东西）", () => {
    const src = codeOf(read("src/routes/accounts.ts"));
    const call = callTextsOf(src, "provisionAccountByEmail")[0]!;
    expect(/emailVerified\s*:\s*false/.test(call)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 四张对照表
// ---------------------------------------------------------------------------

const ALL_DENIALS: ProvisionDenial[] = [
  { code: "invalid_email" },
  { code: "registration_closed" },
  { code: "invite_required" },
  { code: "invite_invalid", inviteReason: "not_found" },
  { code: "domain_not_allowed", domain: "evil.example.com" },
  { code: "daily_quota_reached", quota: 7 },
  { code: "email_taken" },
  { code: "create_failed" },
];

describe("JSON 注册（src/routes/auth.ts）的错误形态", () => {
  it("八种拒绝原因都有对应形态", () => {
    expect(ALL_DENIALS.length).toBe(8);
    for (const d of ALL_DENIALS) {
      const r = registerDenialResponse(d);
      expect(r, d.code).toBeDefined();
      expect(typeof r.status, d.code).toBe("number");
      expect(r.code.length, d.code).toBeGreaterThan(0);
      expect(r.message.length, d.code).toBeGreaterThan(0);
    }
  });

  it("一条都不是 401（401 会把 App 登出）", () => {
    for (const d of ALL_DENIALS) {
      expect(registerDenialResponse(d).status, d.code).not.toBe(401);
    }
  });

  it("配额数字不回给注册的人", () => {
    const r = registerDenialResponse({ code: "daily_quota_reached", quota: 7 });
    expect(r.message).not.toContain("7");
    expect(r.code).not.toContain("7");
  });

  it("邮箱被占用沿用既有的 409 / email_already_registered", () => {
    const r = registerDenialResponse({ code: "email_taken" });
    expect(r.status).toBe(409);
    expect(r.code).toBe("email_already_registered");
  });

  it("关站 / 邀请制 / 域名不符都是 403，不是 400", () => {
    for (const code of ["registration_closed", "invite_required", "domain_not_allowed"] as const) {
      const d = code === "domain_not_allowed"
        ? ({ code, domain: "evil.example.com" } as ProvisionDenial)
        : ({ code } as ProvisionDenial);
      expect(registerDenialResponse(d).status, code).toBe(403);
    }
  });
});

describe("苹果登录（src/routes/devices.ts）的错误形态", () => {
  it("八种拒绝原因都有对应形态", () => {
    for (const d of ALL_DENIALS) {
      const r = appleProvisionDenial(d);
      expect(r, d.code).toBeDefined();
      expect(r.error.length, d.code).toBeGreaterThan(0);
    }
  });

  it("一条都不是 401（401 会把 App 登出）", () => {
    for (const d of ALL_DENIALS) {
      expect(appleProvisionDenial(d).status, d.code).not.toBe(401);
    }
  });

  it("闸门拦下来的一律 403，不是 500", () => {
    const gated: ProvisionDenial[] = [
      { code: "registration_closed" },
      { code: "invite_required" },
      { code: "invite_invalid", inviteReason: "expired" },
      { code: "domain_not_allowed", domain: "evil.example.com" },
      { code: "daily_quota_reached", quota: 7 },
    ];
    for (const d of gated) expect(appleProvisionDenial(d).status, d.code).toBe(403);
  });

  it("配额数字不从 App 漏出去", () => {
    expect(appleProvisionDenial({ code: "daily_quota_reached", quota: 7 }).error).not.toContain("7");
  });
});

describe("外部 IdP（src/lib/external_idp.ts）的错误形态", () => {
  it("八种拒绝原因都有对应形态", () => {
    for (const d of ALL_DENIALS) {
      const r = idpProvisionDenial(d);
      expect(r, d.code).toBeDefined();
      expect(r.error.length, d.code).toBeGreaterThan(0);
    }
  });

  it("一条都不是 401（服务客户端收到 401 会去重刷令牌，而问题不在令牌上）", () => {
    for (const d of ALL_DENIALS) {
      expect(idpProvisionDenial(d).code, d.code).not.toBe(401);
    }
  });

  it("闸门拦下来的是 403，不是 404「查无此人」", () => {
    for (const d of ALL_DENIALS.filter((x) => x.code !== "invalid_email" && x.code !== "email_taken" && x.code !== "create_failed")) {
      const r = idpProvisionDenial(d);
      expect(r.code, d.code).toBe(403);
    }
  });

  it("配额数字不回给服务客户端", () => {
    expect(idpProvisionDenial({ code: "daily_quota_reached", quota: 7 }).error).not.toContain("7");
  });
});

describe("网页注册（src/web/index.ts）的文案对照", () => {
  it("八种拒绝原因都有对应文案", () => {
    for (const d of ALL_DENIALS) {
      const c = registerDenialCopy(d);
      expect(c, d.code).toBeDefined();
      if (c.kind === "key") expect(c.key.length, d.code).toBeGreaterThan(0);
    }
  });

  it("邀请码的五种失效原因原样保留，不合并成一句「无效」", () => {
    const reasons = ["not_found", "revoked", "expired", "exhausted", "email_mismatch"] as const;
    const seen = new Set<string>();
    for (const reason of reasons) {
      const c = registerDenialCopy({ code: "invite_invalid", inviteReason: reason });
      expect(c.kind, reason).toBe("inviteReason");
      if (c.kind !== "inviteReason") continue;
      expect(c.reason).toBe(reason);
      seen.add(c.reason);
    }
    expect(seen.size).toBe(5);
  });

  it("关站 / 邀请制 / 域名 / 配额 四条各说各的，不共用一句话", () => {
    const keys = (
      [
        { code: "registration_closed" },
        { code: "invite_required" },
        { code: "domain_not_allowed", domain: "evil.example.com" },
        { code: "daily_quota_reached", quota: 7 },
      ] as ProvisionDenial[]
    ).map((d) => {
      const c = registerDenialCopy(d);
      expect(c.kind, d.code).toBe("key");
      return c.kind === "key" ? c.key : "";
    });
    expect(new Set(keys).size).toBe(4);
  });

  it("配额文案不带 {quota} 占位符（数字不给终端用户看）", () => {
    const c = registerDenialCopy({ code: "daily_quota_reached", quota: 7 });
    expect(c.kind).toBe("key");
    if (c.kind !== "key") return;
    expect(c.key).not.toContain("quota}");
    // 这里只出 key,调用方 tr(req, key) 不传任何变量 —— 文案里就算写了
    // {quota} 也渲染不出数字,但别留这个念想。
    expect(c.key).toBe("flash.register.quotaReached");
  });
});
