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
import { pushRoutes } from "./routes/push.js";
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
  await app.register(pushRoutes, { prefix });
}
await app.register(icsRoutes);

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
