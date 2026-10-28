import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { API_CSRF_EXEMPT_PATHS } from "../src/lib/api_csrf.js";

// 网页端（src/web/*.ts：后台 + 用户自己的页面）的每一个写操作都要校验 CSRF 令牌。
// 文件名还叫 admin_post_csrf —— 它一开始只扫后台；现在 src/web 下每个文件都扫。
//
// ── 为什么不能靠 cookie 的 SameSite 兜底 ─────────────────────────────────
//
// SameSite=Lax 挡的是「跨站」。而本站和同一个上级域名下的几十个站点，在浏览器
// 眼里是**同站** —— cookie 会跟着带过来。其中任何一个站被攻破，就能在用户
// 浏览它的时候，替他点本站的按钮。令牌是真正挡住这件事的那道闸。
//
// 这条门禁是被真事逼出来的：
//   · 一轮里新加的五个用户管理操作（解锁、发重置邮件、解绑两步验证、删号…）
//     一个都没校验，而那一轮的测试也没发现 —— 因为测试本来就没带令牌；
//   · 导入备份、站点 Logo、BIMI Logo、上传更新包四条上传路由不校验，注释写着
//     「multipart 读不到令牌，靠 SameSite 兜底」。其中导入备份能把整个库换掉，
//     更新包那条签名挡得住伪造的包、挡不住签名完好的旧版本（降级）；
//   · 后台修完之后，用户这一侧的「导入 .ics 文件」还是只认 cookie —— 门禁只扫
//     admin.ts，它不在视野里。同站任何一个页面都能往登录着的人日历里塞一批事件。
//
// ── 真实的规则（判据照它写，别多也别少）────────────────────────────────
//
//   · /api/* 的写请求有一道全局钩子（src/lib/api_csrf.ts 的 registerApiCsrf）：
//     走会话 cookie 的必须带 X-CSRF-Token 头；Bearer 和 API_CSRF_EXEMPT_PATHS 里的
//     匿名引导接口除外。所以路径在 /api/ 下、又不在豁免名单里的，算已覆盖。
//   · /api/* 以外**没有任何全局钩子**（server.ts 里只装了上面那一道）。
//     每条 POST / PUT / PATCH / DELETE（app.all 也算）的处理函数自己要调：
//       - 普通表单 / JSON：verifyCsrf(
//       - 上传（处理函数里读 req.file( / req.files( / req.parts( / saveRequestFiles( ）：
//         verifyMultipartCsrf( —— verifyCsrf 读的是 req.body，multipart 的 body 是空的，
//         它在这里只认得请求头，原生表单发不了头，等于正常用户全被拒、或者被人改成「不校验」。
//   · 确实不读 cookie 的（凭据在请求体 / URL / Authorization 头里），写进下面的 EXEMPT，
//     并且写清楚为什么；它们的处理函数里一旦出现读会话的调用，豁免当场失效。

const WEB = path.resolve("src/web");
const WRITE = ["POST", "PUT", "PATCH", "DELETE"];

type Route = { file: string; method: string; path: string; block: string };

const START = /^ {2,4}app\.(post|get|put|delete|patch|head|options|route|all)\b/;

function scan(file: string): Route[] {
  const src = readFileSync(path.join(WEB, file), "utf8");
  const lines = src.split("\n");
  const starts = lines.map((l, i) => (START.test(l) ? i : -1)).filter((i) => i >= 0);
  const out: Route[] = [];
  starts.forEach((i, k) => {
    const line = lines[i]!;
    // 处理函数的范围：到下一条路由注册为止，并且不越过这条路由自己的收尾 `  });`
    // （文件里最后一条路由后面跟的辅助函数不能算进来，不然它们里面的 verifyCsrf 会冒名顶替）。
    const next = starts[k + 1] ?? lines.length;
    const close = lines.findIndex((l, x) => x > i && x < next && /^ {2}\}\);\s*$/.test(l));
    let block = lines.slice(i, close >= 0 ? close + 1 : next).join("\n");

    let methods: string[];
    let p: string;
    const short = /^ {2,4}app\.(post|put|patch|delete|all)(?:<[^>]*>)?\(\s*"([^"]+)"/.exec(line);
    if (short) {
      methods = [short[1] === "all" ? "ALL" : short[1]!.toUpperCase()];
      p = short[2]!;
      // app.post("/x", someHandler); —— 处理函数是个具名常量，去它的定义里看。
      const named = /^ {2}app\.\w+(?:<[^>]*>)?\(\s*"[^"]+",\s*([A-Za-z_]\w*)\s*\);/.exec(line);
      if (named) {
        const j = lines.findIndex((l) => new RegExp(`^ {2}const ${named[1]}\\b`).test(l));
        if (j >= 0) {
          const e = lines.findIndex((l, x) => x > j && /^ {2}(app\.|const )/.test(l));
          block = lines.slice(j, e < 0 ? lines.length : e).join("\n");
        }
      }
    } else if (/app\.route\(/.test(line)) {
      const m = /method:\s*"([A-Z]+)"/.exec(block);
      methods = [m?.[1] ?? "?"];
      p = /url:\s*"([^"]+)"/.exec(block)?.[1] ?? "?";
    } else {
      return; // GET / HEAD / OPTIONS
    }
    for (const method of methods) {
      if (method !== "ALL" && method !== "?" && !WRITE.includes(method)) continue;
      out.push({ file, method, path: p, block });
    }
  });
  return out;
}

const MULTIPART = /req\.(file|files|parts|saveRequestFiles)\(/;
/** 读 cookie 会话的调用。豁免的路由里出现任何一个，豁免就不成立了。 */
const READS_SESSION = /loadSession\(|loadAuthedUser\(|loadUserFromRequest\(|requireAdmin\(|requireUser\w*\(|req\.cookies|unsignCookie\(|bwc_sid/;

type Verdict = "ok" | "missing" | "multipart-needs-verifyMultipartCsrf" | "unknown-method";
function verdict(r: Route): Verdict {
  if (r.method === "?") return "unknown-method";
  if (r.path.startsWith("/api/") && !API_CSRF_EXEMPT_PATHS.has(r.path)) return "ok"; // 全局钩子
  if (MULTIPART.test(r.block)) return /verifyMultipartCsrf\(/.test(r.block) ? "ok" : "multipart-needs-verifyMultipartCsrf";
  return /verifyCsrf\(/.test(r.block) ? "ok" : "missing";
}

const key = (r: Route) => `${r.method} ${r.path}`;

/** 明确不走令牌、并且说得清为什么的路由。**往这里加之前先想清楚：它真的不读 cookie 吗？** */
const EXEMPT: Record<string, string> = {
  // 邮件里那条邀请链接的回执。凭据是 URL 里的邀请令牌：拿不到令牌改不了，
  // 拿到了也不需要借谁的登录 —— 没有会话可被冒用。
  "POST /event-invite/:token/respond": "凭据是 URL 里的邀请令牌，不读 cookie",
  // OAuth 2.0 的令牌端点，是第三方客户端的服务器在调：client_id/secret（或 Basic 头）+ 授权码。
  "POST /oauth/token": "OAuth 客户端凭据 + 授权码，不读 cookie",
  // 凭据是请求体里那个要撤销的令牌本身。
  "POST /oauth/revoke": "凭据是要撤销的令牌本身，不读 cookie",
  // CalDAV 只认 Authorization: Basic（应用专用密码），整份 caldav.ts 不碰会话（下面有一条单独盯着）。
  "PUT /caldav/:userId/:calId/:uid": "CalDAV 只认 Basic 认证",
  "DELETE /caldav/:userId/:calId/:uid": "CalDAV 只认 Basic 认证",
  // Apple 日历添加账号时的探测：一个跳转、一个 404，不读会话、不写任何东西。
  "ALL /.well-known/caldav": "只回跳转",
  "ALL /.well-known/carddav": "只回 404",
};

const all = readdirSync(WEB).filter((f) => f.endsWith(".ts")).flatMap(scan);

describe("网页端每个写操作都校验 CSRF", () => {
  it("确实扫到了路由（presence —— 切分规则一失效就变成「零条全部合规」）", () => {
    const count = (f: string) => all.filter((r) => r.file === f).length;
    expect(count("admin.ts"), "admin.ts 里一条写操作都没扫到").toBeGreaterThan(40);
    expect(count("index.ts"), "index.ts 里一条写操作都没扫到").toBeGreaterThan(30);
    expect(all.some((r) => r.path === "/admin/backup/import"), "连导入备份都没扫到").toBe(true);
    const icsUpload = all.find((r) => r.path === "/app/calendars/:id/import/file");
    expect(icsUpload, "连导入 .ics 文件都没扫到").toBeDefined();
    expect(MULTIPART.test(icsUpload!.block), "导入 .ics 文件没被认成上传 —— 上传的判据失效了").toBe(true);
    expect(all.some((r) => r.method === "PUT" && r.path.startsWith("/caldav/")), "app.route 形式的 CalDAV PUT 没扫到").toBe(true);
  });

  it("**src/web 下没有一条写操作漏掉令牌**", () => {
    const bad = all
      .filter((r) => !EXEMPT[key(r)])
      .map((r) => ({ at: `${r.file} ${key(r)}`, v: verdict(r) }))
      .filter((x) => x.v !== "ok")
      .map((x) => `${x.at}：${x.v}`);
    expect(
      bad,
      "这些写操作没按规矩校验 CSRF 令牌 —— 同一个上级域名下的任何一个站被攻破，" +
        "都能在用户浏览它的时候替他执行。普通表单用 verifyCsrf；上传用 verifyMultipartCsrf，" +
        "并且表单里 _csrf 要排在 type=\"file\" 前面。确实不读 cookie 的，写进 EXEMPT 并说明理由。",
    ).toEqual([]);
  });

  it("豁免名单里每一条都对得上一条真实的路由（改名 / 删掉之后不能留着一张空白支票）", () => {
    const keys = new Set(all.map(key));
    expect(Object.keys(EXEMPT).filter((k) => !keys.has(k))).toEqual([]);
  });

  it("**豁免的路由真的不读 cookie 会话**（一旦读了，豁免就是在关掉 CSRF）", () => {
    const offenders = all.filter((r) => EXEMPT[key(r)] && READS_SESSION.test(r.block)).map((r) => `${r.file} ${key(r)}`);
    expect(offenders).toEqual([]);
    // CalDAV 的写操作把活交给 putEvent / deleteEvent，处理函数不在路由块里 —— 整个文件一起看。
    const caldav = readFileSync(path.join(WEB, "caldav.ts"), "utf8");
    expect(READS_SESSION.test(caldav), "caldav.ts 开始读 cookie 会话了 —— CalDAV 写操作的豁免不再成立").toBe(false);
  });

  it("上传表单里 _csrf 排在文件框前面（排在后面的话，服务端拿到文件时还没解析到它）", () => {
    const VIEWS = path.resolve("src/views");
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      // private/ 是站点私有扩展，不在公开仓库里。
      if (e.isDirectory()) return e.name === "private" ? [] : walk(full);
      return e.name.endsWith(".ejs") ? [full] : [];
    });
    const offenders: string[] = [];
    const scanned: string[] = [];
    for (const f of walk(VIEWS)) {
      const src = readFileSync(f, "utf8");
      // 标签里的 <%= … %> 要整个吞掉：action="/app/calendars/<%= calendar.id %>/…" 里那个 %> 的
      // 「>」会让 [^>]* 提前停下 —— 第一版就是这样，日历页那张表单根本没被扫到，把它挪到文件框
      // 后面照样全绿（A/B 抓到的）。
      for (const m of src.matchAll(/<form\b((?:<%[\s\S]*?%>|[^>])*)>([\s\S]*?)<\/form>/g)) {
        if (!/multipart\/form-data/.test(m[1]!)) continue;
        const body = m[2]!;
        const fileAt = body.search(/type="file"/);
        if (fileAt < 0) continue;
        const where = `${path.relative(VIEWS, f)}: ${/action="((?:<%[\s\S]*?%>|[^"])*)"/.exec(m[1]!)?.[1] ?? "?"}`;
        scanned.push(where);
        const csrfAt = body.search(/name="_csrf"/);
        if (csrfAt < 0 || csrfAt > fileAt) offenders.push(where);
      }
    }
    expect(scanned.length, "一张上传表单都没扫到 —— 匹配规则失效了").toBeGreaterThan(3);
    expect(
      scanned.some((w) => w.startsWith(path.join("app", "calendar.ejs")) && w.includes("/import/file")),
      `日历页「导入 .ics 文件」那张表单没被扫到。扫到的：${scanned.join("；")}`,
    ).toBe(true);
    expect(offenders, "这些上传表单的 _csrf 缺失或者排在文件框后面").toEqual([]);
  });
});
