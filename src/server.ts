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
import { caldavRoutes } from "./web/caldav.js";
import { getSettings } from "./lib/site_settings.js";
import { startSubscriptionScheduler } from "./lib/ics_import.js";
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
app.addContentTypeParser(
  ["application/xml", "text/xml", "text/calendar", "text/calendar; charset=utf-8"],
  { parseAs: "string" },
  (_req, body, done) => done(null, body),
);

// ---- Security headers ----
await app.register(helmet, {
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      // All third-party libs are self-hosted (国内 CDN 不稳定).
      // 'unsafe-inline' kept for the small inline scripts (CSRF/Toast/SW reg + JSON ctx).
      // Future hardening: move all inline scripts out and switch to nonce-based.
      "script-src": ["'self'", "'unsafe-inline'"],
      "script-src-attr": ["'unsafe-inline'"],
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

// ---- PWA: serve manifest & sw at root ----
app.get("/manifest.webmanifest", { config: { rateLimit: false } }, async (_req, reply) => {
  reply.header("Content-Type", "application/manifest+json");
  return reply.sendFile("manifest.webmanifest");
});
app.get("/sw.js", { config: { rateLimit: false } }, async (_req, reply) => {
  reply.header("Service-Worker-Allowed", "/");
  reply.header("Content-Type", "application/javascript");
  return reply.sendFile("sw.js");
});

// ---- Routes ----
await app.register(authRoutes);
await app.register(calendarRoutes);
await app.register(eventRoutes);
await app.register(icsRoutes);
// Inject DB-backed site settings into every reply.view call.
app.addHook("onRequest", async (_req, reply) => {
  const settings = await getSettings();
  const original = reply.view.bind(reply);
  (reply as unknown as { view: (n: string, l?: object) => unknown }).view = (name: string, locals: object = {}) =>
    original(name, {
      siteName: settings.siteName,
      siteLogoUrl: settings.logoUrl,
      icpNumber: settings.icpNumber,
      icpUrl: settings.icpUrl,
      registrationOpen: settings.registrationMode !== "closed",
      registrationMode: settings.registrationMode,
      ssoEnabled: settings.ssoKeycloakEnabled,
      ssoLabel: settings.ssoKeycloakLabel,
      ...locals,
    });
});

await app.register(webRoutes);
await app.register(webauthnRoutes);
await app.register(mfaRoutes);
await app.register(adminRoutes);
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
