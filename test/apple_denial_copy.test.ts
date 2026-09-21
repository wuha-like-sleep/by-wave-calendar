// 苹果登录被拒时,**已经发布出去的 iOS 包**能不能显示一句人话。
//
// 为什么这一档必须存在:那些包在用户手上,改不了。
// apps/ios/ByWaveCalendar/Auth/AppleSignIn.swift 里 `.server` 的文案表只认识
// 四个码(apple_token_invalid / account_disabled / apple_signin_not_configured /
// apps_disabled),其余全部落到 default 分支。而 default 分支的第一行是:
//
//     if let msg, !msg.isEmpty { return msg }
//
// —— 服务端给了非空的 message 就直接显示它,不给就把状态码和码名拼起来摆给
// 用户看(「Apple 登录失败 (HTTP 409) - email_taken」)。所以这一档守的是
// 「拒绝分支必须带 message」,而不是「文案写得好不好」:少写一句,存量 iOS
// 用户当场退回那串中英夹杂的东西,而服务端不报错、日志里什么都没有。
//
// 三条硬约束:
//   - 每个拒绝分支都得有非空 message(absence 类),同时断言分支数量下限
//     (presence 类)—— 否则哪天有人把路由改个名,扫描扫了个空,这一档会
//     绿得比谁都干净。
//   - message 里不许出现内部码名 / HTTP 状态码 / 接口路径。用户照着这句话
//     要能知道下一步干什么,不是把码翻译成中文。
//   - 八门语言都得有,不许靠英文回落。英文回落是运行时兜底,不是发版标准。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { ProvisionDenial } from "../src/lib/account_provisioning.js";
import { appleProvisionDenial } from "../src/routes/devices.js";
import { LOCALES, translatePlain, type LocaleCode } from "../src/lib/i18n.js";
import { en } from "../src/lib/i18n/locales/en.js";
import { zhCN } from "../src/lib/i18n/locales/zh-CN.js";
import { zhTW } from "../src/lib/i18n/locales/zh-TW.js";
import { ja } from "../src/lib/i18n/locales/ja.js";
import { ko } from "../src/lib/i18n/locales/ko.js";
import { es } from "../src/lib/i18n/locales/es.js";
import { fr } from "../src/lib/i18n/locales/fr.js";
import { de } from "../src/lib/i18n/locales/de.js";

/** 八本字典按 code 摆好 —— 下面要逐本检查「这个键是它自己有的」,
 *  而不是 translate() 回落到英文之后看起来也有。 */
const DICTS: Record<LocaleCode, Partial<Record<string, string>>> = {
  en,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  ja,
  ko,
  es,
  fr,
  de,
};

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

/** 这一批文案的命名空间。改名的话下面每一条都会红(键数下限会先红)。 */
const NS = "appleLogin.";

const APPLE_KEYS = Object.keys(en).filter((k) => k.startsWith(NS));

// ---------------------------------------------------------------------------
// 一、拒绝原因 → 文案键 的对照表
// ---------------------------------------------------------------------------

describe("苹果登录建号被拒:每条原因都有一句能照着做的话", () => {
  it("八种拒绝原因都给出 messageKey，且八门语言都翻得出非空文案", () => {
    // presence:原因表本身还是八条。哪天 ProvisionDenial 多一条而这里没跟上,
    // 先红在这一行,而不是让下面的循环少转一圈、静悄悄地全绿。
    expect(ALL_DENIALS.length).toBe(8);
    for (const d of ALL_DENIALS) {
      const r = appleProvisionDenial(d);
      expect(r.messageKey, d.code).toBeTruthy();
      expect(r.messageKey.startsWith(NS), `${d.code} 的 messageKey=${r.messageKey}`).toBe(true);
      for (const l of LOCALES) {
        const text = translatePlain(l.code, r.messageKey);
        expect(text.length, `${d.code} / ${l.code}`).toBeGreaterThan(0);
        // 键本身被原样吐回来 = 这个键压根不存在(translate 的最后一级回落)。
        expect(text, `${d.code} / ${l.code}`).not.toBe(r.messageKey);
      }
    }
  });

  it("闸门拦下来的五条各说各的，不是同一句通用文案", () => {
    // 五条闸门(关站 / 邀请缺 / 邀请无效 / 域名 / 配额)对用户来说下一步完全
    // 不同:有的是「明天再来」,有的是「去网页用邀请链接注册」。合并成一句
    // 「注册被拒绝」等于没修。
    const gated: ProvisionDenial[] = [
      { code: "registration_closed" },
      { code: "invite_required" },
      { code: "invite_invalid", inviteReason: "expired" },
      { code: "domain_not_allowed", domain: "evil.example.com" },
      { code: "daily_quota_reached", quota: 7 },
    ];
    const texts = gated.map((d) => translatePlain("zh-CN", appleProvisionDenial(d).messageKey));
    // 邀请缺 / 邀请无效 这两条对 App 本来就是同一件事(苹果登录带不出邀请码),
    // 所以去重之后是 4 句,不是 5 句。
    expect(new Set(texts).size).toBe(4);
  });

  it("配额数字不从文案里漏出去", () => {
    // 那是管理员设的闸门,不该从 App 漏出去 —— error 串那条规矩同样适用于
    // 现在这句人话。
    const r = appleProvisionDenial({ code: "daily_quota_reached", quota: 7 });
    for (const l of LOCALES) {
      expect(translatePlain(l.code, r.messageKey), l.code).not.toContain("7");
    }
  });
});

// ---------------------------------------------------------------------------
// 二、文案卫生:不许把内部词摆给用户
// ---------------------------------------------------------------------------

/** 这些词出现在用户可见文案里就是漏内部实现。 */
const FORBIDDEN_SUBSTRINGS = [
  "email_taken", "signup_closed", "signup_invite_only", "signup_domain_not_allowed",
  "signup_quota_reached", "account_create_failed", "invalid_email", "apple_token_invalid",
  "account_disabled", "apps_disabled", "apple_signin_not_configured", "device_create_failed",
  "bad_request", "account_claim_unproven",
  "HTTP", "http", "/api", "api/v1", "/auth/apple", "SIWA", "identityToken",
];

describe("文案卫生", () => {
  it("命名空间下的键一条都不少（扫空了要红）", () => {
    // 这是上面和下面所有「不许出现 X」的 presence 配对:扫描对象为空的话,
    // 「一条都不违规」是真的,但毫无意义。键的数量只增不减,下限写死。
    expect(APPLE_KEYS.length).toBeGreaterThanOrEqual(10);
  });

  it("八门语言的文案里都不出现内部码名 / HTTP 状态码 / 接口路径", () => {
    expect(APPLE_KEYS.length).toBeGreaterThan(0);
    for (const key of APPLE_KEYS) {
      for (const l of LOCALES) {
        const text = translatePlain(l.code, key);
        for (const bad of FORBIDDEN_SUBSTRINGS) {
          expect(text, `${key} / ${l.code} 里出现了「${bad}」`).not.toContain(bad);
        }
        // 三位数字 = 状态码。这批文案里本来就不该有任何数字。
        expect(/\d{3}/.test(text), `${key} / ${l.code} 里出现了三位数字`).toBe(false);
      }
    }
  });

  it("每句话都给出下一步，不是把码翻译一遍", () => {
    // 判据只能是长度:一句「注册已关闭」是六个字,「本站暂时不接受新用户注册,
    // 如果你已经有账号请改用原来的登录方式」不是。太短的那种正是这次要消灭的
    // 东西。阈值取 12 个字符 —— 中文里这已经是最短的一句完整指引。
    expect(APPLE_KEYS.length).toBeGreaterThanOrEqual(10);
    for (const key of APPLE_KEYS) {
      for (const l of LOCALES) {
        expect(translatePlain(l.code, key).length, `${key} / ${l.code} 太短`).toBeGreaterThanOrEqual(12);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 三、八门语言齐全(不许靠英文回落)
// ---------------------------------------------------------------------------

describe("八门语言齐全", () => {
  it("每个键在每本字典里都是它自己有的", () => {
    expect(APPLE_KEYS.length).toBeGreaterThanOrEqual(10);
    for (const l of LOCALES) {
      const dict = DICTS[l.code];
      for (const key of APPLE_KEYS) {
        const own = Object.prototype.hasOwnProperty.call(dict, key) && (dict[key] ?? "").length > 0;
        expect(own, `${l.code} 缺 ${key}`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 四、源码门禁:/auth/apple 的每个拒绝分支都得带 message
// ---------------------------------------------------------------------------
//
// 为什么要扫源码:上面那几条守的是「文案表齐不齐」,守不住「路由某个分支
// 忘了把它发出去」。而那个分支平时根本走不到 —— 站长把注册关掉的那天才走到,
// 到时候没人在看日志。

/** 去掉注释再判定:注释里写「原来这里回的是 { error: "email_taken" }」不该把
 *  门禁喂饱。按行剥 `//` 会把字符串里的网址截断(本仓库出过这个事),所以只剥
 *  整行注释和块注释,行尾注释留着 —— 这批分支的行尾没有注释,留着也不影响。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

/** 截出 /auth/apple 这个 handler 的源码文本(到下一个同级 app.post/app.get 为止)。 */
function appleHandlerSource(): string {
  const src = stripComments(readFileSync(path.resolve("src/routes/devices.ts"), "utf8"));
  const start = src.indexOf('app.post("/auth/apple"');
  expect(start, "src/routes/devices.ts 里找不到 /auth/apple 路由").toBeGreaterThan(-1);
  const rest = src.slice(start + 10);
  const nextRoute = rest.search(/\n {2}app\.(post|get|delete|patch|put)\(/);
  return nextRoute === -1 ? rest : rest.slice(0, nextRoute);
}

describe("/auth/apple 的拒绝分支（源码门禁）", () => {
  it("每个 .send({ error: ... }) 都带 message", () => {
    const body = appleHandlerSource();
    // `reply.code(<n>).send({ ... })` —— 把每个 send 的实参文本截出来。
    const sends = [...body.matchAll(/reply\s*\.code\([^)]*\)\s*\.send\((\{[^}]*\})\)/g)].map((m) => m[1]!);
    // presence:路由改名 / 写法改成别的形状时,这里会变成 0 条,先红在这一行。
    expect(sends.length, "扫不到拒绝分支了（路由改名或写法变了？）").toBeGreaterThanOrEqual(8);
    for (const s of sends) {
      expect(s, `这个分支没带 message: ${s}`).toContain("message:");
    }
  });

  it("message 取自请求解析出来的语言，不是硬编码中文", () => {
    const body = appleHandlerSource();
    // 硬编码的中文串(比如 message: "注册已关闭")在这条路上就是「只有中文
    // 用户看得懂」。这一条钉住「这里过了 t()」。
    const sends = [...body.matchAll(/reply\s*\.code\([^)]*\)\s*\.send\((\{[^}]*\})\)/g)].map((m) => m[1]!);
    expect(sends.length).toBeGreaterThanOrEqual(8);
    for (const s of sends) {
      const m = /message:\s*([^,}]+)/.exec(s);
      expect(m, `截不出 message 实参: ${s}`).not.toBeNull();
      expect(m![1]!.trim(), `message 看起来是硬编码的: ${s}`).toMatch(/^t\(/);
    }
  });
  // ── 文案不许许诺一个不存在的功能 ─────────────────────────────────────────
  //
  // 第一版这几条写的是「请先用原来的方式登录，再到设置里绑定苹果账号」。
  // 全仓库**没有**这个功能：users.apple_sub 只在 /auth/apple 里写过，
  // 设置页那个「登录方式」面板绑的是 SSO 提供方（/auth/idp/<slug>/login?link=1），
  // 苹果不是 SSO 提供方。用户照着做会在设置页里翻半天，然后认为功能坏了。
  //
  // 真实行为是：在网页上用同一个邮箱注册并验证之后，下次点苹果登录会自动接上，
  // 不需要任何手动绑定。
  //
  // 这条断言钉的是**根因**而不是某一句中文 —— 文案有八门语言，按字符串判
  // 只会漏掉其中几门。真加了绑定功能的那一天，这里先红，写文案的人就会被带回来。
  it("apple_sub 仍然只有一处写入（多了就说明加了绑定功能，那几条文案要跟着改）", () => {
    const roots = ["src/routes", "src/lib", "src/web"];
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const ent of readdirSync(path.resolve(dir), { withFileTypes: true })) {
        const full = `${dir}/${ent.name}`;
        // private/ 是站点私有扩展，不在公开仓库里，跳过。
        if (ent.isDirectory()) { if (ent.name !== "private") walk(full); continue; }
        if (ent.name.endsWith(".ts")) files.push(full);
      }
    };
    for (const r of roots) walk(r);

    const writes: string[] = [];
    for (const f of files) {
      const src = readFileSync(path.resolve(f), "utf8");
      // drizzle 的两种写法：.set({ … appleSub … }) 和建号时的 .values({ … appleSub … })
      for (const m of src.matchAll(/\.(?:set|values)\(\s*\{[^}]*\bappleSub\b/g)) {
        writes.push(`${f}:${src.slice(0, m.index).split("\n").length}`);
      }
    }

    // presence：一处都扫不到 = 正则失效了，先红在这一行，别让它空扫描着变绿。
    expect(writes.length, "扫不到任何 appleSub 的写入点 —— 这条断言已经瞎了").toBeGreaterThan(0);
    expect(
      writes.length,
      `appleSub 现在有 ${writes.length} 处写入（${writes.join(", ")}）。` +
        "多出来的那处如果是「在设置里绑定苹果账号」，那 appleLogin.* 里几条" +
        "「请改用你原来的登录方式」的文案就不再准确了，要一起改。",
    ).toBe(2);
  });
});
