import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { sanitizeReturnTo } from "../src/lib/return_to.js";

// 登录完能不能回到「原本要去的那一页」。
//
// ── 这条的形状 ────────────────────────────────────────────────────────
//
// 未登录访问受保护页面 → 服务端把那个路径写进签名 cookie → 送去 /login。
// 登录成功后读回来、跳回去。**问题在于「登录成功」有六条路**：
// 密码、邮箱验证码、两步验证的验证码、两步验证的备用码、Passkey、SSO。
// 少一条读 cookie，那条路上的用户就会落到 /app，而他本来要去别处。
//
// 真出过事：这段判据被手抄成四份，三处注释都写着「keep both in sync」，
// 然后就没同步上 —— Passkey 和 SSO 那两份的白名单少了 /oauth。
// 于是第三方应用发起授权、用户用 Passkey 或 SSO 登录，就落到日历首页，
// 授权断在半路，第三方那边一直等。用密码登录则一切正常，所以「有时候才出现」。
//
// 所以这里守两件事：
//   ① 判据只有一份（没人再抄第五份）；
//   ② 每一条登录路都真的去读它。

const WEB = path.resolve("src/web");
const src = (f: string) => readFileSync(path.join(WEB, f), "utf8");

describe("登录后回原页：判据只有一份", () => {
  it("web 下没有第二份手抄的白名单正则（presence + 核心）", () => {
    // 抄一份出来最容易的形态就是把这串正则复制走。
    const offenders: string[] = [];
    for (const f of readdirSync(WEB).filter((x) => x.endsWith(".ts"))) {
      const body = src(f);
      if (/\^\\\/\(app\|admin\|web-pair/.test(body)) offenders.push(f);
    }
    expect(
      offenders,
      "这些文件里又出现了一份自己的白名单正则。判据一旦有两份就会各走各的 —— " +
        "上次就是这么让 Passkey / SSO 登录丢掉 /oauth 的。改判据请改 lib/return_to.ts。",
    ).toEqual([]);
  });

  it("共用模块确实导出了判据（presence —— 不然上面那条在「文件都读错了」时也绿）", () => {
    expect(typeof sanitizeReturnTo).toBe("function");
    expect(sanitizeReturnTo("/app")).toBe("/app");
  });
});

describe("每一条登录路都要读 return_to", () => {
  // 文件 → 这条路上「登录成功」的标志
  const LOGIN_EXITS: [string, string][] = [
    ["index.ts", "密码 / 邮箱验证码"],
    ["mfa.ts", "两步验证（验证码 + 备用码）"],
    ["webauthn.ts", "Passkey"],
    ["sso.ts", "SSO"],
  ];

  it.each(LOGIN_EXITS)("%s（%s）读了共用的 return_to", (file) => {
    // **要匹配「调用」，不是「出现过这个名字」。** 第一版写的是
    // /returnToOrApp|consumeReturnTo/，而 import 那一行本身就含这个名字 ——
    // A/B 当场证明：把调用处换成写死的 "/app"，这条照样绿。
    const body = src(file).split("\n").filter((l) => !l.trim().startsWith("import")).join("\n");
    expect(
      /(returnToOrApp|consumeReturnTo)\s*\(/.test(body),
      `${file} 里没有任何一处读 return_to —— 这条路上的用户登录完一律落到 /app，` +
        "而他本来要去的是别的页面。表现是「有时候登录完不去我要去的那一页」，" +
        "而且只在走这条登录方式时出现，所以特别难查。",
    ).toBe(true);
  });
});

describe("白名单本身", () => {
  it("**/oauth 必须放行**（第三方授权就断在这里）", () => {
    expect(
      sanitizeReturnTo("/oauth/authorize?client_id=x&state=y"),
      "把 /oauth 判成不合法 —— 第三方应用发起授权、用户登录完会落到日历首页，" +
        "授权流程断在半路，而第三方那边一直等。",
    ).toBe("/oauth/authorize?client_id=x&state=y");
  });

  it.each([
    ["/app", "/app"],
    ["/app/settings", "/app/settings"],
    ["/admin/users?page=2", "/admin/users?page=2"],
    ["/web-pair/ABC123", "/web-pair/ABC123"],
    ["/desktop-pair/XYZ", "/desktop-pair/XYZ"],
  ])("放行 %s", (input, want) => {
    expect(sanitizeReturnTo(input)).toBe(want);
  });

  it.each([
    ["//evil.example.com", "协议相对地址，浏览器会当成跨站"],
    ["/\\evil.example.com", "反斜杠变体，同上"],
    ["https://evil.example.com", "绝对地址"],
    ["/logout", "不在白名单里的本站路径"],
    ["", "空串"],
  ])("挡住 %s（%s）", (input) => {
    expect(sanitizeReturnTo(input), "这是开放重定向").toBeNull();
  });

  it("超长的挡住", () => {
    expect(sanitizeReturnTo("/app/" + "x".repeat(300))).toBeNull();
  });

  it("片段去掉（服务端跳转本来也带不过去）", () => {
    expect(sanitizeReturnTo("/app#section")).toBe("/app");
  });
});
