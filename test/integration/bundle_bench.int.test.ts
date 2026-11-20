// 日历页资源拆分基准（非常规测试的一部分）。
//
// 只在显式开启时运行：
//   npm run build:assets   # 先出生产口径的静态资源（_built / lib / css）
//   BWC_BENCH=1 npx vitest run --config vitest.integration.config.ts \
//     test/integration/bundle_bench.int.test.ts
// 改前改后各跑一次（BWC_BUNDLE_TAG=before / after 区分截图），数字对照进报告。
//
// 测什么（真服务端 + 真 Chromium，CDP 驱动）：
//   · 五个页面（首页 / 日历页 / 设置 / 通知 / 下载）各自实际传输的资源清单
//     与字节数（PerformanceResourceTiming 的 transferSize，含压缩后体积），
//     其中 toastui-* 单独列账 —— 非日历页必须为 0；
//   · 日历页的关键时刻：DOMContentLoaded、boot splash 退场（壳可见）、
//     toastui 网格首次出现、第一个事件元素渲染；
//   · 布局偏移（CLS，layout-shift 累计）与关键元素（工具栏 / 侧栏 / 日历区）
//     在「壳出现时」和「网格完成时」两帧的位置，验证拆分不引入跳动；
//   · 截图（BWC_SHOTS_DIR，默认 ~/workspace/bywave-review-shots/bundle）：
//     日历页壳状态（限速冷加载、splash 刚退场那一帧）、桌面 / 展开 800 /
//     手机 390 / 深色四种完成态，以及设置 / 通知 / 首页 / 下载完成态。
//
// 方法学说明：DB 是进程内 PGlite、静态文件走 fastifyStatic + compress，
// 与生产同口径注册；网络限速只在日历冷加载一档开（1.6Mbps / 150ms，
// 近似 Fast 3G），为的是把「库在关键路径上」的代价放大到可读。绝对毫秒
// 只用于同一环境改前改后的相对对比。
import { vi, beforeAll, afterAll, describe, it } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
vi.mock("../../src/lib/mailer.js", () => ({
  sendMail: vi.fn(async () => ({ ok: true })),
  isMailerEnabled: vi.fn(async () => true),
}));

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import view from "@fastify/view";
import ejs from "ejs";
import compress from "@fastify/compress";
import fastifyStatic from "@fastify/static";
import {
  ensureSchema, resetDb, db, schema,
  makeUser, makeCalendar, loginAs,
} from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://bench:bench@localhost:5432/bench";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";

const { webRoutes } = await import("../../src/web/index.js");
const { calendarRoutes } = await import("../../src/routes/calendars.js");
const { eventRoutes } = await import("../../src/routes/events.js");
const { importRoutes } = await import("../../src/routes/import.js");
const { exportRoutes } = await import("../../src/routes/export.js");
const { searchRoutes } = await import("../../src/routes/search.js");
const { notificationRoutes } = await import("../../src/routes/notifications.js");
const { subscriptionRoutes } = await import("../../src/routes/subscriptions.js");
const { makeT, LOCALES, SITE_LOCALE_OPTIONS, localeOptionLabel } = await import("../../src/lib/i18n.js");
const { env } = await import("../../src/env.js");
const { jsonForScript } = await import("../../src/lib/script_json.js");

const run = process.env.BWC_BENCH === "1" ? describe : describe.skip;
const CHROME = process.env.BWC_CHROME || "/opt/meta-chromium/chrome";
const SHOTS = process.env.BWC_SHOTS_DIR || "/home/hatch/workspace/bywave-review-shots/bundle";
const TAG = process.env.BWC_BUNDLE_TAG || "run";

// ---------------------------------------------------------------------------
// 极简 CDP 客户端（浏览器级 WS + flatten 会话）。
// ---------------------------------------------------------------------------
class Cdp {
  private ws: WebSocket;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners: ((m: any) => void)[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string };
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) { try { fn(msg); } catch { /* noop */ } }
      }
    });
  }

  onEvent(fn: (m: any) => void) { this.listeners.push(fn); }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("ws connect failed")), { once: true });
    });
    return new Cdp(ws);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = ++this.seq;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 注入到每个新文档：记录壳出现 / 网格出现 / 事件渲染的时刻与 CLS。
const MARKS_SRC = `
(function () {
  var M = (window.__bwcMarks = { cls: 0, shell: 0, grid: 0, events: 0 });
  try {
    new PerformanceObserver(function (l) {
      l.getEntries().forEach(function (e) { if (!e.hadRecentInput) M.cls += e.value; });
    }).observe({ type: "layout-shift", buffered: true });
  } catch (e) {}
  var iv = setInterval(function () {
    if (!M.shell && document.body && document.body.classList.contains("bwc-booted")) M.shell = performance.now();
    var cal = document.getElementById("calendar");
    if (cal) {
      if (!M.grid && cal.querySelector('[class*="toastui-calendar-"]')) M.grid = performance.now();
      if (!M.events && cal.querySelector('.toastui-calendar-event-time, [class*="toastui-calendar-weekday-event"]')) M.events = performance.now();
    }
  }, 20);
  setTimeout(function () { clearInterval(iv); }, 60000);
})();
`;

interface PageResult {
  name: string;
  dcl: number;
  shell: number;
  grid: number;
  events: number;
  cls: number;
  totalKB: number;
  toastuiKB: number;
  requests: number;
  eventEls: number;
  rects: Record<string, number[] | null>;
  shellRects: Record<string, number[] | null> | null;
  netBad: string[];
  bootedLive: boolean;
  bodyBg: string;
  pageText: string;
}

let app: FastifyInstance;
let base = "";
let chromeProc: ChildProcess | null = null;
let cdp: Cdp;

async function launchChrome(): Promise<void> {
  const userDir = `/tmp/bwc-bundle-chrome-${process.pid}`;
  // 本机 Chromium 是 Hatch 定制构建：启动必须带 WebGL 域名策略文件与其
  // SHA-256 两个开关（缺了直接以 "policy is required" 退出）。用
  // all-origins 契约的最小策略文件即可，本基准只访问 127.0.0.1。
  const policyPath = `/tmp/bwc-webgl-policy-${process.pid}.txt`;
  writeFileSync(policyPath, "hatch-webgl-all-origins-v1\n");
  const policySha = createHash("sha256").update(readFileSync(policyPath)).digest("hex");
  chromeProc = spawn(CHROME, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    // 本地网络访问检查会把「公有页面 → 127.0.0.1」直接拦掉
    // (ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS)；把环回段声明为
    // public 地址空间后，本基准的本地服务才可达（只影响这台测试浏览器）。
    "--ip-address-space-overrides=127.0.0.0/8=public",
    "--remote-debugging-port=0", `--user-data-dir=${userDir}`,
    `--hatch-webgl-allowed-domains-file=${policyPath}`,
    `--hatch-webgl-allowed-domains-sha256=${policySha}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const port = await new Promise<number>((resolve, reject) => {
    let buf = "";
    chromeProc!.stderr!.on("data", (d) => {
      buf += String(d);
      const m = buf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) resolve(Number(m[1]));
    });
    chromeProc!.on("exit", () => reject(new Error("chrome exited early")));
    setTimeout(() => reject(new Error("chrome devtools port timeout")), 30000);
  });
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { webSocketDebuggerUrl: string };
  cdp = await Cdp.connect(ver.webSocketDebuggerUrl);
}

interface ScenarioOpts {
  name: string;
  url: string;
  width: number;
  height: number;
  mobile?: boolean;
  cookie?: string;
  throttle?: boolean;
  dark?: boolean;
  reuseContextId?: string;
  shellShot?: string;
  finalShot?: string;
  waitFor: "calendar" | "page";
}

async function runScenario(o: ScenarioOpts): Promise<{ result: PageResult; contextId: string }> {
  const { browserContextId } = o.reuseContextId
    ? { browserContextId: o.reuseContextId }
    : await cdp.send("Target.createBrowserContext", {});
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", browserContextId });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const S = sessionId as string;
  await cdp.send("Page.enable", {}, S);
  await cdp.send("Network.enable", {}, S);
  await cdp.send("Runtime.enable", {}, S);
  const netBad: string[] = [];
  const reqUrl = new Map<string, string>();
  cdp.onEvent((m) => {
    if (m.sessionId !== S) return;
    if (m.method === "Network.requestWillBeSent") reqUrl.set(m.params.requestId, m.params.request.url);
    else if (m.method === "Network.responseReceived" && m.params.response.status >= 400)
      netBad.push(`${m.params.response.status} ${String(m.params.response.url).split("/").slice(-1)[0]}`);
    else if (m.method === "Network.loadingFailed")
      netBad.push(`FAIL ${m.params.errorText} ${String(reqUrl.get(m.params.requestId) || "").split("/").slice(-1)[0]}`);
  });
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: o.width, height: o.height, deviceScaleFactor: 1, mobile: !!o.mobile,
  }, S);
  if (o.dark) {
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    }, S);
  }
  if (o.cookie) {
    const idx = o.cookie.indexOf("=");
    await cdp.send("Network.setCookie", {
      name: o.cookie.slice(0, idx), value: o.cookie.slice(idx + 1), url: base,
    }, S);
  }
  if (o.throttle) {
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false, latency: 150,
      downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8,
    }, S);
  }
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: MARKS_SRC }, S);

  const evaluate = async (expr: string): Promise<any> => {
    const r = await Promise.race([
      cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true }, S),
      sleep(4000).then(() => { throw new Error("evaluate timeout"); }),
    ]);
    if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.text}`);
    return r.result?.value;
  };
  const shot = async (file: string) => {
    await evaluate("window.scrollTo(0, 1); window.scrollTo(0, 0); 'nudged'").catch(() => undefined);
    await sleep(350);
    const r = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true }, S);
    writeFileSync(path.join(SHOTS, file), Buffer.from(r.data as string, "base64"));
  };
  const RECTS_EXPR = `(function () {
    function rect(sel) { var el = document.querySelector(sel); if (!el) return null;
      var b = el.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; }
    return { toolbar: rect("#calendar-app header"), sidebar: rect("#cal-sidebar"),
             calendar: rect("#calendar"), main: rect("main") };
  })()`;

  await cdp.send("Page.navigate", { url: base + o.url }, S);
  const t0 = Date.now();
  let shellRects: Record<string, number[] | null> | null = null;
  let shellShotDone = false;
  let last: any = null;
  while (Date.now() - t0 < 45000) {
    last = await evaluate(`(function () {
      var nav = performance.getEntriesByType("navigation")[0];
      return { marks: window.__bwcMarks || null, ready: document.readyState,
               dcl: nav ? nav.domContentLoadedEventEnd : 0 };
    })()`).catch(() => null);
    const m = last?.marks;
    if (m && m.shell && !shellShotDone) {
      shellShotDone = true;
      if (o.shellShot) {
        shellRects = await evaluate(RECTS_EXPR).catch(() => null);
        await shot(o.shellShot).catch(() => undefined);
      }
    }
    const done = o.waitFor === "calendar"
      ? (m && m.shell && m.events)
      : (m && m.shell && last?.ready === "complete");
    if (done) break;
    await sleep(150);
  }
  await sleep(700); // 让尾随的 layout-shift / 渲染落定
  const fin = await evaluate(`(function () {
    var res = performance.getEntriesByType("resource").map(function (r) {
      return { name: r.name, transfer: r.transferSize };
    });
    function rect(sel) { var el = document.querySelector(sel); if (!el) return null;
      var b = el.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; }
    return { res: res, marks: window.__bwcMarks || null,
      dcl: (performance.getEntriesByType("navigation")[0] || {}).domContentLoadedEventEnd || 0,
      rects: { toolbar: rect("#calendar-app header"), sidebar: rect("#cal-sidebar"),
               calendar: rect("#calendar"), main: rect("main") },
      bootedLive: !!(document.body && document.body.classList.contains("bwc-booted")),
      bodyBg: document.body ? getComputedStyle(document.body).backgroundColor : "",
      pageText: (document.body ? document.body.innerText : "").slice(0, 80),
      eventEls: document.querySelectorAll('#calendar .toastui-calendar-event-time, #calendar [class*="toastui-calendar-weekday-event"]').length };
  })()`);
  if (o.finalShot) await shot(o.finalShot).catch(() => undefined);
  await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);

  let total = 0, toastui = 0;
  for (const r of fin.res as { name: string; transfer: number }[]) {
    total += r.transfer;
    if (r.name.includes("toastui")) toastui += r.transfer;
  }
  const navEntry = (fin.res as { name: string; transfer: number }[]).length;
  return {
    contextId: browserContextId,
    result: {
      name: o.name,
      dcl: Math.round(fin.dcl),
      shell: Math.round(fin.marks?.shell || 0),
      grid: Math.round(fin.marks?.grid || 0),
      events: Math.round(fin.marks?.events || 0),
      cls: Math.round((fin.marks?.cls || 0) * 1000) / 1000,
      totalKB: Math.round(total / 102.4) / 10,
      toastuiKB: Math.round(toastui / 102.4) / 10,
      requests: navEntry + 1,
      eventEls: fin.eventEls,
      rects: fin.rects,
      shellRects,
      netBad,
      bootedLive: !!fin.bootedLive,
      bodyBg: String(fin.bodyBg || ""),
      pageText: String(fin.pageText || "").replace(/\s+/g, " "),
    },
  };
}

run("calendar bundle bench", () => {
  beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true });
    await ensureSchema();
    const assetVersion = readFileSync(path.resolve("asset-version.txt"), "utf8").trim();
    app = Fastify({ logger: false });
    await app.register(cookie, { secret: env.SESSION_SECRET });
    await app.register(formbody);
    await app.register(view, {
      engine: { ejs }, root: path.resolve("src/views"), propertyName: "view", options: { async: false },
      layout: "layout.ejs",
      defaultContext: {
        t: makeT("zh-CN"), siteName: "ByWave", siteLogoUrl: null, icpNumber: null, icpUrl: "",
        assetVersion, jsBasePath: "/static/_built", cspNonce: "bench", currentLocale: "zh-CN",
        locales: LOCALES, siteLocaleOptions: SITE_LOCALE_OPTIONS, siteDefaultLocale: "zh-CN",
        sitePalette: "indigo", siteDensity: "comfortable", themeMode: "system", currentUser: null,
        registrationOpen: true, registrationMode: "open", ssoEnabled: false, ssoLabel: "", ssoProviders: [],
        themePalette: "indigo", themeDensity: "comfortable", currentPath: "/app", jsonForScript,
        localeLabel: (entry: { code: string; label: string; labelEn: string }, gloss?: boolean) =>
          localeOptionLabel(entry, "zh-CN", gloss ?? false),
      },
    });
    await app.register(compress, { global: true, encodings: ["br", "gzip"], threshold: 1024 });
    await app.register(fastifyStatic, {
      root: path.join(process.cwd(), "src", "public"), prefix: "/static/", cacheControl: true, maxAge: "7d",
    });
    await app.register(webRoutes);
    for (const prefix of ["/api", "/api/v1"]) {
      await app.register(calendarRoutes, { prefix });
      await app.register(eventRoutes, { prefix });
      await app.register(importRoutes, { prefix });
      await app.register(exportRoutes, { prefix });
      await app.register(searchRoutes, { prefix });
      await app.register(notificationRoutes, { prefix });
      await app.register(subscriptionRoutes, { prefix });
    }
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    await launchChrome();
  }, 120000);

  afterAll(async () => {
    try { cdp?.close(); } catch { /* noop */ }
    try { chromeProc?.kill("SIGKILL"); } catch { /* noop */ }
    await app?.close();
  });

  it("debug: dump browser log + resources for landing and calendar", async () => {
    if (process.env.BWC_DEBUG !== "1") return;
    const user = await makeUser("dbg@example.com");
    await makeCalendar(user.id, "工作");
    const auth = await loginAs(app, user.id);
    const probe = async (url: string, cookie?: string) => {
      const { browserContextId } = await cdp.send("Target.createBrowserContext", {});
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", browserContextId });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      const S = sessionId as string;
      const logs: string[] = [];
      cdp.onEvent((m) => {
        if (m.sessionId !== S) return;
        if (m.method === "Log.entryAdded") logs.push(`LOG ${m.params.entry.level}: ${m.params.entry.text} (${m.params.entry.url || ""})`);
        if (m.method === "Runtime.consoleAPICalled") logs.push(`CONSOLE ${m.params.type}: ${(m.params.args || []).map((a: any) => a.value ?? a.description ?? "").join(" ")}`);
        if (m.method === "Runtime.exceptionThrown") logs.push(`EXC: ${m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text}`);
      });
      await cdp.send("Page.enable", {}, S);
      await cdp.send("Log.enable", {}, S);
      await cdp.send("Runtime.enable", {}, S);
      await cdp.send("Network.enable", {}, S);
      if (cookie) {
        const idx = cookie.indexOf("=");
        await cdp.send("Network.setCookie", { name: cookie.slice(0, idx), value: cookie.slice(idx + 1), url: base }, S);
      }
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: MARKS_SRC }, S);
      await cdp.send("Page.navigate", { url: base + url }, S);
      await sleep(6000);
      const r = await cdp.send("Runtime.evaluate", {
        expression: `(function () {
          var sheets = [];
          for (var i = 0; i < document.styleSheets.length; i++) {
            var s = document.styleSheets[i]; var n = -1;
            try { n = s.cssRules ? s.cssRules.length : -2; } catch (e) { n = -3; }
            sheets.push((s.href || "inline") + " rules=" + n);
          }
          return {
            booted: document.body.classList.contains("bwc-booted"),
            bodyBg: getComputedStyle(document.body).backgroundColor,
            swController: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
            marks: window.__bwcMarks || null,
            sheets: sheets,
            res: performance.getEntriesByType("resource").map(function (x) { return x.name.split("/").slice(-1)[0] + "=" + x.transferSize; }),
            headStart: document.documentElement.outerHTML.slice(0, 300),
          };
        })()`, returnByValue: true,
      }, S);
      console.log(`\n#### DEBUG ${url}\n` + JSON.stringify(r.result?.value, null, 1) + "\n" + logs.join("\n"));
      await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
    };
    await probe("/");
    await probe("/app", auth);
  }, 120000);

  it("interactions: views, event click, drag, loader failure state", async () => {
    if (process.env.BWC_INTERACT !== "1") return;
    await resetDb();
    const user = await makeUser("interact@example.com");
    const calA = await makeCalendar(user.id, "工作");
    const now = new Date();
    const at = (h: number, m = 0) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
    const [evRow] = await db.insert(schema.events).values({
      calendarId: calA.id, uid: "interact-1@bywave", summary: "交互测试会",
      startsAt: at(10), endsAt: at(11),
    }).returning();
    if (!evRow) throw new Error("seed event missing");
    const auth = await loginAs(app, user.id);

    const open = async () => {
      const { browserContextId } = await cdp.send("Target.createBrowserContext", {});
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", browserContextId });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      const S = sessionId as string;
      const errors: string[] = [];
      cdp.onEvent((m) => {
        if (m.sessionId !== S) return;
        if (m.method === "Runtime.exceptionThrown")
          errors.push(String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
      });
      await cdp.send("Page.enable", {}, S);
      await cdp.send("Runtime.enable", {}, S);
      await cdp.send("Network.enable", {}, S);
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, S);
      const idx = auth.indexOf("=");
      await cdp.send("Network.setCookie", { name: auth.slice(0, idx), value: auth.slice(idx + 1), url: base }, S);
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: MARKS_SRC }, S);
      const ev2 = async (expr: string): Promise<any> => {
        const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true }, S);
        if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.text}`);
        return r.result?.value;
      };
      const shot = async (file: string) => {
        const r = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true }, S);
        writeFileSync(path.join(SHOTS, file), Buffer.from(r.data as string, "base64"));
      };
      const center = async (sel: string) => ev2(`(function () {
        var el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null;
        var b = el.getBoundingClientRect();
        return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
      })()`);
      const clickAt = async (x: number, y: number) => {
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 }, S);
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 }, S);
      };
      return { S, targetId, errors, ev2, shot, center, clickAt };
    };

    // ---- 主流程：视图切换 / 点事件 / 拖拽 ----
    const P = await open();
    await cdp.send("Page.navigate", { url: base + "/app" }, P.S);
    for (let i = 0; i < 60; i++) {
      const m = await P.ev2("window.__bwcMarks || null").catch(() => null);
      if (m && m.events) break;
      await sleep(250);
    }
    await sleep(500);
    const lines: string[] = ["", "=== 交互回归（拆分后）==="];
    const skeletonGone = await P.ev2("!document.getElementById('calendar-skeleton')");
    lines.push(`事件渲染后骨架已移除: ${skeletonGone}`);
    const label = () => P.ev2("document.querySelector('#period-label')?.textContent || ''");
    lines.push(`周视图 period: ${await label()}`);

    for (const view of ["month", "day", "week"] as const) {
      const c = await P.center(`[data-view="${view}"]`);
      if (!c) throw new Error(`view button ${view} not found`);
      await P.clickAt(c.x, c.y);
      await sleep(900);
      const state = await P.ev2(`(function () {
        var cal = document.getElementById('calendar');
        return {
          label: document.querySelector('#period-label')?.textContent || '',
          monthCells: cal.querySelectorAll('[class*="toastui-calendar-month"] [class*="toastui-calendar-template-monthGridCell"], .toastui-calendar-monthdaygrid, [class*="monthdaygrid"]').length,
          timeEvents: cal.querySelectorAll('.toastui-calendar-event-time').length,
          weekdayEvents: cal.querySelectorAll('[class*="toastui-calendar-weekday-event"]').length,
        };
      })()`);
      lines.push(`切到 ${view}: label=${state.label} timeEvents=${state.timeEvents} weekdayEvents=${state.weekdayEvents} monthCells=${state.monthCells}`);
      await P.shot(`interact-${view}-${TAG}.png`);
    }

    // 点事件 → 编辑弹窗（先滚进可视区：时间网格有内部滚动，元素可能被裁切）
    await P.ev2("document.querySelector('.toastui-calendar-event-time')?.scrollIntoView({ block: 'center' }); 'scrolled'");
    await sleep(400);
    const evCenter = await P.center(".toastui-calendar-event-time");
    if (!evCenter) throw new Error("event element not found in week view");
    const hit = await P.ev2(`(function () {
      var el = document.querySelector('.toastui-calendar-event-time');
      var b = el.getBoundingClientRect();
      var cx = Math.round(b.x + b.width / 2), cy = Math.round(b.y + b.height / 2);
      var hit = document.elementFromPoint(cx, cy);
      return { rect: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)],
               hitTag: hit ? hit.tagName + '.' + String(hit.className).slice(0, 60) : 'none',
               hitIsEvent: !!hit && (hit === el || el.contains(hit)) };
    })()`);
    lines.push(`点击落点诊断: rect=${JSON.stringify(hit.rect)} hit=${hit.hitTag} 命中事件元素=${hit.hitIsEvent}`);
    await P.shot(`interact-before-click-${TAG}.png`);
    await P.clickAt(evCenter.x, evCenter.y);
    await sleep(1200);
    let modal = await P.ev2(`(function () {
      var m = document.getElementById('modal-event');
      var f = document.getElementById('form-event');
      return { open: !!m && !m.classList.contains('hidden'),
               summary: f ? (f.querySelector('[name="summary"]')?.value || '') : '' };
    })()`);
    if (!modal.open) {
      // 兜底诊断：直接派发 DOM 鼠标事件序列，区分「CDP 输入没送达」
      // 与「应用 clickEvent 链路本身不通」。
      await P.ev2(`(function () {
        var el = document.querySelector('.toastui-calendar-event-time');
        var b = el.getBoundingClientRect();
        var opts = { bubbles: true, cancelable: true, clientX: b.x + b.width / 2, clientY: b.y + b.height / 2, button: 0 };
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));
        return 'dispatched';
      })()`);
      await sleep(1200);
      modal = await P.ev2(`(function () {
        var m = document.getElementById('modal-event');
        var f = document.getElementById('form-event');
        return { open: !!m && !m.classList.contains('hidden'),
                 summary: f ? (f.querySelector('[name="summary"]')?.value || '') : '' };
      })()`);
      lines.push(`DOM 事件兜底后: 弹窗打开=${modal.open} 标题=${modal.summary}`);
    }
    lines.push(`点击事件: 弹窗打开=${modal.open} 标题=${modal.summary}`);
    await P.shot(`interact-event-modal-${TAG}.png`);
    const closeC = await P.center("#modal-event .modal-close");
    if (closeC) { await P.clickAt(closeC.x, closeC.y); await sleep(500); }

    // 拖拽事件（周视图时间轴上向下拖 ≈ +1 小时）
    const before = await db.select().from(schema.events).where(eq(schema.events.id, evRow.id));
    await P.ev2("document.querySelector('.toastui-calendar-event-time')?.scrollIntoView({ block: 'center', behavior: 'instant' }); 'scrolled'");
    await sleep(900);
    const c2 = await P.center(".toastui-calendar-event-time");
    if (!c2) throw new Error("event element not found for drag");
    // 实测时间轴一小时的行高，按 +1 小时定拖拽距离
    const hourPx = await P.ev2(`(function () {
      var rows = document.querySelectorAll('.toastui-calendar-timegrid-hour-rows, [class*="timegrid-time"]');
      var grid = document.querySelector('.toastui-calendar-timegrid');
      if (!grid) return 0;
      var times = document.querySelectorAll('[class*="toastui-calendar-timegrid-time"]');
      if (times.length >= 2) {
        var a = times[0].getBoundingClientRect(), b = times[1].getBoundingClientRect();
        return Math.round(Math.abs(b.y - a.y)) || 0;
      }
      return 0;
    })()`);
    const dragPx = hourPx > 0 ? hourPx : 48;
    lines.push(`拖拽参数: 一小时行高=${hourPx}px 拖拽距离=${dragPx}px`);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: c2.x, y: c2.y, button: "left", buttons: 1, clickCount: 1 }, P.S);
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c2.x, y: Math.round(c2.y + (dragPx * i) / steps), button: "left", buttons: 1 }, P.S);
      await sleep(60);
    }
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: c2.x, y: c2.y + dragPx, button: "left", buttons: 0, clickCount: 1 }, P.S);
    await sleep(1500);
    const afterRows = await db.select().from(schema.events).where(eq(schema.events.id, evRow.id));
    const movedMin = Math.round((new Date(afterRows[0]!.startsAt).getTime() - new Date(before[0]!.startsAt).getTime()) / 60000);
    lines.push(`拖拽事件: 开始时间位移=${movedMin} 分钟（期望 +30 或 +60）`);
    lines.push(`主流程 JS 异常: ${P.errors.length ? P.errors.join(" | ") : "无"}`);
    await cdp.send("Target.closeTarget", { targetId: P.targetId }).catch(() => undefined);

    // ---- 失败态：toastui 两次加载都失败 → 骨架切错误态 ----
    const F = await open();
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*toastui-calendar.min.js*" }] }, F.S);
    cdp.onEvent((m) => {
      if (m.sessionId !== F.S || m.method !== "Fetch.requestPaused") return;
      void cdp.send("Fetch.failRequest", { requestId: m.params.requestId, errorReason: "Failed" }, F.S).catch(() => undefined);
    });
    await cdp.send("Page.navigate", { url: base + "/app" }, F.S);
    await sleep(4000);
    const failState = await F.ev2(`(function () {
      var err = document.getElementById('calendar-load-error');
      var pulse = document.getElementById('calendar-skeleton-pulse');
      var vis = function (el) { return !!el && !el.classList.contains('hidden') && getComputedStyle(el).display !== 'none'; };
      return { errorVisible: vis(err), pulseVisible: vis(pulse),
               retryText: document.getElementById('calendar-load-retry')?.textContent || '',
               errText: err ? err.querySelector('p')?.textContent || '' : '' };
    })()`);
    lines.push(`加载失败态: 错误框可见=${failState.errorVisible} 脉冲块可见=${failState.pulseVisible} 文案=${failState.errText} 按钮=${failState.retryText}`);
    await F.shot(`interact-loaderror-${TAG}.png`);
    await cdp.send("Target.closeTarget", { targetId: F.targetId }).catch(() => undefined);
    console.log(lines.join("\n"));
  }, 300000);

  it("measures pages before/after the calendar bundle split", async () => {
    if (process.env.BWC_DEBUG === "1") return;
    await resetDb();
    const user = await makeUser("bench@example.com");
    const calA = await makeCalendar(user.id, "工作");
    const calB = await makeCalendar(user.id, "个人");
    // 当前周内撒事件：定时 / 全天 / 跨天 / 重复各来一点，让网格有真实内容。
    const now = new Date();
    const at = (dayOffset: number, h: number, m = 0) => {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, h, m);
      return d;
    };
    let n = 0;
    const add = async (calId: string, summary: string, s: Date, e: Date, extra: Record<string, unknown> = {}) => {
      n += 1;
      await db.insert(schema.events).values({
        calendarId: calId, uid: `bench-${n}@bywave`, summary,
        startsAt: s, endsAt: e, ...extra,
      });
    };
    for (let d = -2; d <= 4; d++) {
      await add(calA.id, `晨会 ${d}`, at(d, 9), at(d, 10));
      await add(calB.id, `专注时间 ${d}`, at(d, 14), at(d, 16, 30));
    }
    await add(calA.id, "产品评审", at(0, 11), at(0, 12, 30), { location: "3F 会议室" });
    await add(calB.id, "健身", at(1, 18), at(1, 19));
    await add(calA.id, "发布日", at(2, 0), at(3, 0), { allDay: true });
    await add(calB.id, "每周同步", at(-1, 10), at(-1, 11), { rrule: "FREQ=WEEKLY" });
    await db.insert(schema.notifications).values([
      { userId: user.id, type: "event_invitation", title: "邀请：季度规划会", body: "张三邀请你参加", url: "/app" },
      { userId: user.id, type: "booking_created", title: "新预约", body: "有人预约了你的时间", url: "/app/booking-links" },
    ]);
    const auth = await loginAs(app, user.id);

    const results: PageResult[] = [];
    const push = (r: PageResult) => { results.push(r); return r; };

    push((await runScenario({
      name: "首页 /（未登录，桌面，冷）", url: "/", width: 1280, height: 800,
      waitFor: "page", finalShot: `landing-${TAG}.png`,
    })).result);
    push((await runScenario({
      name: "下载 /download（未登录，桌面，冷）", url: "/download", width: 1280, height: 800,
      waitFor: "page", finalShot: `download-${TAG}.png`,
    })).result);
    push((await runScenario({
      name: "设置 /app/settings（桌面，冷）", url: "/app/settings", width: 1280, height: 800,
      cookie: auth, waitFor: "page", finalShot: `settings-${TAG}.png`,
    })).result);
    push((await runScenario({
      name: "通知 /app/notifications（桌面，冷）", url: "/app/notifications", width: 1280, height: 800,
      cookie: auth, waitFor: "page", finalShot: `notifications-${TAG}.png`,
    })).result);

    const cold = await runScenario({
      name: "日历 /app（桌面，冷，限速 1.6Mbps）", url: "/app", width: 1280, height: 800,
      cookie: auth, throttle: true, waitFor: "calendar",
      shellShot: `calendar-shell-${TAG}.png`, finalShot: `calendar-desktop-${TAG}.png`,
    });
    push(cold.result);
    push((await runScenario({
      name: "日历 /app（桌面，热缓存，同上下文二访）", url: "/app", width: 1280, height: 800,
      cookie: auth, waitFor: "calendar", reuseContextId: cold.contextId,
    })).result);
    push((await runScenario({
      name: "日历 /app（展开 800，冷）", url: "/app", width: 800, height: 900,
      cookie: auth, waitFor: "calendar", finalShot: `calendar-duo800-${TAG}.png`,
    })).result);
    push((await runScenario({
      name: "日历 /app（手机 390，冷）", url: "/app", width: 390, height: 844, mobile: true,
      cookie: auth, waitFor: "calendar", finalShot: `calendar-mobile390-${TAG}.png`,
    })).result);
    push((await runScenario({
      name: "日历 /app（桌面，深色，冷）", url: "/app", width: 1280, height: 800,
      cookie: auth, dark: true, waitFor: "calendar", finalShot: `calendar-dark-${TAG}.png`,
    })).result);

    const out: string[] = ["", `=== 日历页资源拆分基准（tag=${TAG}）===`];
    out.push("场景".padEnd(38) + "DCL".padStart(7) + "壳".padStart(8) + "网格".padStart(8) + "事件".padStart(8)
      + "CLS".padStart(7) + "总传输".padStart(10) + "toastui".padStart(10) + "请求".padStart(6) + "事件元素".padStart(8));
    for (const r of results) {
      out.push(
        r.name.padEnd(36)
        + `${r.dcl}ms`.padStart(9) + `${r.shell}ms`.padStart(10) + `${r.grid}ms`.padStart(10) + `${r.events}ms`.padStart(10)
        + `${r.cls}`.padStart(7) + `${r.totalKB}KB`.padStart(11) + `${r.toastuiKB}KB`.padStart(11)
        + `${r.requests}`.padStart(6) + `${r.eventEls}`.padStart(8),
      );
      out.push(`  诊断 bootedLive=${r.bootedLive} bodyBg=${r.bodyBg} 网络异常=[${r.netBad.join("; ")}] 文本=${r.pageText.slice(0, 50)}`);
      if (r.shellRects) {
        out.push(`  壳帧位置  toolbar=${JSON.stringify(r.shellRects.toolbar)} sidebar=${JSON.stringify(r.shellRects.sidebar)} calendar=${JSON.stringify(r.shellRects.calendar)}`);
        out.push(`  完成帧位置 toolbar=${JSON.stringify(r.rects.toolbar)} sidebar=${JSON.stringify(r.rects.sidebar)} calendar=${JSON.stringify(r.rects.calendar)}`);
      }
    }
    const nonCal = results.filter((r) => !r.name.startsWith("日历"));
    out.push(`非日历页 toastui 字节合计: ${nonCal.reduce((s, r) => s + r.toastuiKB, 0)}KB（应为 0）`);
    console.log(out.join("\n"));
  }, 600000);
});
