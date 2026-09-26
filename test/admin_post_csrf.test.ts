import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// 网页后台的每一个写操作都要校验 CSRF 令牌。
//
// ── 为什么不能靠 cookie 的 SameSite 兜底 ─────────────────────────────────
//
// SameSite=Lax 挡的是「跨站」。而本站和同一个上级域名下的几十个站点，在浏览器
// 眼里是**同站** —— cookie 会跟着带过来。其中任何一个站被攻破，就能在管理员
// 浏览它的时候，替他点后台的按钮。令牌是真正挡住这件事的那道闸。
//
// 这条门禁是被真事逼出来的：
//   · 一轮里新加的五个用户管理操作（解锁、发重置邮件、解绑两步验证、删号…）
//     一个都没校验，而那一轮的测试也没发现 —— 因为测试本来就没带令牌；
//   · 导入备份、站点 Logo、BIMI Logo、上传更新包四条上传路由不校验，注释写着
//     「multipart 读不到令牌，靠 SameSite 兜底」。其中导入备份能把整个库换掉，
//     更新包那条签名挡得住伪造的包、挡不住签名完好的旧版本（降级）。
//     更新包那一页的 JS 其实一直在发令牌，服务端的注释是「_csrf 忽略」。
//
// 判据：每条 POST 的处理函数里必须出现 verifyCsrf( 或 verifyMultipartCsrf(。

const WEB = path.resolve("src/web");

type Route = { file: string; path: string; ok: boolean };

function scan(file: string): Route[] {
  const src = readFileSync(path.join(WEB, file), "utf8");
  const lines = src.split("\n");
  // 路由注册都在两格缩进上：以它为界切出每条路由的处理函数。
  const starts = lines.map((l, i) => (/^ {2}app\.(post|get|put|delete|patch)\b/.test(l) ? i : -1)).filter((i) => i >= 0);
  const out: Route[] = [];
  starts.forEach((i, k) => {
    if (!/^ {2}app\.post\b/.test(lines[i]!)) return;
    const end = starts[k + 1] ?? lines.length;
    let block = lines.slice(i, end).join("\n");
    const p = /"([^"]+)"/.exec(lines[i]!)?.[1] ?? "?";
    // app.post("/x", someHandler); —— 处理函数是个具名常量，去它的定义里看。
    const named = /^ {2}app\.post(?:<[^>]*>)?\(\s*"[^"]+",\s*([A-Za-z_]\w*)\s*\);/.exec(lines[i]!);
    if (named) {
      const j = lines.findIndex((l) => new RegExp(`^ {2}const ${named[1]}\\b`).test(l));
      if (j >= 0) {
        const e = lines.findIndex((l, x) => x > j && /^ {2}(app\.|const )/.test(l));
        block = lines.slice(j, e < 0 ? lines.length : e).join("\n");
      }
    }
    out.push({ file, path: p, ok: /verifyCsrf\(|verifyMultipartCsrf\(/.test(block) });
  });
  return out;
}

/** 明确不走令牌、并且说得清为什么的路由。**往这里加之前先想清楚它为什么不需要。** */
const EXEMPT: Record<string, string> = {
  // CSP 违规报告是浏览器自己发的，按规范不带凭据，没有会话可保护。
  "/csp-report": "浏览器自动上报，不带 cookie",
};

describe("后台每个写操作都校验 CSRF", () => {
  const all = readdirSync(WEB).filter((f) => f.endsWith(".ts")).flatMap(scan);

  it("确实扫到了路由（presence —— 切分规则一失效就变成「零条全部合规」）", () => {
    const admin = all.filter((r) => r.file === "admin.ts");
    expect(admin.length, "admin.ts 里一条 POST 都没扫到").toBeGreaterThan(40);
    expect(all.some((r) => r.path === "/admin/backup/import"), "连导入备份都没扫到").toBe(true);
  });

  it("**admin.ts 里没有一条 POST 漏掉令牌**", () => {
    const missing = all.filter((r) => r.file === "admin.ts" && !r.ok && !EXEMPT[r.path]).map((r) => r.path);
    expect(
      missing,
      "这些后台写操作没校验 CSRF 令牌 —— 同一个上级域名下的任何一个站被攻破，" +
        "都能在管理员浏览它的时候替他执行。上传表单请用 verifyMultipartCsrf，" +
        "并且模板里 _csrf 要排在 type=\"file\" 前面。",
    ).toEqual([]);
  });

  it("上传表单里 _csrf 排在文件框前面（排在后面的话，服务端拿到文件时还没解析到它）", () => {
    const VIEWS = path.resolve("src/views/admin");
    const offenders: string[] = [];
    for (const f of readdirSync(VIEWS).filter((x) => x.endsWith(".ejs"))) {
      const src = readFileSync(path.join(VIEWS, f), "utf8");
      for (const m of src.matchAll(/<form[^>]*multipart\/form-data[^>]*>([\s\S]*?)<\/form>/g)) {
        const body = m[1]!;
        const fileAt = body.search(/type="file"/);
        if (fileAt < 0) continue;
        const csrfAt = body.search(/name="_csrf"/);
        // 表单由 JS 自己拼 FormData 的（没有文件框的 name，或者 action 不在这里）不在此列。
        if (csrfAt < 0 || csrfAt > fileAt) offenders.push(`${f}: ${/action="([^"]+)"/.exec(m[0])?.[1] ?? "?"}`);
      }
    }
    expect(offenders, "这些上传表单的 _csrf 缺失或者排在文件框后面").toEqual([]);
  });
});
