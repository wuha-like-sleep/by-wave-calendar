// /api/* 的 CSRF 闸门。
//
// ── 为什么单独成一个文件 ────────────────────────────────────────────────
//
// 这段原来直接写在 server.ts 顶层，于是**没有任何测试能装上它**：集成测试
// 都是自己拼实例、只注册被测的那几个路由，钩子根本不在。后果是真的发生过——
// 两条匿名引导路由（第二步 MFA 校验、原生 Apple 登录）没进豁免名单，
// 三个 App 上凡是开了两步验证的人**一个都登不进来**，线上实测 403 csrf_invalid，
// 而整套测试全绿。搬出来之后 test/integration/api_csrf_exempt.int.test.ts
// 能把真实钩子装到真实路由上打一遍。
//
// ── 判据 ──────────────────────────────────────────────────────────────
// SameSite=Lax 已经挡住了跨站带 cookie 的 POST，这一层是纵深防御：
// 用会话 cookie 的写请求必须另外带 X-CSRF-Token。
// 两类请求不适用，因为它们压根不靠 cookie：
//   · Bearer token —— 在 Authorization 头里，浏览器不会跨站自动带上；
//   · 匿名引导接口 —— 还没有会话可保护，凭据是请求体里那个一次性的东西
//     （密码、配对码、上一步发的 mfaToken、Apple 的 identityToken）。
//
// **往这个名单里加东西之前先问一句：这条路真的不读 cookie 吗？**
// 读 cookie 的路加进来就是真把 CSRF 关掉了。

import type { FastifyInstance } from "fastify";

// ---- API security: CSRF for state-changing /api/* under session-cookie auth ----
// SameSite=Lax already blocks cross-site cookie attachment on POST, but
// defense-in-depth: require an X-CSRF-Token header (HMAC-bound to the
// session) on every mutating /api/* request that's NOT using a Bearer
// API token. Bearer auth lives in the Authorization header which the
// browser can't auto-attach cross-origin, so CSRF doesn't apply there.
//
// Anonymous bootstrap routes (/auth/login, /auth/register) are exempt
// because there's no session to protect yet.
export const API_CSRF_EXEMPT_PATHS = new Set([
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
  // 第二步的 MFA 校验。**这条漏了很久**：手机上开了两步验证的人，
  // 第一步拿到 mfaToken，第二步这一下永远 403，于是**在三个 App 上一个都登不进来**。
  // 它和 /auth/login-password 是同一件事的两半，凭据是上一步发的 mfaToken，
  // 不是 cookie；漏掉一半等于把开了两步验证的用户全挡在门外。
  "/api/auth/login-mfa-verify", "/api/v1/auth/login-mfa-verify",
  // 原生「通过 Apple 登录」：凭据是 Apple 签发的 identityToken，同样不是 cookie。
  "/api/auth/apple", "/api/v1/auth/apple",
  "/api/v1/devices/pair-claim",
  "/api/v1/auth/login-password",
  "/api/v1/auth/refresh",
  // Desktop scan-login pair flow — first call is anonymous (the
  // desktop has no account yet, the QR code IS the proof of
  // authorization once the phone scans + approves). Status polling
  // is GET so it's already exempt; approve is POST but goes via
  // Bearer (matched by the Bearer check below), so only init needs
  // an explicit entry here.
  "/api/v1/devices/desktop-pair-init",
  // Web scan-login (browser-side QR): same logic as desktop-pair-init.
  // The browser calling /web-pair-init is anonymous (no cookie session
  // yet) — the random code IS the proof once the phone approves. CSRF
  // protects session cookies; there's no session here to protect.
  // (web-pair-status is GET so already exempt; web-pair-approve takes
  // Bearer from the phone APP and matches the bearer-bypass below.)
  "/api/v1/devices/web-pair-init",
  // CSP violation reports are POSTed by the browser itself with no
  // cookies (per spec credentials are omitted). No session = no CSRF
  // surface; the endpoint just logs the report and returns 204.
  "/csp-report",
]);
export function registerApiCsrf(app: FastifyInstance): void {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
    // Strip query string for the exempt match.
    const path = req.url.split("?")[0] || "";
    if (API_CSRF_EXEMPT_PATHS.has(path)) return;
    // Bearer token: header-only, browsers can't auto-attach. Skip.
    const auth = String(req.headers.authorization || "");
    if (auth.toLowerCase().startsWith("bearer ")) return;
    // Session-cookie path: must carry CSRF. verifyCsrf sends the 403 itself.
    const { verifyCsrf } = await import("./csrf.js");
    verifyCsrf(req, reply);
  });
}
