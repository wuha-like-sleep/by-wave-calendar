import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// 守「半登录会话不许用来做授权判断」。
//
// ── 为什么需要这条 ────────────────────────────────────────────────────
//
// loadSession() 故意**不**查二次验证 —— /login/mfa 那一页自己得先读到
// 半登录会话,才能让人把验证码补上。代价是:除了 MFA 流程本身之外,
// 任何地方直接用 loadSession 都等于「密码对了就放行」。
//
// 实际踩到的三条,全是持久化后门,受害者改密码也清不掉:
//   · 半登录状态能给账号注册一个新 passkey → 之后永远免密登录;
//   · 能删掉受害者已有的 passkey;
//   · 能替受害者点掉一次 OAuth 授权,把 token 交出去。
// 也就是说攻击者哪怕停在「请输入验证码」那一页,也已经能做成事了。
//
// 收口成 loadFullSession()。这条门禁盯的是**新增的裸用法** ——
// 这类东西不会以 bug 的形式出现,它只会以「又一个 await loadSession(req)」
// 的形式出现,而且当时看上去完全正常。
//
// 判据钉在源码上而不是行为上:要造出「半登录会话去打 passkey 注册」的
// 真实请求,得把 webauthn 那一整套挑战/验证拉起来;而这条要防的是
// 「有人加了一行」,源码判据正好对得上。

const ROOTS = ["src/web", "src/routes", "src/lib"];

/**
 * 允许继续用裸 loadSession 的地方,每条都要有理由。
 *
 * 加条目之前先问一句:这一处读到会话之后,**做不做授权判断**?
 * 做的话就该用 loadFullSession,不该加进这张表。
 */
const ALLOWED: Record<string, string> = {
  "src/lib/session.ts":
    "定义处,以及 loadFullSession / loadUserFromRequest 内部各包一层。",
  "src/web/mfa.ts":
    "MFA 流程本身。/login/mfa 必须能读到半登录会话才能让人补验证码;" +
    "而 /app/settings/mfa/* 那四条自己都显式判了 s.mfaSatisfied。",
  "src/web/index.ts":
    "loadAuthedUser 读完立刻判 mfaEnabled && !mfaSatisfied 并跳 /login/mfa;" +
    "验邮箱那处只是「已经登录就别覆盖会话」,不是授权判断。",
  "src/web/admin.ts":
    "requireAdmin 跟 loadAuthedUser 同一个形状:读完立刻判 mfaEnabled && !mfaSatisfied。" +
    "这里要的正是半登录会话本身 —— 有它才能把人送去 /login/mfa 把验证码补上," +
    "换成 loadFullSession 的话只能一律退回 /login,人会以为自己密码错了。",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of readdirSync(path.resolve(dir), { withFileTypes: true })) {
    const full = `${dir}/${ent.name}`;
    // private/ 是站点私有扩展,不在公开仓库里。
    if (ent.isDirectory()) { if (ent.name !== "private") walk(full, out); continue; }
    if (ent.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** 去掉整行注释 —— 否则解释这个坑的注释自己会触发门禁。
 *  本仓库为这件事红过一次:一条天天误报的门禁和没有门禁是一样的。 */
function codeOnly(src: string): string {
  return src
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");
}

type Use = { file: string; line: number; text: string };

function collect(): Use[] {
  const out: Use[] = [];
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      const lines = codeOnly(readFileSync(path.resolve(file), "utf8")).split("\n");
      lines.forEach((l, i) => {
        // loadFullSession 里也含 "loadSession",所以要排掉它。
        if (!/\bloadSession\s*\(/.test(l)) return;
        if (/loadFullSession\s*\(/.test(l)) return;
        out.push({ file, line: i + 1, text: l.trim() });
      });
    }
  }
  return out;
}

const uses = collect();

describe("半登录会话不许用来做授权判断", () => {
  it("确实扫到了用法（presence）", () => {
    // 少了这条,正则一失配就变成「空集合里没有违规」,永远绿。
    // 本仓库的门禁踩过不止一次同一个形状。
    expect(
      uses.length,
      "一个 loadSession( 都没扫到 —— 正则失配了,这条断言已经瞎了",
    ).toBeGreaterThan(3);
  });

  it("白名单本身指向真实存在的文件（presence）", () => {
    const seen = new Set(uses.map((u) => u.file));
    const stale = Object.keys(ALLOWED).filter((f) => !seen.has(f));
    expect(
      stale,
      "白名单里这些文件已经不用 loadSession 了 —— 条目该删掉,否则它在替未来的新用法背书",
    ).toEqual([]);
  });

  it("裸 loadSession 只出现在白名单里的文件中", () => {
    const offenders = uses
      .filter((u) => !(u.file in ALLOWED))
      .map((u) => `${u.file}:${u.line}  ${u.text}`);
    expect(
      offenders,
      "这些地方用了裸 loadSession。它读到的可能是一个**只验了密码、还没过二次验证**的会话 —— " +
        "拿它做授权判断等于二次验证不存在。要「此刻是完整登录状态」请用 loadFullSession;" +
        "确实需要读半登录会话(只有 MFA 流程本身)就把文件加进 ALLOWED 并写明理由。",
    ).toEqual([]);
  });

  it("createSession 不再接受调用方自己声称「已过二次验证」", () => {
    const src = codeOnly(readFileSync(path.resolve("src/lib/session.ts"), "utf8"));
    expect(
      /mfaSatisfied\s*\?\?\s*true/.test(src),
      "createSession 又出现了 `mfaSatisfied ?? true` —— 「不说就算过了」正是这个洞的全部:" +
        "POST /api/auth/login 什么都不传,开了 TOTP 的账号拿密码就能换到完整会话。",
    ).toBe(false);
    expect(
      /factor:\s*SessionFactor/.test(src),
      "createSession 的签名里没有必填的 SessionFactor —— 收口没了,新入口又能默默拿到「已验证」会话",
    ).toBe(true);
  });
});
