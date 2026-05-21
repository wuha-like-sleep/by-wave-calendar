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
// we render with EJS. Stored on `req.cspNonce` so the view-locals injector
// can pass it down to templates.
import { randomBytes } from "node:crypto";
app.addHook("onRequest", async (req) => {
  (req as unknown as { cspNonce: string }).cspNonce = randomBytes(16).toString("base64");
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
app.get("/health", { config: { rateLimit: false } }, async () => ({ status: "ok", version: "0.1.0" }));

// ---- Asset version (boot timestamp) — busts browser & SW cache on every deploy ----
const ASSET_VERSION = String(Date.now());
// In production we serve mangled/minified JS from src/public/_built/* so the
// readable source isn't exposed to browsers. The dir is generated by
// scripts/minify-public-js.mjs during `npm run build` when NODE_ENV=production.
const JS_BASE_PATH = env.NODE_ENV === "production" ? "/static/_built" : "/static";

// ---- PWA: serve manifest & sw at root ----
app.get("/manifest.webmanifest", { config: { rateLimit: false } }, async (_req, reply) => {
  reply.header("Content-Type", "application/manifest+json");
  return reply.sendFile("manifest.webmanifest");
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
await app.register(authRoutes);
await app.register(calendarRoutes);
await app.register(eventRoutes);
await app.register(icsRoutes);

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
      cspNonce: (req as unknown as { cspNonce: string }).cspNonce,
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
  return reply.code(err.statusCode ?? 500).send({ error: err.message ?? "internal_error" });
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
