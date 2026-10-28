// 日历主页「导入日历」弹窗：失败不能说「导入完成」。
//
// 以前弹窗只看请求有没有出错：粘贴那条 fetch 带 redirect:"manual"，拿到 opaqueredirect
// 就算成功；上传那条跟着服务端的 302 跳到日历页、拿到 200 也算成功。服务端放在 ?error=
// 里的那句话一个字都没读到 —— 文件过大、不是 .ics、粘贴超长，用户看到的都是「导入完成」，
// 页面一刷新什么都没有。
//
// 这里分两层：
//   · 判定本身（readImportResponse）是 calendar-app.js 顶上的纯函数，node 里直接打，
//     把以前会被当成成功的那几种响应一个个喂进去 —— 这一层是行为断言；
//   · 弹窗有没有真的用它、FormData 里令牌排没排在文件前面 —— 这一层只能对源码做接线
//     检查（仓库里没有 jsdom，弹窗本身不在 node 里跑），强度弱一档：改名能骗过它，
//     但「删掉 Accept 头」「改回 redirect:manual」「先 toast 再看结果」这几种退化会红。
//   服务端那一半（Accept: application/json 时回 { ok, message }）在
//   test/integration/web_ics_import.int.test.ts，从 HTTP 打进去。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import "../src/public/calendar-app.js";

import { en } from "../src/lib/i18n/locales/en.js";
import { zhCN } from "../src/lib/i18n/locales/zh-CN.js";
import { zhTW } from "../src/lib/i18n/locales/zh-TW.js";
import { ja } from "../src/lib/i18n/locales/ja.js";
import { ko } from "../src/lib/i18n/locales/ko.js";
import { es } from "../src/lib/i18n/locales/es.js";
import { fr } from "../src/lib/i18n/locales/fr.js";
import { de } from "../src/lib/i18n/locales/de.js";

type Resp = { status: number; type?: string; json(): Promise<unknown> };
const { readImportResponse } = (globalThis as unknown as {
  bwcImportResult: {
    readImportResponse(resp: Resp, T: (k: string, vars?: Record<string, unknown>) => string): Promise<{ message: string; partial: boolean }>;
  };
}).bwcImportResult;

// 用中文文案当 T：断言里能直接看见用户会读到什么。
const T = (k: string, vars?: Record<string, unknown>) => {
  let s = (zhCN as Record<string, string>)[k] ?? k;
  for (const [kk, v] of Object.entries(vars ?? {})) s = s.replaceAll(`{${kk}}`, String(v));
  return s;
};

const jsonResp = (status: number, body: unknown): Resp => ({ status, json: async () => body });
const htmlResp = (status: number): Resp => ({ status, json: async () => { throw new SyntaxError("Unexpected token '<'"); } });

async function outcome(resp: Resp): Promise<{ ok: true; message: string; partial: boolean } | { ok: false; message: string; userFacing: boolean }> {
  try {
    const r = await readImportResponse(resp, T);
    return { ok: true, ...r };
  } catch (e) {
    const err = e as Error & { userFacing?: boolean };
    return { ok: false, message: err.message, userFacing: !!err.userFacing };
  }
}

describe("readImportResponse：只有服务端明说 ok:true 才算导入了", () => {
  it("**以前被当成成功的三种：opaqueredirect、302、跳转后的 200 HTML —— 现在都是失败**", async () => {
    const cases: Array<[string, Resp]> = [
      ["粘贴走 redirect:manual 拿到的 opaqueredirect", { status: 0, type: "opaqueredirect", json: async () => { throw new TypeError("opaque"); } }],
      ["服务端的 302", htmlResp(302)],
      ["跟着 302 跳到日历页拿到的 200 HTML", htmlResp(200)],
    ];
    for (const [label, resp] of cases) {
      const o = await outcome(resp);
      expect(o.ok, `${label} 被当成了导入成功 —— 用户会看到「导入完成」而什么都没有`).toBe(false);
      expect(o.message).not.toBe(T("app.js.import.done"));
      expect(o.message, label).toBe(T("app.js.import.reloadAndRetry"));
    }
  });

  it("**服务端说失败 → 原样显示服务端那句话**（文件过大 / 不是 .ics / 粘贴太长）", async () => {
    for (const [status, message] of [
      [413, "文件过大（上限 8MB）"],
      [400, "不是有效的 iCalendar 文件"],
      [413, "粘贴的内容太长（最多 1,000,000 个字符）。更大的日历请改用上传 .ics 文件（最大 8MB）。"],
    ] as const) {
      const o = await outcome(jsonResp(status, { ok: false, message }));
      expect(o.ok, `HTTP ${status} 的失败被当成了成功`).toBe(false);
      expect(o).toMatchObject({ message, userFacing: true });
    }
  });

  it("只认严格的 ok === true：没有 ok 字段的 200 JSON、ok 是字符串，都不算", async () => {
    for (const body of [{}, { inserted: 3 }, { ok: "true" }, { ok: 1 }, null, []]) {
      const o = await outcome(jsonResp(200, body));
      expect(o.ok, `${JSON.stringify(body)} 被当成了导入成功`).toBe(false);
    }
  });

  it("令牌失效的 403（{ error: csrf_invalid }，没有 message）→ 让用户刷新再试", async () => {
    const o = await outcome(jsonResp(403, { error: "csrf_invalid" }));
    expect(o).toMatchObject({ ok: false, message: T("app.js.import.reloadAndRetry") });
  });

  it("别的形状的错（Fastify 默认的 500 / 413）→ 「导入失败：HTTP 状态码」", async () => {
    const o = await outcome(jsonResp(500, { statusCode: 500, error: "Internal Server Error", message: "boom" }));
    expect(o.ok).toBe(false);
    expect(o.message, "没带 ok:false 的 message 不该原样显示（可能是英文、可能带内部信息）").toBe(T("app.js.import.failed", { error: "HTTP 500" }));
  });

  it("成功 → 带回服务端那句（含条数）；订阅存下但拉取失败 → partial", async () => {
    expect(await outcome(jsonResp(200, { ok: true, message: "导入成功：新增 3 · 更新 0 · 跳过 0", inserted: 3 })))
      .toEqual({ ok: true, message: "导入成功：新增 3 · 更新 0 · 跳过 0", partial: false });
    expect(await outcome(jsonResp(200, { ok: true, partial: true, message: "订阅已保存但首次拉取失败" })))
      .toMatchObject({ ok: true, partial: true });
  });
});

// ---------------------------------------------------------------------------
// 接线检查：判定再对，弹窗没用上也是白的
// ---------------------------------------------------------------------------
const APP_JS = readFileSync(path.resolve("src/public/calendar-app.js"), "utf8");

function submitHandler(): string {
  const m = /importForm\.addEventListener\("submit",[\s\S]*?\n {4}\}\);/.exec(APP_JS);
  if (!m) throw new Error("calendar-app.js 里找不到导入弹窗的 submit 监听");
  return m[0];
}
function postImportFn(): string {
  const m = /async function postImport\([\s\S]*?\n {2}\}/.exec(APP_JS);
  if (!m) throw new Error("calendar-app.js 里找不到 postImport");
  return m[0];
}

describe("导入弹窗确实走这套判定", () => {
  it("**四种来源都经 postImport 发出去，「导入完成」只在拿到结果之后**", () => {
    const h = submitHandler();
    for (const p of ["import/file", "import/url-once", "subscriptions", "import/text"]) {
      expect(h, `来源 ${p} 不见了`).toContain(`"${p}"`);
    }
    // 导入请求只有这一处，不许再直接 fetch 导入路由、也不许回到旧的 postForm。
    expect(h.match(/postImport\(/g)?.length, "导入请求应该只从 postImport 发一次").toBe(1);
    expect(h).not.toMatch(/fetch\(`\/app\/calendars\//);
    expect(APP_JS).not.toMatch(/function postForm\(/);
    // 「导入完成」那句的 toast 要排在 await postImport 之后，并且就是用它的结果。
    const callAt = h.search(/const result = await postImport\(/);
    const doneAt = h.indexOf('T("app.js.import.done")');
    expect(callAt, "没有 `const result = await postImport(...)` —— 结果没被接住").toBeGreaterThanOrEqual(0);
    expect(doneAt).toBeGreaterThan(callAt);
    expect(h.slice(callAt, doneAt + 40)).toMatch(/result\.message \|\| T\("app\.js\.import\.done"\)/);
    expect(h, "postImport 的失败被吞掉了").not.toMatch(/postImport\([^)]*\)\s*\.catch/);
  });

  it("postImport 带 Accept: application/json、不拦跳转，结果交给 readImportResponse", () => {
    const fn = postImportFn();
    expect(fn, "不带这个头，服务端回的是 302，弹窗又读不到失败原因").toMatch(/Accept:\s*"application\/json"/);
    expect(fn, "redirect:manual 会把一切变成 opaqueredirect").not.toMatch(/redirect:\s*"manual"/);
    expect(fn).toMatch(/return globalThis\.bwcImportResult\.readImportResponse\(resp, T\)/);
  });

  it("**上传的 FormData 里 _csrf 排在 file 前面**（服务端拿到文件那一刻只解析过它前面的字段）", () => {
    const h = submitHandler();
    const csrfAt = h.indexOf('body.append("_csrf", ctx.csrfToken)');
    const fileAt = h.indexOf('body.append("file"');
    expect(csrfAt, "上传没带 _csrf —— 服务端会 403").toBeGreaterThanOrEqual(0);
    expect(fileAt).toBeGreaterThan(csrfAt);
  });

  it("失败时显示服务端那句话（userFacing），不再套一层「导入失败：」", () => {
    const h = submitHandler();
    expect(h).toMatch(/err && err\.userFacing \? err\.message : T\("app\.js\.import\.failed"/);
  });
});

describe("新增文案的八语覆盖", () => {
  const LOCALES: Array<[string, Partial<Record<string, string>>]> = [
    ["en", en], ["zh-CN", zhCN], ["zh-TW", zhTW], ["ja", ja],
    ["ko", ko], ["es", es], ["fr", fr], ["de", de],
  ] as Array<[string, Partial<Record<string, string>>]>;
  it("app.js.import.reloadAndRetry 八种语言都有，而且不是英文原样照抄", () => {
    for (const [code, dict] of LOCALES) {
      const s = dict["app.js.import.reloadAndRetry"];
      expect(s, `${code} 缺 app.js.import.reloadAndRetry`).toBeTruthy();
      if (code !== "en") expect(s, `${code} 直接用了英文`).not.toBe(en["app.js.import.reloadAndRetry"]);
    }
  });
});
