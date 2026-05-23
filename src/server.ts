import path from "node:path";
import type { Server as HttpsServer } from "node:https";
import Fastify, { type FastifyError } from "fastify";
import { httpsOptionsFromEnv, startHttpRedirectServer, watchCertReload } from "./lib/tls.js";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import view from "@fastify/view";
import formbody from "@fastify/formbody";
import fastifyStatic from "@fastify/static";
import ejs from "ejs";
import { env } from "./env.js";
import { authRoutes } from "./routes/auth.js";
import { calendarRoutes } from "./routes/calendars.js";
import { eventRoutes } from "./routes/events.js";
import { searchRoutes } from "./routes/search.js";
import { deviceRoutes } from "./routes/devices.js";
import { pushRoutes } from "./routes/push.js";
import { oauthServerRoutes } from "./web/oauth_server.js";
import { icsRoutes } from "./routes/ics.js";
import { webRoutes } from "./web/index.js";
import { webauthnRoutes } from "./web/webauthn.js";
import { mfaRoutes } from "./web/mfa.js";
import { adminRoutes } from "./web/admin.js";
import { ssoRoutes } from "./web/sso.js";
import { caldavRoutes } from "./web/caldav.js";
import { getSettings } from "./lib/site_settings.js";
import { startSubscriptionScheduler } from "./lib/ics_import.js";
import { startReminderScheduler } from "./lib/reminders.js";
import { startHousekeepingScheduler } from "./lib/housekeeping.js";
import { logApnsStartup } from "./lib/apns.js";
import { readThemeFromRequest } from "./lib/user_theme.js";
import { listEnabledProvidersPublic } from "./lib/sso_providers.js";
import { csrfTokenFor } from "./lib/csrf.js";
import { loadUserFromRequest } from "./lib/session.js";

const projectRoot = process.cwd();

const httpsOptions = env.USE_HTTPS ? httpsOptionsFromEnv() : undefined;

const app = Fastify({
  logger: env.NODE_ENV === "development"
    ? { transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss.l", ignore: "pid,hostname" } } }
    : true,
  trustProxy: true,
  bodyLimit: 2 * 1024 * 1024, // 2 MB (CalDAV PUTs can be larger than typical APIs)
  ...(httpsOptions ? { https: httpsOptions } : {}),
});

// Custom HTTP methods used by WebDAV / CalDAV
app.addHttpMethod("PROPFIND", { hasBody: true });
app.addHttpMethod("REPORT", { hasBody: true });
app.addHttpMethod("MKCALENDAR", { hasBody: true });
app.addHttpMethod("PROPPATCH", { hasBody: true });

// CalDAV bodies are XML or iCalendar text — pass through as strings.
// Use regex so we catch iOS variants like:
//   "text/calendar; charset=utf-8"
//   'text/calendar; charset="utf-8"; component=VEVENT'
//   "application/xml; charset=utf-8"
app.addContentTypeParser(
  /^(application\/xml|text\/xml|text\/calendar)\b/i,
  { parseAs: "string" },
  (_req, body, done) => done(null, body),
);

// Browser CSP-report content types. Modern Chrome/Firefox send
// "application/csp-report"; new spec uses "application/reports+json"
// (an array of reports). Parse both as lenient JSON so /csp-report
// can log them.
app.addContentTypeParser(
  /^application\/(csp-report|reports\+json)\b/i,
  { parseAs: "string" },
  (_req, body, done) => {
    const s = String(body || "").trim();
    if (!s) return done(null, null);
    try { done(null, JSON.parse(s)); } catch { done(null, s); }
  },
);

// Fastify's default JSON parser throws 400 on empty bodies even for DELETE /
// PATCH requests where Content-Type is technically set but no body is sent.
// Override to treat empty string as null so DELETE /api/events/:id never
// regresses to the "删除失败 (HTTP 400)" failure mode.
app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
  const s = String(body || "").trim();
  if (s.length === 0) return done(null, null);
  try {
    done(null, JSON.parse(s));
  } catch (err) {
    done(err instanceof Error ? err : new Error(String(err)));
  }
});

// ---- CSP nonce ----
// Per-request random nonce attached to every inline <script>. Lets us drop
// 'unsafe-inline' from script-src while still serving the bootstrap scripts
// we render with EJS. Stored on `req.raw.cspNonce` (the raw Node request)
// because @fastify/helmet's CSP directive functions receive `req.raw`, not
// the Fastify request object — and we want both helmet and the view-locals
// injector to read the same value.
import { randomBytes } from "node:crypto";
app.addHook("onRequest", async (req) => {
  (req.raw as unknown as { cspNonce: string }).cspNonce = randomBytes(16).toString("base64");
});

// ---- Security headers ----
await app.register(helmet, {
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      // All third-party libs are self-hosted (国内 CDN 不稳定).
      // No 'unsafe-inline' in script-src — inline <script> tags must carry the
      // per-request nonce that the EJS layout templates inject as nonce="…".
      "script-src": ["'self'", (req: unknown, _res: unknown) => `'nonce-${(req as { cspNonce: string }).cspNonce}'`],
      // Inline event handlers (onclick / onsubmit) on existing templates;
      // refactoring 27 of them is its own batch.
      "script-src-attr": ["'unsafe-inline'"],
      // Tailwind utilities + style="background: ..." color swatches need this.
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "data:"],
      "connect-src": ["'self'"],
      "font-src": ["'self'", "data:"],
      "frame-ancestors": ["'none'"],
      "base-uri": ["'self'"],
      "form-action": ["'self'"],
      "object-src": ["'none'"],
      "upgrade-insecure-requests": env.NODE_ENV === "production" ? [] : null,
      // CSP violation reporting — browsers POST to /csp-report when they
      // block something. Without this we had zero visibility into "is
      // CSP eating legit JS in some user's browser?". report-uri is the
      // legacy directive; report-to (the new spec) plus the
      // Report-To header would be ideal but isn't widely supported yet,
      // so we stick with report-uri for now.
      "report-uri": ["/csp-report"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "same-origin" },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  hsts: env.NODE_ENV === "production" ? { maxAge: 31_536_000, includeSubDomains: true, preload: false } : false,
});

// ---- Global rate limit ----
await app.register(rateLimit, {
  global: true,
  max: env.RATE_LIMIT_GLOBAL_PER_MINUTE,
  timeWindow: "1 minute",
  hook: "preHandler",
  keyGenerator: (req) => req.ip,
  errorResponseBuilder: (_req, ctx) => ({
    statusCode: 429,
    error: "too_many_requests",
    message: `请求过于频繁，请 ${Math.ceil(ctx.ttl / 1000)} 秒后再试`,
  }),
});

// ---- Cookies / forms / CORS ----
await app.register(cookie, { secret: env.SESSION_SECRET });
await app.register(formbody);
await app.register(multipart, {
  limits: {
    fileSize: 2 * 1024 * 1024,
    files: 1,
    fields: 5,
  },
});
await app.register(cors, {
  origin: env.NODE_ENV === "development" ? true : env.PUBLIC_BASE_URL,
  credentials: true,
  // Disable browser CORS preflight handling so plain OPTIONS (CalDAV)
  // reaches our handler with proper DAV: headers. Our app is same-origin,
  // so we never actually need preflight from a browser.
  preflight: false,
  strictPreflight: false,
});

// ---- Static assets ----
await app.register(fastifyStatic, {
  root: path.join(projectRoot, "src", "public"),
  prefix: "/static/",
  cacheControl: true,
  maxAge: env.NODE_ENV === "production" ? "7d" : 0,
});

// ---- Views (EJS) ----
await app.register(view, {
  engine: { ejs },
  root: path.join(projectRoot, "src", "views"),
  defaultContext: {
    env: env.NODE_ENV,
    icpNumber: env.ICP_NUMBER,
    icpUrl: env.ICP_URL,
    siteName: env.SITE_NAME,
    siteLogoUrl: null,
  },
  layout: "layout.ejs",
  propertyName: "view",
  options: { async: false },
});

// ---- Health ----
app.get("/health", { config: { rateLimit: false } }, async () => ({ status: "ok", version: "0.9.1" }));

// Public diagnostic endpoint for APP onboarding troubleshooting. The
// iOS / Android APP can ping this BEFORE the user attempts to log in
// and show a proactive banner if the admin has disabled APP sync. Also
// useful for admins debugging "why does my phone say 403?" — they can
// just open https://server/api/v1/health/app in any browser and see
// exactly what the running server thinks.
//
// We deliberately keep this anonymous (no auth) because:
//   - it only exposes booleans the admin already controls,
//   - the same info is visible to anyone who tries to log in (they get
//     a 403 with the same error code anyway),
//   - it's the only way an unsigned-in client can self-diagnose.
app.get("/api/v1/health/app", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async () => {
  // Lazy import to avoid pulling getSettings into the eager init path.
  const { getSettings } = await import("./lib/site_settings.js");
  const s = await getSettings();
  // Theme palette → hex accent. Mirrors web's tailwind brand-600 values.
  // iOS reads `themeAccent` on launch and applies it as the global .tint
  // so server-controlled branding flows through to the native APP without
  // a separate config endpoint.
  const accentByPalette: Record<string, string> = {
    indigo: "#4F46E5",
    emerald: "#059669",
    rose: "#E11D48",
    sky: "#0284C7",
    amber: "#D97706",
    violet: "#7C3AED",
  };
  return {
    version: "0.9.1",
    appsEnabled: s.appsEnabled,
    siteName: s.siteName,
    themePalette: s.themePalette,
    themeAccent: accentByPalette[s.themePalette] ?? accentByPalette.indigo,
    serverTime: new Date().toISOString(),
  };
});

// CSP violation report sink. Browsers POST a small JSON document here
// when something gets blocked by the Content-Security-Policy directives
// above. We log it server-side via pino so admins notice via their normal
// log pipeline; no DB write because the volume can spike (one CSP
// breakage = N reports per page load × M users) and we don't want to
// thrash PG. Body parsing accepts both legacy "application/csp-report"
// and the newer "application/reports+json" content-types.
app.post("/csp-report", {
  config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  // Skip CSRF: this endpoint is hit by the browser itself with no cookies
  // (CSP reports are sent with credentials omitted by spec). Adding it to
  // the CSRF skip list rather than the global hook check.
}, async (req, reply) => {
  try {
    const body = req.body as unknown as { "csp-report"?: Record<string, unknown> } | Record<string, unknown> | Array<Record<string, unknown>>;
    // Legacy single-event shape: { "csp-report": {...} }. New shape: { type, body, url, ... }
    // OR an array of those. Just log the whole thing; we're not parsing the
    // structure further (admin can grep pino logs if a real violation shows up).
    req.log.warn({ cspReport: body, ua: req.headers["user-agent"] }, "csp_violation");
  } catch (e) {
    req.log.warn({ err: e }, "csp_violation_parse_failed");
  }
  // 204 = "I got it, don't retry". Browsers don't read the body anyway.
  return reply.code(204).send();
});
// Also accept the OPTIONS preflight some browsers send before the report.
app.options("/csp-report", { config: { rateLimit: false } }, async (_req, reply) => reply.code(204).send());

// PWA rescue page. If a user's mobile browser has a stale service worker
// from a previous crash window (cached 502 / wrong content-type / etc),
// they can visit /reset-pwa to force-unregister every SW + dump every
// cache and bounce back to the home page. We made this its own minimal
// HTML page (no layout, no JS framework) so it works even when the rest
// of the app is broken on their device.
app.get("/reset-pwa", { config: { rateLimit: false } }, async (req, reply) => {
  reply.header("Cache-Control", "no-store");
  reply.type("text/html; charset=utf-8");
  // Inline script needs the per-request CSP nonce, otherwise helmet's
  // strict script-src 'self' 'nonce-X' silently blocks it and the page
  // sits forever on "正在清理…" while the user wonders what's wrong.
  // Also pin a relaxed CSP on this route so even if the nonce wiring
  // ever breaks again, the rescue page itself still works — this page
  // is server-generated only and exists specifically to recover the
  // app, so 'unsafe-inline' here is a deliberate trade-off.
  const nonce = (req.raw as unknown as { cspNonce?: string }).cspNonce ?? "";
  reply.header("Content-Security-Policy",
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; " +
    "connect-src 'self'; " +
    "frame-ancestors 'self'");
  return reply.send(`<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>清理 PWA 缓存</title>
<style>
  body { font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 420px; margin: 0 auto; padding: 24px; color: #0f172a; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { color: #475569; }
  #status { margin-top: 24px; padding: 16px; border-radius: 12px; background: #f1f5f9; font-size: 14px; }
  #status.done { background: #ecfdf5; color: #065f46; }
  #status.err { background: #fef2f2; color: #991b1b; }
  a.btn { display: block; margin-top: 16px; padding: 12px; text-align: center; background: #4f46e5; color: #fff; border-radius: 12px; text-decoration: none; font-weight: 500; }
</style>
</head><body>
<h1>🧹 清理 PWA 缓存</h1>
<p>如果你的手机访问网站时一直触发下载或显示旧页面，这个页面会注销缓存的 service worker、清空本地缓存，然后让你重新打开正常的网站。</p>
<div id="status">正在清理…</div>
<a class="btn" href="/">完成后返回首页</a>
<script nonce="${nonce}">
(async function(){
  const s = document.getElementById("status");
  const log = [];
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) { await r.unregister(); log.push("已注销 SW: " + (r.scope || "(无 scope)")); }
      if (regs.length === 0) log.push("没有注册过 service worker");
    }
    if ("caches" in window) {
      const keys = await caches.keys();
      for (const k of keys) { await caches.delete(k); log.push("已删缓存: " + k); }
      if (keys.length === 0) log.push("没有任何缓存条目");
    }
    try { localStorage.clear(); log.push("已清 localStorage"); } catch (e) {}
    try { sessionStorage.clear(); log.push("已清 sessionStorage"); } catch (e) {}
    s.className = "done";
    s.innerHTML = "<strong>✓ 清理完成</strong><br>" + log.join("<br>") + "<br><br>现在点下面的按钮回首页应该就正常了。如果还有问题，<strong>彻底关掉浏览器</strong>再打开。";
  } catch (e) {
    s.className = "err";
    s.textContent = "出错了：" + (e && e.message ? e.message : e);
  }
})();
</script>
</body></html>`);
});

// ---- Asset version (boot timestamp) — busts browser & SW cache on every deploy ----
const ASSET_VERSION = String(Date.now());
// In production we serve mangled/minified JS from src/public/_built/* so the
// readable source isn't exposed to browsers. The dir is generated by
// scripts/minify-public-js.mjs during `npm run build` when NODE_ENV=production.
const JS_BASE_PATH = env.NODE_ENV === "production" ? "/static/_built" : "/static";

// ---- PWA: serve manifest & sw at root ----
// Generated rather than served as a static file so the install name
// reflects the admin's site_settings.siteName. iOS / Android home-screen
// installs read `short_name` (and "name" as fallback) — without this
// every install shows "ByWave-Calendar" no matter how the admin
// branded the site.
app.get("/manifest.webmanifest", { config: { rateLimit: false } }, async (_req, reply) => {
  const settings = await getSettings();
  const siteName = (settings.siteName || "ByWave-Calendar").trim() || "ByWave-Calendar";
  // short_name should fit in the 12-char home-screen label budget. We
  // truncate at 12 visible chars (Chinese chars count as 1 each, which
  // is what iOS actually measures).
  const shortName = siteName.length > 12 ? siteName.slice(0, 12) : siteName;
  const manifest = {
    id: "/app",
    name: siteName,
    short_name: shortName,
    description: "日历共享平台 — 多日历协作、订阅链接、Passkey 登录、双向同步",
    start_url: "/app",
    scope: "/",
    display: "standalone",
    display_override: ["window-controls-overlay", "standalone", "minimal-ui", "browser"],
    orientation: "any",
    background_color: "#f8fafc",
    theme_color: "#4f46e5",
    lang: "zh-CN",
    categories: ["productivity", "utilities"],
    prefer_related_applications: false,
    icons: [
      { src: settings.logoUrl || "/static/favicon.svg", sizes: "any", type: settings.logoUrl ? "image/png" : "image/svg+xml", purpose: "any" },
      { src: "/static/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/static/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/static/icons/icon-192-maskable.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/static/icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "我的日历", url: "/app", icons: [{ src: "/static/favicon.svg", sizes: "any" }] },
      { name: "新建事件", url: "/app#new-event", icons: [{ src: "/static/favicon.svg", sizes: "any" }] },
    ],
  };
  reply.header("Content-Type", "application/manifest+json");
  // Short cache — site name doesn't change minute-by-minute but we
  // want admin renames to land on next refresh, not 24h later.
  reply.header("Cache-Control", "public, max-age=300");
  return reply.send(manifest);
});
app.get("/sw.js", { config: { rateLimit: false } }, async (_req, reply) => {
  reply.header("Service-Worker-Allowed", "/");
  reply.header("Content-Type", "application/javascript");
  reply.header("Cache-Control", "no-cache, must-revalidate");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  // Prefer the minified copy in production; fall back to source if not yet built.
  const minPath = path.join(process.cwd(), "src", "public", "_built", "sw.js");
  const srcPath = path.join(process.cwd(), "src", "public", "sw.js");
  let body: string;
  try {
    body = await fs.readFile(env.NODE_ENV === "production" ? minPath : srcPath, "utf8");
  } catch {
    body = await fs.readFile(srcPath, "utf8");
  }
  // Inline ASSET_VERSION so each deploy gets a new cache bucket and old ones evict.
  return reply.send(body.replace(/__ASSET_VERSION__/g, ASSET_VERSION));
});

// Used by the client to detect when its in-memory page is older than the live deploy.
app.get("/api/version", { config: { rateLimit: false } }, async (_req, reply) => {
  reply.header("Cache-Control", "no-store");
  return reply.send({ version: ASSET_VERSION });
});

// ---- Routes ----
// Each route plugin uses paths relative to the API prefix (e.g.
// "/events" rather than "/api/events"). We mount the same plugin twice:
//   /api/*    — legacy. Bare JSON payloads, kept for backwards compat
//               with the in-app JS client and existing API-token users.
//   /api/v1/* — current. The onSend hook below wraps responses in a
//               uniform envelope { ok: true, data } / { ok: false, error }
//               and surfaces machine-readable error codes.
for (const prefix of ["/api", "/api/v1"]) {
  await app.register(authRoutes, { prefix });
  await app.register(calendarRoutes, { prefix });
  await app.register(eventRoutes, { prefix });
  await app.register(searchRoutes, { prefix });
  await app.register(deviceRoutes, { prefix });
  await app.register(pushRoutes, { prefix });
}
await app.register(icsRoutes);
await app.register(oauthServerRoutes);

// Envelope wrapping for /api/v1/* responses. Routes that already used
// ok()/err() ship a pre-wrapped body (with an "ok" property at the top)
// which we detect and pass through unchanged. Everything else (legacy
// reply.send() calls reused from /api/*) gets transparently wrapped.
app.addHook("onSend", async (req, reply, payload) => {
  if (!req.url?.startsWith("/api/v1")) return payload;
  const contentType = reply.getHeader("content-type");
  if (typeof contentType !== "string" || !contentType.includes("json")) return payload;
  if (typeof payload !== "string") return payload;  // streamed / Buffer
  let parsed: unknown;
  try { parsed = JSON.parse(payload); } catch { return payload; }
  // Already wrapped by an ok()/err() helper — pass through.
  if (parsed && typeof parsed === "object" && "ok" in (parsed as object)) return payload;
  const sc = reply.statusCode;
  if (sc >= 200 && sc < 300) {
    return JSON.stringify({ ok: true, data: parsed });
  }
  // Error: try to extract a code/message from the legacy { error: "..." } shape.
  let code = "error";
  let message = "";
  if (parsed && typeof parsed === "object") {
    const p = parsed as { error?: unknown; message?: unknown };
    if (typeof p.error === "string") code = p.error;
    if (typeof p.message === "string") message = p.message;
  }
  return JSON.stringify({ ok: false, error: { code, message: message || code } });
});

// Minimal OpenAPI 3 description of /api/v1/*. Hand-written for now —
// when the API stabilizes we can move to auto-generation from the Zod
// schemas. Useful for n8n / Zapier / API client generators.
app.get("/api/v1/openapi.json", { config: { rateLimit: false } }, async (_req, reply) => {
  reply.header("Content-Type", "application/json; charset=utf-8");
  return reply.send({
    openapi: "3.1.0",
    info: {
      title: "ByWave Calendar API",
      version: "1.0.0",
      description: "Standardized REST API. All responses wrap in { ok, data } / { ok: false, error }.",
    },
    servers: [{ url: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/api/v1` }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "API token from /admin/api" },
        cookieAuth: { type: "apiKey", in: "cookie", name: "bwc_sid", description: "Browser session" },
      },
      schemas: {
        Envelope: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            data: { description: "Present on success" },
            error: {
              type: "object",
              properties: {
                code: { type: "string", example: "weak_password" },
                message: { type: "string", example: "密码至少 10 位" },
              },
            },
            meta: { type: "object" },
          },
          required: ["ok"],
        },
      },
    },
    security: [{ bearerAuth: [] }, { cookieAuth: [] }],
    paths: {
      "/auth/register": { post: { summary: "Create account", responses: { "200": { description: "Created" }, "400": { description: "Weak password" }, "409": { description: "Email already registered" } } } },
      "/auth/login": { post: { summary: "Log in", responses: { "200": { description: "Logged in" }, "401": { description: "Bad credentials" } } } },
      "/auth/logout": { post: { summary: "Log out" } },
      "/auth/me": { get: { summary: "Current user" } },
      "/calendars": {
        get: { summary: "List my calendars" },
        post: { summary: "Create calendar" },
      },
      "/calendars/{id}": {
        patch: { summary: "Update calendar" },
        delete: { summary: "Delete calendar" },
      },
      "/calendars/{id}/events": { get: { summary: "List events in one calendar" } },
      "/calendars/{id}/share-tokens": {
        get: { summary: "List ICS share tokens" },
        post: { summary: "Create ICS share token" },
      },
      "/calendars/{id}/share-tokens/{token}": {
        delete: { summary: "Revoke ICS share token" },
      },
      "/events": {
        get: { summary: "List events across visible calendars in a date range (expands RRULE)" },
        post: { summary: "Create event" },
      },
      "/events/{id}": {
        patch: { summary: "Update event" },
        delete: { summary: "Soft-delete event + fire CANCEL emails" },
      },
      "/events/conflicts": { post: { summary: "Check for overlapping events" } },
      "/search": { get: { summary: "Search events", parameters: [{ name: "q", in: "query", required: true, schema: { type: "string" } }] } },
      "/push/public-key": { get: { summary: "VAPID public key for browser PushManager" } },
      "/push/subscribe": { post: { summary: "Register a push subscription" } },
      "/push/unsubscribe": { post: { summary: "Remove a push subscription" } },
    },
  });
});

// ---- API security: CSRF for state-changing /api/* under session-cookie auth ----
// SameSite=Lax already blocks cross-site cookie attachment on POST, but
// defense-in-depth: require an X-CSRF-Token header (HMAC-bound to the
// session) on every mutating /api/* request that's NOT using a Bearer
// API token. Bearer auth lives in the Authorization header which the
// browser can't auto-attach cross-origin, so CSRF doesn't apply there.
//
// Anonymous bootstrap routes (/auth/login, /auth/register) are exempt
// because there's no session to protect yet.
const CSRF_EXEMPT_PATHS = new Set([
  "/api/auth/login", "/api/v1/auth/login",
  "/api/auth/register", "/api/v1/auth/register",
  // Native APP bootstrap endpoints — anonymous, NOT cookie-bound. The
  // one-time pair code / email+password / refresh token IS the auth.
  // CSRF only protects session cookies that browsers auto-attach
  // cross-site; these endpoints don't use cookies at all, so the
  // attack model doesn't apply. Without these exemptions iOS / Android
  // / desktop APP login returns a confusing 403 even when admin's
  // appsEnabled toggle is on — the real reason got swallowed by the
  // global preHandler before reaching the route. (Same logic as
  // /api/auth/login above.)
  "/api/v1/devices/pair-claim",
  "/api/v1/auth/login-password",
  "/api/v1/auth/refresh",
  // CSP violation reports are POSTed by the browser itself with no
  // cookies (per spec credentials are omitted). No session = no CSRF
  // surface; the endpoint just logs the report and returns 204.
  "/csp-report",
]);
app.addHook("preHandler", async (req, reply) => {
  if (!req.url.startsWith("/api/")) return;
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
  // Strip query string for the exempt match.
  const path = req.url.split("?")[0] || "";
  if (CSRF_EXEMPT_PATHS.has(path)) return;
  // Bearer token: header-only, browsers can't auto-attach. Skip.
  const auth = String(req.headers.authorization || "");
  if (auth.toLowerCase().startsWith("bearer ")) return;
  // Session-cookie path: must carry CSRF. verifyCsrf sends the 403 itself.
  const { verifyCsrf } = await import("./lib/csrf.js");
  verifyCsrf(req, reply);
});

// Enforce read-scope on API-token writes. Sits on /api/* mutating verbs only;
// session-cookie callers are unaffected because they have no `authVia` tag.
app.addHook("preHandler", async (req, reply) => {
  if (!req.url.startsWith("/api/")) return;
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
  const tag = (req as unknown as { authVia?: string }).authVia;
  if (tag === "api_token:read") {
    reply.code(403).send({ error: "token_is_read_only" });
  }
});
// Inject DB-backed site settings into every reply.view call.
app.addHook("onRequest", async (req, reply) => {
  const settings = await getSettings();
  const userTheme = readThemeFromRequest(req);
  // Pre-resolve current user so the synchronous view override can read it
  // without re-querying or going async per template render.
  const currentUser = await loadUserFromRequest(req).catch(() => null);
  const ssoProviders = await listEnabledProvidersPublic().catch(() => []);
  const original = reply.view.bind(reply);
  (reply as unknown as { view: (n: string, l?: object) => unknown }).view = (name: string, locals: object = {}) =>
    original(name, {
      assetVersion: ASSET_VERSION,
      siteName: settings.siteName,
      siteLogoUrl: settings.logoUrl,
      icpNumber: settings.icpNumber,
      icpUrl: settings.icpUrl,
      registrationOpen: settings.registrationMode !== "closed",
      registrationMode: settings.registrationMode,
      ssoEnabled: ssoProviders.length > 0,
      ssoLabel: settings.ssoKeycloakLabel,
      ssoProviders,
      sitePalette: settings.themePalette,
      siteDensity: settings.themeDensity,
      themePalette: userTheme.palette ?? settings.themePalette,
      themeDensity: userTheme.density ?? settings.themeDensity,
      currentUser,
      jsBasePath: JS_BASE_PATH,
      cspNonce: (req.raw as unknown as { cspNonce: string }).cspNonce,
      ...locals,
    });
});

await app.register(webRoutes);
await app.register(webauthnRoutes);
await app.register(mfaRoutes);
await app.register(adminRoutes);
await app.register(ssoRoutes);
await app.register(caldavRoutes);

// ---- Error handler ----
app.setErrorHandler(async (err: FastifyError, req, reply) => {
  if (err.message === "unauthorized") return;
  if (err.validation) return reply.code(400).send({ error: "validation_failed", details: err.validation });
  if (err.statusCode === 429) {
    return reply.code(429).send({ error: "too_many_requests", message: err.message });
  }
  // Always log full error server-side; never reach the user.
  req.log.error({ err }, "request_failed");
  const accept = req.headers.accept ?? "";
  if (accept.includes("text/html")) {
    const user = await loadUserFromRequest(req).catch(() => null);
    return reply.code(err.statusCode ?? 500).view("error", {
      title: "出错了",
      user,
      csrfToken: csrfTokenFor(req),
      flash: {},
      statusCode: err.statusCode ?? 500,
      heading: "出错了",
      message: env.NODE_ENV === "production" ? "服务器内部错误" : (err.message ?? "internal_error"),
    });
  }
  // JSON path: in production NEVER leak err.message — could contain SQL
  // statements, file paths, stack hints, internal IPs from PG error
  // descriptions, etc. In dev surface the message so debugging is easy.
  // 5xx specifically: always sanitize. 4xx with status set: surface the
  // (developer-defined) message which is already safe.
  const status = err.statusCode ?? 500;
  if (status >= 500) {
    return reply.code(status).send({
      error: "internal_error",
      message: env.NODE_ENV === "production" ? "服务器内部错误" : (err.message ?? "internal_error"),
    });
  }
  return reply.code(status).send({ error: err.message ?? "internal_error" });
});

// ---- 404 ----
app.setNotFoundHandler(async (req, reply) => {
  const accept = req.headers.accept ?? "";
  if (accept.includes("text/html")) {
    const user = await loadUserFromRequest(req).catch(() => null);
    return reply.code(404).view("error", {
      title: "未找到",
      user,
      csrfToken: csrfTokenFor(req),
      flash: {},
      statusCode: 404,
      heading: "页面未找到",
      message: "你访问的内容不存在或已被移除。",
    });
  }
  return reply.code(404).send({ error: "not_found" });
});

startSubscriptionScheduler({
  info: (m) => app.log.info(m),
  warn: (m) => app.log.warn(m),
});

startReminderScheduler({
  info: (m) => app.log.info(m),
  warn: (m) => app.log.warn(m),
});

startHousekeepingScheduler({
  info: (m) => app.log.info(m),
  warn: (m) => app.log.warn(m),
});

logApnsStartup({ info: (m) => app.log.info(m) });

// Surface critical APP-related toggles at startup. If apps_enabled is
// off, the iOS / Android APP will see 403 on every auth call — this
// log is the canonical place to verify before going hunting in admin.
{
  const { getSettings } = await import("./lib/site_settings.js");
  const s = await getSettings();
  app.log.info({ appsEnabled: s.appsEnabled, apiEnabled: s.apiEnabled, embedEnabled: s.embedEnabled }, `[startup] feature toggles — appsEnabled=${s.appsEnabled}`);
  if (!s.appsEnabled) {
    app.log.warn("[startup] appsEnabled=false — 原生 APP 登录会被拒绝 (HTTP 403 apps_disabled). 在 /admin/api#apps 打开开关。");
  }
}

try {
  if (env.USE_HTTPS) {
    await app.listen({ host: "0.0.0.0", port: env.HTTPS_PORT });
    watchCertReload(app.server as HttpsServer, (msg, err) => {
      if (err) app.log.error({ err }, msg);
      else app.log.info(msg);
    });
    startHttpRedirectServer((msg) => app.log.info(msg));
  } else {
    await app.listen({ host: env.HOST, port: env.PORT });
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
