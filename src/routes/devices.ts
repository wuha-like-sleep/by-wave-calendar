// REST endpoints for the native-app device pairing flow.
//
// /api/v1/devices/pair-init     (auth required — web session or bearer)
//   user clicks "pair new device" → we return a fresh code + QR data.
// /api/v1/devices/pair-claim    (no auth — code IS the auth)
//   the phone POSTs the scanned code → we issue refresh + access tokens.
// /api/v1/auth/refresh          (no auth — refresh token IS the auth)
//   the phone trades a refresh token for a fresh access JWT.
// /api/v1/auth/web-session      (bearer auth — phone trades JWT for a
//   short-lived "open web in browser" URL with auto-login. Used by the
//   iOS APP's 「账号管理」flow so the user doesn't re-enter password
//   to access change-password / MFA / Passkey / delete-account pages
//   that already live in the web UI. The companion handler is in
//   src/web/index.ts: GET /app/auth/from-native?token=…&next=… )
// /api/v1/devices               (auth — list / revoke own devices)
// /api/v1/devices/me            (auth — what device am I, if I'm a bearer-bound app)
//
// In-memory web-session token store. Process-local; survives crashes
// fine because the tokens are 5-minute one-shot anyway. If we ever
// scale to PM2 cluster mode, move this to PG or Redis — for now the
// ecosystem.config.cjs runs a single fork.
const webSessionTokens = new Map<string, { userId: string; expiresAt: number }>();

// MFA-pending login state. When password verification succeeds for an
// MFA-enabled account, we stash the device-creation params here keyed
// by a short-lived random token and return that to the client. The
// client then POSTs /auth/login-mfa-verify with the token + 6-digit
// TOTP code, and we issue the actual refresh+access pair.
//
// 5-minute TTL, single-use. Same process-local caveat as above.
interface MfaPendingState {
  userId: string;
  label: string;
  kind: string;
  appVersion: string | null;
  clientDeviceId: string | null;
  ip: string | null;
  userAgent: string | null;
  expiresAt: number;
}
const mfaPendingTokens = new Map<string, MfaPendingState>();
function _purgeExpiredMfa(): void {
  const now = Date.now();
  for (const [k, v] of mfaPendingTokens) if (v.expiresAt < now) mfaPendingTokens.delete(k);
}
function _purgeExpiredWebSessions(): void {
  const now = Date.now();
  for (const [k, v] of webSessionTokens) if (v.expiresAt < now) webSessionTokens.delete(k);
}
export function consumeWebSessionToken(token: string): string | null {
  _purgeExpiredWebSessions();
  const v = webSessionTokens.get(token);
  if (!v) return null;
  webSessionTokens.delete(token);  // one-shot
  if (v.expiresAt < Date.now()) return null;
  return v.userId;
}

// ---- Pair-code in-memory state (module scope) ----
//
// CRITICAL: lives at module scope, not inside deviceRoutes()'s closure,
// because two registrations are involved:
//
//   1. deviceRoutes (registered TWICE — once at /api, once at /api/v1)
//      hosts the API endpoints (pair-init / pair-status / pair-approve).
//
//   2. pairPageRoutes (registered ONCE, at root) hosts the HTML approve
//      page the phone browser opens after scanning the QR — paths like
//      GET /desktop-pair/:code and POST /desktop-pair/:code/approve.
//      These MUST live at root because the QR encodes the URL without
//      any /api prefix (no phone camera puts that prefix in for you).
//
// If the Maps lived inside each function's closure, /api/v1/devices/
// desktop-pair-init would write to Map A and the phone's GET /desktop-
// pair/:code would read Map B (different closure) — the code would
// always look "expired." Hoisting fixes both the prefix-mismatch and
// the cross-registration consistency issue.

type DesktopPair = {
  code: string;
  status: "pending" | "approved" | "denied";
  createdAt: number;
  expiresAt: number;
  userId?: string;
  accessToken?: string;
  accessTokenExpiresAt?: Date;
  refreshToken?: string;
  deviceId?: string;
  userEmail?: string;
  userName?: string | null;
};
const desktopPairs = new Map<string, DesktopPair>();
const DESKTOP_PAIR_TTL_MS = 5 * 60 * 1000;

function _purgeExpiredDesktopPairs() {
  const now = Date.now();
  for (const [code, p] of desktopPairs.entries()) {
    if (p.expiresAt < now) desktopPairs.delete(code);
  }
}

type WebPair = {
  code: string;
  status: "pending" | "approved" | "denied";
  createdAt: number;
  expiresAt: number;
  userId?: string;
};
const webPairs = new Map<string, WebPair>();
const WEB_PAIR_TTL_MS = 5 * 60 * 1000;

function _purgeExpiredWebPairs() {
  const now = Date.now();
  for (const [code, p] of webPairs.entries()) {
    if (p.expiresAt < now) webPairs.delete(code);
  }
}

// Shared site-settings gates for the page routes. Mirrored helpers
// inside deviceRoutes() use the same checks but write differently-
// shaped JSON errors; the page routes redirect/render instead.
async function siteAppsEnabled(): Promise<boolean> {
  const s = await getSettings();
  return s.appsEnabled;
}
async function siteQrLoginEnabled(): Promise<boolean> {
  const s = await getSettings();
  return s.qrLoginEnabled;
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import QRCode from "qrcode";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { requireUserOrSend, loadUserFromRequest, createSession } from "../lib/session.js";
import { csrfTokenFor, verifyCsrf } from "../lib/csrf.js";
import { tForRequest, translatePlain, resolveLocaleFromRequest, type TranslationKey } from "../lib/i18n.js";
import { env } from "../env.js";
import { getSettings } from "../lib/site_settings.js";
import { verifyPassword, verifyPasswordTimingSafe } from "../lib/password.js";
import { isLocked, recordFailedLogin, resetFailedLogin } from "../lib/login_lockout.js";
import { userIsActive } from "../lib/user_state.js";
import { issueRefreshToken, signAccessToken } from "../lib/device_tokens.js";
import {
  decideEmailClaim,
  evictAccountCredentials,
  provisionAccount,
  type ProvisionDenial,
} from "../lib/account_provisioning.js";
import {
  initPairing,
  claimPairing,
  refreshAccessToken,
  listDevicesForUser,
  revokeDevice,
} from "../lib/devices.js";

/**
 * 苹果登录建号被拒 → 这条路的错误形态。导出是为了能单独钉住这张表。
 *
 * **一条都不是 401。** 401 在 App 的 api.dart 里的意思是「会话没了」,收到就
 * 把人登出;而「这次不让你开号」跟「你是谁我不认」完全是两回事,已发布的包
 * 改不了那个判断。403 才是「我认得你,但这件事不行」。
 *
 * 也不把配额数字放进 error 串:那是管理员设的闸门,不该从 App 漏出去。
 *
 * ── messageKey 是干什么的 ──────────────────────────────────────────────
 * 光有 error 码不够,因为**已经发布出去的 iOS 包改不了**。
 * apps/ios/.../Auth/AppleSignIn.swift 的文案表只认识四个码
 * (apple_token_invalid / account_disabled / apple_signin_not_configured /
 * apps_disabled),这里这几个码它一个都不认,全都落到 default 分支,而那个
 * 分支不带 message 时会把状态码和码名直接拼给用户看:
 *
 *     Apple 登录失败 (HTTP 409) - email_taken
 *
 * 好在它的 default 分支**第一件事**就是「服务端给了非空 message 就显示它」。
 * 所以纯服务端补一句本地化的人话,存量用户当场就能看懂 —— 不用发版。
 *
 * 回的是键不是文案:语言要按请求现算(见路由里的 appleT),这个函数是纯的,
 * 不该知道请求长什么样。
 */
export function appleProvisionDenial(d: ProvisionDenial): { status: number; error: string; messageKey: TranslationKey } {
  switch (d.code) {
    case "invalid_email": return { status: 400, error: "invalid_email", messageKey: "appleLogin.invalidEmail" };
    case "registration_closed": return { status: 403, error: "signup_closed", messageKey: "appleLogin.signupClosed" };
    // 苹果登录带不出邀请码,所以邀请制下这两条对 App 是同一件事。
    case "invite_required":
    case "invite_invalid": return { status: 403, error: "signup_invite_only", messageKey: "appleLogin.inviteOnly" };
    case "domain_not_allowed": return { status: 403, error: "signup_domain_not_allowed", messageKey: "appleLogin.domainNotAllowed" };
    case "daily_quota_reached": return { status: 403, error: "signup_quota_reached", messageKey: "appleLogin.quotaReached" };
    // 这两条是「号建不出来」,不是闸门拦的,沿用原来的 500 形态。
    // 但对用户来说「邮箱撞了」和「插库失败」下一步完全不同,所以码合并、话不合并。
    case "email_taken": return { status: 500, error: "account_create_failed", messageKey: "appleLogin.emailTaken" };
    case "create_failed": return { status: 500, error: "account_create_failed", messageKey: "appleLogin.createFailed" };
  }
}

/**
 * /auth/apple 这条路上的 `t()`。
 *
 * 为什么不直接用 tForRequest:那个读的是 `req.locale`,而 `req.locale` 是
 * src/server.ts 里一个全局 onRequest 钩子写的。**这条路能不能读到它,取决于
 * 那个钩子和 `app.register(deviceRoutes)` 的先后**,而且 tForRequest 读不到时
 * 会安静地回落到 zh-CN —— 不报错、不打日志,只是全世界的用户都收到中文。
 * 这种失效形态在这个仓库出过太多次,不值得再赌一次:这里自己算。
 *
 * 口径跟网页完全一致(resolveLocale 的优先级):
 *   ?lang= → bwc_locale cookie → 用户偏好 → 站点默认语言 → Accept-Language → zh-CN
 * 登录这一刻服务端还不知道他是谁,所以前三级都不可能命中:
 *   - 原生 App 不带 cookie,也不会给这个接口加 ?lang=;
 *   - 用户是谁正是这次请求要决定的事。
 * 于是实际生效的是后两级 —— **站点默认语言压着 Accept-Language**。
 *
 * 局限(知道了再选,不是没看见):
 *   - `default_locale` 这一列的建表默认值是 "zh-CN",不是 "auto"。站长没动过
 *     这一项的话,日本用户收到的仍然是中文。要让设备语言说了算,站长得把
 *     后台的网站语言改成「跟随浏览器」。这条不在这里偷偷改口径 —— 一个接口
 *     跟全站不一样,是下一个坑。
 *   - iOS 没有显式发 Accept-Language,靠的是 URLSession 按系统偏好语言自动带的
 *     那一条。用户只在 App 里换了语言、没换系统语言时,这里会跟 App 界面不一致。
 *   - 苹果发的是 zh-Hans-CN / zh-Hant-TW 这种写法,而 pickFromAcceptLanguage 只做
 *     「精确匹配 → 主语言前缀」两级,zh-Hant-TW 会落到 zh-CN(繁体用户收到简体)。
 *     修它要动 src/lib/i18n.ts,不在这一轮的射程里。
 */
async function appleT(req: FastifyRequest): Promise<(key: TranslationKey) => string> {
  const s = await getSettings();
  const locale = resolveLocaleFromRequest(req, null, s.defaultLocale);
  // translatePlain 不是 translate:这句话落在 JSON 里、由原生 App 直接显示,
  // 不经过 EJS。用会转义的那个,用户会在手机上看到 &quot; 和 &#39;。
  return (key) => translatePlain(locale, key);
}

// Master feature gate. Reads the latest site_settings on each call so an
// admin toggle takes effect immediately (no restart). pair-claim and
// refresh hit this without auth — they're public endpoints used by the
// APP — but we still want to refuse them when the feature is off.
//
// The req param is optional for backward compatibility but should be
// passed wherever possible so the warn log includes the path that was
// blocked — vital for users debugging "I enabled it but still get 403".
async function ensureAppsEnabled(reply: FastifyReply, req?: { log: { warn: (msg: unknown, ...args: unknown[]) => void }; url?: string; ip?: string }): Promise<boolean> {
  const s = await getSettings();
  if (s.appsEnabled) return true;
  if (req) {
    // Surface this loudly in pm2 logs so the admin can grep for it.
    // Pino structured logging — "apps_disabled" is the searchable token.
    req.log.warn({ event: "apps_disabled_block", path: req.url, ip: req.ip }, "APP request blocked: appsEnabled=false. Toggle in admin → API & APPs.");
  }
  reply.code(403).send({ error: "apps_disabled", message: "管理员已停用 APP 同步。请进入网页后台 → 管理 → API & APPs → 「打开 APP 登录」开关后重试。" });
  return false;
}

/** Request-scoped translate for the pair-page titles rendered here.
 *  Locale comes from `req.locale` (view-locals hook in src/server.ts). */
function tr(req: FastifyRequest, key: string): string {
  return tForRequest(req)(key);
}

export async function deviceRoutes(app: FastifyInstance) {
  // -------- pair-init (web user starts the QR flow) --------
  // We accept any authed user (cookie or bearer). The response carries
  // both the structured payload (for the app to consume after scan) and
  // an SVG-encoded QR for the web page to drop in directly.
  app.post("/devices/pair-init", async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    if (!(await ensureAppsEnabled(reply, req))) return;
    const { code, expiresAt } = await initPairing(user.id);

    // The QR encodes a JSON pairing envelope:
    //   { v: 1, url: "https://rl.lz-ss.com", code: "ABC123" }
    // The app reads `url` so users don't have to type the server name.
    // Stripping trailing slash keeps the embedded URL canonical.
    const serverUrl = env.PUBLIC_BASE_URL.replace(/\/$/, "");
    const payload = JSON.stringify({ v: 1, url: serverUrl, code });
    // SVG so the page can inline-render without an extra image fetch.
    // Margin 1 keeps the quiet zone small enough to fit a modal at 280px wide.
    const qrSvg = await QRCode.toString(payload, { type: "svg", margin: 1, errorCorrectionLevel: "M" });

    return reply.send({
      code,
      payload,
      qrSvg,
      expiresAt: expiresAt.toISOString(),
    });
  });

  // -------- pair-claim (the phone calls this with the scanned code) --------
  // Anonymous endpoint — the one-time code IS the proof of authorization.
  // Returns { accessToken, refreshToken, expiresAt } on success, 401 on
  // expired/claimed/invalid code.
  app.post("/devices/pair-claim", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!(await ensureAppsEnabled(reply, req))) return;
    const body = z.object({
      code: z.string().min(4).max(20),
      label: z.string().min(1).max(60),
      kind: z.enum(["ios", "android", "desktop", "other"]).default("other"),
      appVersion: z.string().max(40).optional(),
      // Stable per-install UUID from the APP (iCloud Keychain). Optional
      // for backwards compat with older clients. When present, the server
      // reuses the existing devices row for this (userId, clientDeviceId).
      clientDeviceId: z.string().min(8).max(64).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });

    const ua = String(req.headers["user-agent"] ?? "").slice(0, 500);
    const result = await claimPairing({
      code: body.data.code.trim().toUpperCase(),
      label: body.data.label,
      kind: body.data.kind,
      appVersion: body.data.appVersion ?? null,
      clientDeviceId: body.data.clientDeviceId ?? null,
      ip: req.ip,
      userAgent: ua,
    });
    if (!result) return reply.code(401).send({ error: "invalid_or_expired_code" });

    return reply.send({
      accessToken: result.accessToken,
      accessTokenExpiresAt: result.accessTokenExpiresAt.toISOString(),
      refreshToken: result.refreshToken,
      deviceId: result.deviceId,
      userId: result.userId,
      userEmail: result.userEmail,
      userName: result.userName,
    });
  });

  // -------- password login (alternative to QR pairing) --------
  // For users who'd rather type email+password than scan a QR. Same
  // safeguards as the web login flow:
  //   - Disabled-account check
  //   - Login lockout (15min after 5 failures)
  //   - Timing-safe verify so non-existent emails don't leak
  // MFA-enabled accounts: we don't error — instead we mint a short-
  // lived mfaToken and return { mfaPending: true, mfaToken }. The
  // client (iOS APP) then prompts for the 6-digit TOTP code and posts
  // to /auth/login-mfa-verify to complete the login natively.
  app.post("/auth/login-password", { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!(await ensureAppsEnabled(reply, req))) return;
    const body = z.object({
      email: z.string().email().max(254).transform((s) => s.toLowerCase().trim()),
      password: z.string().min(1).max(200),
      label: z.string().min(1).max(60),
      kind: z.enum(["ios", "android", "desktop", "other"]).default("other"),
      appVersion: z.string().max(40).optional(),
      // See pair-claim for rationale — dedup by stable client UUID so
      // re-login doesn't create a duplicate devices row.
      clientDeviceId: z.string().min(8).max(64).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });

    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, body.data.email)).limit(1);
    if (!user) {
      // Burn the same bcrypt CPU as a real verify so the response time
      // doesn't leak whether the email is registered.
      await verifyPasswordTimingSafe(body.data.password);
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    if (!userIsActive(user)) {
      return reply.code(403).send({ error: "account_disabled" });
    }
    if (isLocked(user)) {
      return reply.code(429).send({ error: "account_locked", message: "登录失败次数过多，请稍后再试" });
    }
    if (!(await verifyPassword(body.data.password, user.passwordHash))) {
      await recordFailedLogin(user);
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    await resetFailedLogin(user.id);

    const ua = String(req.headers["user-agent"] ?? "").slice(0, 500);

    // MFA-pending path — password is right, but account requires TOTP.
    // Stash the device-creation params and return a token the client
    // must echo back to /auth/login-mfa-verify with the code.
    if (user.mfaEnabled) {
      _purgeExpiredMfa();
      const { randomBytes } = await import("node:crypto");
      const mfaToken = randomBytes(24).toString("hex");
      const ttlMs = 5 * 60 * 1000;
      mfaPendingTokens.set(mfaToken, {
        userId: user.id,
        label: body.data.label,
        kind: body.data.kind,
        appVersion: body.data.appVersion ?? null,
        clientDeviceId: body.data.clientDeviceId ?? null,
        ip: req.ip,
        userAgent: ua,
        expiresAt: Date.now() + ttlMs,
      });
      return reply.send({
        mfaPending: true,
        mfaToken,
        mfaExpiresAt: new Date(Date.now() + ttlMs).toISOString(),
      });
    }

    // Create the device row + tokens (or reuse existing one for the same
    // clientDeviceId — see upsertDeviceForUser).
    const refresh = await issueRefreshToken();
    const { upsertDeviceForUser } = await import("../lib/devices.js");
    const device = await upsertDeviceForUser({
      userId: user.id,
      label: body.data.label,
      kind: body.data.kind,
      appVersion: body.data.appVersion ?? null,
      clientDeviceId: body.data.clientDeviceId ?? null,
      refreshHash: refresh.hash,
      refreshPrefix: refresh.prefix,
      ip: req.ip,
      userAgent: ua,
    });
    if (!device) return reply.code(500).send({ error: "device_create_failed" });
    const access = signAccessToken(user.id, device.id);
    return reply.send({
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken: refresh.plain,
      deviceId: device.id,
      userId: user.id,
      userEmail: user.email,
      userName: user.displayName,
    });
  });

  // -------- MFA verify (second step of password login) --------
  // Client posts { mfaToken, code } after seeing mfaPending=true in the
  // /auth/login-password response. Code can be a 6-digit TOTP or one
  // of the 10 backup codes. On success we mint refresh+access just
  // like a clean password login.
  app.post("/auth/login-mfa-verify", {
    config: { rateLimit: { max: 12, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    if (!(await ensureAppsEnabled(reply, req))) return;
    const body = z.object({
      mfaToken: z.string().min(32).max(64),
      code: z.string().min(6).max(20),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });

    _purgeExpiredMfa();
    const pending = mfaPendingTokens.get(body.data.mfaToken);
    if (!pending) {
      return reply.code(401).send({ error: "mfa_token_expired", message: "验证码会话已过期，请重新输入密码登录。" });
    }
    if (pending.expiresAt < Date.now()) {
      mfaPendingTokens.delete(body.data.mfaToken);
      return reply.code(401).send({ error: "mfa_token_expired", message: "验证码会话已过期，请重新输入密码登录。" });
    }

    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, pending.userId)).limit(1);
    if (!user || !user.mfaEnabled || !user.mfaTotpSecret) {
      mfaPendingTokens.delete(body.data.mfaToken);
      return reply.code(401).send({ error: "mfa_state_invalid" });
    }

    // Try TOTP first, then backup codes. Same precedence as the web flow.
    const { verifyTotpCode, consumeBackupCode } = await import("../lib/mfa.js");
    let verified = verifyTotpCode(user.mfaTotpSecret, body.data.code);
    if (!verified) {
      const codes = (user.mfaBackupCodes as { hash: string; used: boolean }[] | null) ?? [];
      const consumed = consumeBackupCode(codes, body.data.code);
      if (consumed.ok) {
        verified = true;
        // Mark the code as used so it can't be reused.
        await db.update(schema.users)
          .set({ mfaBackupCodes: consumed.updated as unknown as object, updatedAt: new Date() })
          .where(eq(schema.users.id, user.id));
      }
    }
    if (!verified) {
      return reply.code(401).send({ error: "invalid_code", message: "验证码错误" });
    }

    // Consume the mfa token now — single-use.
    mfaPendingTokens.delete(body.data.mfaToken);

    const refresh = await issueRefreshToken();
    const { upsertDeviceForUser } = await import("../lib/devices.js");
    const device = await upsertDeviceForUser({
      userId: user.id,
      label: pending.label,
      kind: pending.kind,
      appVersion: pending.appVersion,
      clientDeviceId: pending.clientDeviceId,
      refreshHash: refresh.hash,
      refreshPrefix: refresh.prefix,
      ip: pending.ip,
      userAgent: pending.userAgent,
    });
    if (!device) return reply.code(500).send({ error: "device_create_failed" });
    const access = signAccessToken(user.id, device.id);
    return reply.send({
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken: refresh.plain,
      deviceId: device.id,
      userId: user.id,
      userEmail: user.email,
      userName: user.displayName,
    });
  });

  // -------- Sign in with Apple (#67) --------
  // The native iOS app authorizes via ASAuthorizationController, gets an
  // Apple-signed identityToken (RS256 JWT), and POSTs it here. We verify
  // that token against Apple's JWKS (never trusting any app-supplied
  // identity field), then link/create the user and mint device tokens —
  // exactly like /auth/login-password, just with Apple as the auth proof.
  //
  // Linking rules (in priority order):
  //   1. By apple_sub — the stable, primary key for "this Apple account".
  //   2. By email — links an existing email/password account to Apple on
  //      first SIWA login (so a user who already had a password account
  //      can start using SIWA without creating a duplicate). Only when
  //      Apple says the email is verified AND it's not a private-relay
  //      proxy (a relay address could belong to anyone's hidden alias).
  //   3. Otherwise create a fresh passwordless account.
  app.post("/auth/apple", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!(await ensureAppsEnabled(reply, req))) return;
    // 每个拒绝分支都要带一句人话:存量 iOS 包不认识下面这些码,不给 message
    // 就把状态码和码名拼给用户看。语言按请求现算,见 appleT。
    const t = await appleT(req);
    const { appleSignInConfigured, verifyAppleIdentityToken, AppleVerifyError } =
      await import("../lib/apple_signin.js");
    if (!appleSignInConfigured()) {
      return reply.code(503).send({ error: "apple_signin_not_configured", message: t("appleLogin.notConfigured") });
    }
    const body = z.object({
      identityToken: z.string().min(1).max(8192),
      label: z.string().min(1).max(60),
      kind: z.enum(["ios", "android", "desktop", "other"]).default("ios"),
      appVersion: z.string().max(40).optional(),
      clientDeviceId: z.string().min(8).max(64).optional(),
      // Apple hands the display name to the app ONLY on the very first
      // authorization; the app forwards it here so we can populate it for
      // a brand-new account. We treat it as untrusted decoration (NOT
      // identity) — the verified token is the source of truth for sub/email.
      fullName: z.string().max(100).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request", message: t("appleLogin.badRequest") });

    let claims;
    try {
      claims = await verifyAppleIdentityToken(body.data.identityToken);
    } catch (err) {
      if (err instanceof AppleVerifyError) {
        req.log.warn({ code: err.code }, "apple_signin_verify_failed");
        return reply.code(401).send({ error: "apple_token_invalid", code: err.code, message: t("appleLogin.tokenInvalid") });
      }
      throw err;
    }

    // 1) Link by apple_sub (the durable key).
    let [user] = await db.select().from(schema.users).where(eq(schema.users.appleSub, claims.sub)).limit(1);

    // 2) Else link an existing account by verified, non-relay email.
    //
    // 认领判定收口在 decideEmailClaim(见 lib/account_provisioning.ts):
    // 苹果**没有** slug 的概念,claimProvider 只能是 null —— 也就是说这条路
    // 永远不算「同一个 IdP 的延续」,认领一行自己没验过邮箱的账号时一定先作废
    // 它上面的凭据。这正是这次要修的形状:攻击者拿受害者的邮箱在 /auth/register
    // 开一个号(那条路不验邮箱),受害者随后用苹果登录,原来的代码只看苹果说
    // 验过了、不看**这一行**验没验过,于是受害者被并进攻击者那一行,而攻击者
    // 的密码一直有效。
    if (!user && claims.email && claims.emailVerified && !claims.isPrivateRelay) {
      const [byEmail] = await db.select().from(schema.users).where(eq(schema.users.email, claims.email)).limit(1);
      if (byEmail) {
        const decision = decideEmailClaim({
          row: { emailVerified: byEmail.emailVerified, ssoProviderSlug: byEmail.ssoProviderSlug },
          claimProvider: null,
          provenEmail: true,
        });
        if (decision === "refuse") {
          // 409 而不是 401:401 在 App 的 api.dart 里的意思是「会话没了」。
          return reply.code(409).send({ error: "email_taken", message: t("appleLogin.emailTaken") });
        }
        if (decision === "adopt_after_eviction") {
          await evictAccountCredentials(byEmail.id, {
            claimedBy: "apple",
            ip: req.ip,
            userAgent: String(req.headers["user-agent"] ?? "").slice(0, 500) || null,
          });
        }
        await db.update(schema.users)
          .set({ appleSub: claims.sub, emailVerified: true, updatedAt: new Date() })
          .where(eq(schema.users.id, byEmail.id));
        // 作废动作改过这一行的一大半列(密码、MFA、锁定计数…),byEmail 这个
        // 对象已经是旧的。回读一次,别把陈旧字段带进后面的判定。
        const [fresh] = await db.select().from(schema.users).where(eq(schema.users.id, byEmail.id)).limit(1);
        if (!fresh) return reply.code(500).send({ error: "account_create_failed", message: t("appleLogin.createFailed") });
        user = fresh;
      }
    }

    // 3) Else create a fresh passwordless account.
    if (!user) {
      // Apple may withhold email on re-auth, but on FIRST authorization it's
      // always present. If somehow absent (edge: user revoked + the token
      // omits it on a first-seen sub), synthesize a stable placeholder from
      // the sub so the notNull email column is satisfied; the user can set a
      // real email later in settings.
      const email = claims.email || `${claims.sub.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}@appleid.local`;
      // 这个邮箱已经有账号了(而且不带 apple_sub —— 带的话第 1 步就命中了)。
      //
      // 原来这里**无条件**把 apple_sub 打上去认领。但能走到第 3 步,恰恰说明
      // 第 2 步没通过 —— 苹果对这个邮箱**什么都没断言**:要么没验过、要么是私有
      // 转发地址(那种地址可能是任何人的隐藏别名)、要么这个邮箱压根是按 sub
      // 拼出来的占位串。拿一个没有任何断言的邮箱去认领别人的号,就是第 2 步刚
      // 堵掉的那个动作换了个入口。
      //
      // 所以这里只能拒绝。decideEmailClaim 在 provenEmail=false 且没有延续关系
      // 时回的也是 refuse,口径是同一条,只是这条路没有第二种可能、不必再算一次。
      const [emailClash] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
      if (emailClash) {
        return reply.code(409).send({ error: "email_taken", message: t("appleLogin.emailTaken") });
      } else {
        // 建号收口:注册策略 / 邀请码 / 域名白名单 / 每日配额 全在里面判,跟网页
        // 注册同一份。苹果登录以前完全不看这些开关 —— 站长把注册关了,从 App
        // 用 Apple ID 进来照样开出新号。
        //
        // apple_sub 跟 users 行**在同一条 INSERT 里**落库(收口函数按 origin 写),
        // 不能建完再 UPDATE:那一列上有唯一索引,分两步的话两个并发请求都能插入
        // 成功、第二步才撞,而那时号已经建出来了。
        //
        // 无密码账号的 password_hash 由收口函数生成(真 bcrypt、随机 256 位,
        // 不是哨兵串),默认日历也由它建。
        const prov = await provisionAccount({
          email,
          origin: { kind: "apple", sub: claims.sub },
          // 跟随苹果的断言,不强行写 true。邮箱到底验没验过是个事实,不是我们
          // 这一层能替它决定的。
          emailVerified: claims.emailVerified,
          displayName: body.data.fullName?.trim() || null,
          onExistingEmail: "adopt",
          ctx: { ip: req.ip, userAgent: String(req.headers["user-agent"] ?? "").slice(0, 500) || null },
        });
        if (!prov.ok) {
          const m = appleProvisionDenial(prov.reason);
          return reply.code(m.status).send({ error: m.error, message: t(m.messageKey) });
        }
        user = prov.user;
      }
    }

    if (!userIsActive(user)) {
      return reply.code(403).send({ error: "account_disabled", message: t("appleLogin.accountDisabled") });
    }

    // Mint device tokens — identical to /auth/login-password's happy path.
    const ua = String(req.headers["user-agent"] ?? "").slice(0, 500);
    const refresh = await issueRefreshToken();
    const { upsertDeviceForUser } = await import("../lib/devices.js");
    const device = await upsertDeviceForUser({
      userId: user.id,
      label: body.data.label,
      kind: body.data.kind,
      appVersion: body.data.appVersion ?? null,
      clientDeviceId: body.data.clientDeviceId ?? null,
      refreshHash: refresh.hash,
      refreshPrefix: refresh.prefix,
      ip: req.ip,
      userAgent: ua,
    });
    if (!device) return reply.code(500).send({ error: "device_create_failed", message: t("appleLogin.deviceFailed") });
    const access = signAccessToken(user.id, device.id);
    void (async () => {
      try {
        const { recordLoginEvent } = await import("../lib/login_history.js");
        await recordLoginEvent(req, user.id, "apple");
      } catch (err) { req.log.warn({ err }, "login_event_failed"); }
    })();
    return reply.send({
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken: refresh.plain,
      deviceId: device.id,
      userId: user.id,
      userEmail: user.email,
      userName: user.displayName,
    });
  });

  // -------- refresh access token --------
  // Phone hits this on 401 or when its cached access token is near expiry.
  app.post("/auth/refresh", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!(await ensureAppsEnabled(reply, req))) return;
    const body = z.object({ refreshToken: z.string().min(20).max(80) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const result = await refreshAccessToken({ refreshToken: body.data.refreshToken, ip: req.ip });
    if (!result) return reply.code(401).send({ error: "invalid_refresh_token" });
    return reply.send({
      accessToken: result.accessToken,
      accessTokenExpiresAt: result.expiresAt.toISOString(),
    });
  });

  // -------- register / unregister APNs push token --------
  // Called by the iOS APP after iOS hands it a device token. We store
  // it on the device row identified by the JWT's `did` claim.
  app.post("/devices/me/push-token", async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const deviceId = (req as unknown as { deviceId?: string }).deviceId;
    if (!deviceId) {
      return reply.code(400).send({ error: "not_a_device_session" });
    }
    const body = z.object({
      pushToken: z.string().min(20).max(200).nullable(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    // Confirm the device belongs to this user (defense-in-depth — the
    // JWT path already verified, but a stale `did` claim could survive).
    const [device] = await db.select().from(schema.devices)
      .where(and(eq(schema.devices.id, deviceId), eq(schema.devices.userId, user.id)))
      .limit(1);
    if (!device) return reply.code(404).send({ error: "device_not_found" });
    await db.update(schema.devices)
      .set({ pushToken: body.data.pushToken })
      .where(eq(schema.devices.id, deviceId));
    return reply.send({ ok: true });
  });

  // Identify the device this request is authed as. APP uses this to
  // resolve "which devices row is me" without needing to scan the
  // list — handy for self-revoke from the SettingsView.
  app.get("/devices/me", async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const deviceId = (req as unknown as { deviceId?: string }).deviceId;
    if (!deviceId) return reply.code(400).send({ error: "not_a_device_session" });
    const [device] = await db.select().from(schema.devices)
      .where(and(eq(schema.devices.id, deviceId), eq(schema.devices.userId, user.id)))
      .limit(1);
    if (!device) return reply.code(404).send({ error: "device_not_found" });
    return reply.send({
      id: device.id,
      label: device.label,
      kind: device.kind,
      hasPushToken: !!device.pushToken,
    });
  });

  // -------- native MFA setup (Bearer auth required) --------
  // 3-step flow:
  //   1. POST /api/v1/account/mfa/setup    — mint pending secret + return otpauth URI
  //   2. POST /api/v1/account/mfa/verify   — user enters 6-digit code, we activate + issue backup codes
  //   3. POST /api/v1/account/mfa/disable  — password + code to turn off
  //
  // We store the pending secret on the user row in `mfa_pending_secret`
  // and only activate (set `mfa_totp_secret`) after successful verify.
  // The web flow does the same thing — we just expose JSON instead of
  // form redirects so the iOS APP can present native UI.

  app.post("/account/mfa/setup", async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    if (user.mfaEnabled) {
      return reply.code(409).send({ error: "already_enabled", message: "MFA 已启用。请先关闭再重新设置。" });
    }
    const { newTotpSecret, totpKeyUri } = await import("../lib/mfa.js");
    const secret = newTotpSecret();
    const uri = totpKeyUri(user.email, secret);
    // Stash the pending secret so verify can grab it. Don't activate yet.
    await db.update(schema.users)
      .set({ mfaPendingSecret: secret, updatedAt: new Date() })
      .where(eq(schema.users.id, user.id));
    return reply.send({
      otpauthUri: uri,
      // Pre-rendered QR data URL for clients that don't want to draw
      // the QR themselves. iOS APP can still do it natively from
      // otpauthUri — sending both lets each client pick.
      secret,
    });
  });

  app.post("/account/mfa/verify", async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const body = z.object({ code: z.string().min(6).max(8) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    if (!user.mfaPendingSecret) {
      return reply.code(412).send({ error: "no_pending_setup", message: "请先调 /mfa/setup。" });
    }
    const { verifyTotpCode, generateBackupCodes } = await import("../lib/mfa.js");
    if (!verifyTotpCode(user.mfaPendingSecret, body.data.code)) {
      return reply.code(401).send({ error: "invalid_code", message: "验证码错误，请重试。" });
    }
    const codes = generateBackupCodes(10);
    await db.update(schema.users).set({
      mfaEnabled: true,
      mfaTotpSecret: user.mfaPendingSecret,
      mfaPendingSecret: null,
      mfaBackupCodes: codes.stored as unknown as object,
      updatedAt: new Date(),
    }).where(eq(schema.users.id, user.id));
    const { sendMail } = await import("../lib/mailer.js");
    const { securityChangeMail } = await import("../lib/email_templates.js");
    void sendMail(securityChangeMail(user.email, { kind: "mfa_enabled" }))
      .catch((err) => req.log.warn({ err }, "mfa_enable_mail_failed"));
    return reply.send({ ok: true, backupCodes: codes.plain });
  });

  app.post("/account/mfa/disable", async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    if (!user.mfaEnabled) return reply.send({ ok: true });  // already off
    const body = z.object({
      password: z.string().min(1).max(200),
      code: z.string().min(6).max(8),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    if (!user.passwordHash || !(await verifyPassword(body.data.password, user.passwordHash))) {
      return reply.code(401).send({ error: "invalid_credentials", message: "密码错误。" });
    }
    const { verifyTotpCode } = await import("../lib/mfa.js");
    if (!user.mfaTotpSecret || !verifyTotpCode(user.mfaTotpSecret, body.data.code)) {
      return reply.code(401).send({ error: "invalid_code", message: "验证码错误。" });
    }
    await db.update(schema.users).set({
      mfaEnabled: false,
      mfaTotpSecret: null,
      mfaPendingSecret: null,
      mfaBackupCodes: null,
      updatedAt: new Date(),
    }).where(eq(schema.users.id, user.id));
    const { sendMail } = await import("../lib/mailer.js");
    const { securityChangeMail } = await import("../lib/email_templates.js");
    void sendMail(securityChangeMail(user.email, { kind: "mfa_disabled" }))
      .catch((err) => req.log.warn({ err }, "mfa_disable_mail_failed"));
    return reply.send({ ok: true });
  });

  // -------- native account management (Bearer auth required) --------
  // The iOS APP's 「账号管理」flow used to bounce out to SFSafariView for
  // every action. Now the simple ones (password change / account delete)
  // have native JSON endpoints so the APP can do everything in-form
  // without ever leaving the surface. MFA setup + Passkey register
  // stay on the Safari bridge for now (they need additional native UI).

  app.post("/account/password", {
    config: { rateLimit: { max: 6, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const body = z.object({
      currentPassword: z.string().min(1).max(200),
      newPassword: z.string().min(8).max(200),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    // Reject SSO-only accounts (no local password to verify).
    if (!user.passwordHash) {
      return reply.code(412).send({ error: "no_local_password", message: "你的账号通过 SSO 登录，没有本地密码可改。" });
    }
    if (!(await verifyPassword(body.data.currentPassword, user.passwordHash))) {
      return reply.code(401).send({ error: "invalid_credentials", message: "当前密码错误" });
    }
    const { passwordPolicyError } = await import("../lib/password.js");
    const policy = passwordPolicyError(body.data.newPassword);
    if (policy) {
      return reply.code(400).send({ error: "weak_password", message: policy });
    }
    const { hashPassword } = await import("../lib/password.js");
    const hash = await hashPassword(body.data.newPassword);
    await db.update(schema.users).set({ passwordHash: hash, updatedAt: new Date() }).where(eq(schema.users.id, user.id));
    // 改密码要把其它客户端全部踢掉，只留当前这台设备（否则用户在 App 里
    // 改完密码自己就被登出了）。
    //
    // 注意：以前这里只删 sessions 表，而注释却写着「其它设备下次调用会 401」
    // —— 那是错的。App 的 refresh token 存在 devices 表里，是另一套凭据，
    // 不吊销它，盗号者只要在改密码之前登过一次 App 就赶不走。
    const { sendMail } = await import("../lib/mailer.js");
    const { securityChangeMail } = await import("../lib/email_templates.js");
    void sendMail(securityChangeMail(user.email, { kind: "password_changed" }))
      .catch((err) => req.log.warn({ err }, "password_change_mail_failed"));
    const { destroyAllUserSessions } = await import("../lib/session.js");
    await destroyAllUserSessions(user.id);
    const { revokeAllUserDevices } = await import("../lib/devices.js");
    const currentDeviceId = (req as unknown as { deviceId?: string }).deviceId;
    const revoked = await revokeAllUserDevices(user.id, { exceptDeviceId: currentDeviceId });
    req.log.info({ userId: user.id, revoked, keptCurrent: !!currentDeviceId }, "password_change_devices_revoked");
    return reply.send({ ok: true });
  });

  app.post("/account/delete", {
    config: { rateLimit: { max: 3, timeWindow: "5 minutes" } },
  }, async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const body = z.object({
      password: z.string().min(1).max(200),
      confirm: z.string().min(1).max(100),
    }).safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "bad_confirmation", message: "请输入密码并输入确认短语 / Enter your password and the confirmation phrase" });
    }
    // The confirm phrase is shown to the user in their APP's UI language —
    // which may differ from the server-stored user.locale. So accept the
    // phrase as it appears in ANY supported locale (plus the zh-CN literal
    // for back-compat). Previously this was z.literal("删除我的账号"), which
    // meant an English / 日本語 / … user could never match it and was unable
    // to delete their account natively. Mirrors the web handler's logic.
    const { LOCALES, translate } = await import("../lib/i18n.js");
    const typed = body.data.confirm.trim();
    const phraseAccepted =
      typed === "删除我的账号" ||
      LOCALES.some(
        (l) => translate(l.code, "settings.account.deleteConfirmFieldPlaceholder").trim() === typed,
      );
    if (!phraseAccepted) {
      const expected = translate(
        (user.locale as Parameters<typeof translate>[0]) || "en",
        "settings.account.deleteConfirmFieldPlaceholder",
      );
      return reply.code(400).send({ error: "bad_confirmation", message: `确认短语不正确，请精确输入「${expected}」/ confirmation phrase mismatch` });
    }
    if (!user.passwordHash) {
      return reply.code(412).send({ error: "no_local_password", message: "SSO 账号请联系管理员删除。" });
    }
    if (!(await verifyPassword(body.data.password, user.passwordHash))) {
      return reply.code(401).send({ error: "invalid_credentials", message: "密码错误，账号未删除" });
    }
    if (user.isAdmin) {
      const { countActiveAdmins } = await import("../lib/user_state.js");
      if ((await countActiveAdmins()) <= 1) {
        return reply.code(412).send({ error: "last_admin", message: "你是唯一的管理员，无法删除自己。请先提升另一个用户为管理员。" });
      }
    }
    const { destroyAllUserSessions } = await import("../lib/session.js");
    await destroyAllUserSessions(user.id);
    await db.delete(schema.users).where(eq(schema.users.id, user.id));
    return reply.send({ ok: true });
  });

  // -------- mint a web-session token (Bearer auth required) --------
  // The iOS APP calls this when the user taps an account-management row
  // (修改密码 / MFA / Passkey / 删除账户) in SettingsView. We mint a
  // 5-minute one-shot token, return a URL the APP opens in
  // SFSafariViewController. When that URL loads, the GET handler in
  // src/web/index.ts consumes the token, calls createSession to set the
  // bwc_sid cookie, and 302s to the requested settings page. End result:
  // user lands inside the existing web UI fully signed in, without ever
  // typing a password.
  //
  // `next` is the in-site path to redirect to after the bridge runs.
  // It's validated server-side (path must start with /app/) so we can't
  // be turned into an open redirect to a phishing page.
  app.post("/auth/web-session", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const body = z.object({
      next: z.string().min(1).max(200).regex(/^\/app(\/.*)?$/, "next 必须以 /app/ 开头").optional(),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "bad_request" });

    // 24 hex chars (96 bits) is plenty for a 5-minute token; not in DB,
    // not externally visible past the SFSafariViewController.
    const { randomBytes } = await import("node:crypto");
    const token = randomBytes(24).toString("hex");
    const ttlMs = 5 * 60 * 1000;
    webSessionTokens.set(token, { userId: user.id, expiresAt: Date.now() + ttlMs });

    const base = env.PUBLIC_BASE_URL.replace(/\/$/, "");
    const params = new URLSearchParams({ token });
    if (body.data.next) params.set("next", body.data.next);
    return reply.send({
      url: `${base}/app/auth/from-native?${params.toString()}`,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    });
  });

  // -------- list my devices --------
  app.get("/devices", async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const rows = await listDevicesForUser(user.id);
    return reply.send({
      devices: rows.map((d) => ({
        id: d.id,
        label: d.label,
        kind: d.kind,
        prefix: d.refreshTokenPrefix,
        appVersion: d.appVersion,
        lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
        lastSeenIp: d.lastSeenIp,
        firstSeenIp: d.firstSeenIp,
        createdAt: d.createdAt.toISOString(),
      })),
    });
  });

  // -------- revoke one of my devices --------
  app.delete<{ Params: { id: string } }>("/devices/:id", async (req, reply) => {
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return reply.code(400).send({ error: "bad_id" });
    const ok = await revokeDevice(user.id, id.data);
    if (!ok) return reply.code(404).send({ error: "not_found" });
    return reply.send({ ok: true });
  });

  // ============================================================
  // Desktop QR-pair (scan-to-login from desktop). Mirror image of
  // the mobile pair flow: instead of the logged-in user generating
  // a code for an unauthenticated phone, the unauthenticated
  // DESKTOP generates a code, displays it as a QR, and the
  // already-logged-in PHONE scans + approves.
  //
  // Why in-memory instead of a DB table:
  //   pair codes are valid for 5 minutes and consumed once. Losing
  //   them on server restart is fine — user just regenerates. The
  //   DB-backed mobile pair-init exists because a phone's claim can
  //   arrive minutes apart from generation; here the desktop is
  //   actively polling so we don't need persistence.
  //
  // Flow:
  //   1. Desktop:  POST  /api/v1/devices/desktop-pair-init    →  { code }
  //   2. Desktop:  show QR encoding https://<host>/desktop-pair/<code>
  //   3. Phone:    scans, opens that URL in browser (cookie auth)
  //   4. Phone:    server renders an approve/deny page
  //   5. Phone:    POST /desktop-pair/<code>/approve            (cookie auth, CSRF)
  //   6. Server:   mints tokens, attaches to in-memory record
  //   7. Desktop:  GET  /api/v1/devices/desktop-pair-status?code=...
  //                → 200 + tokens if approved
  //                → 202 if still pending
  //                → 404 if expired/unknown
  //                → 410 if denied
  //   8. Desktop:  stores tokens, transitions to logged-in state.
  //
  // The DesktopPair type + Map + purge helper live at module scope —
  // see the comment block at the top of the file. Same for WebPair.

  // -------- desktop-pair-init (anonymous) --------
  app.post("/devices/desktop-pair-init", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    if (!(await ensureAppsEnabled(reply, req))) return;
    _purgeExpiredDesktopPairs();
    // 8 uppercase-alphanumeric chars (~40 bits entropy) — enough for
    // a 5-minute window with rate limit. Skip I/O/L/0/1 for visual
    // unambiguity (in case anyone reads + types it manually).
    const { randomBytes } = await import("node:crypto");
    const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    const bytes = randomBytes(8);
    let code = "";
    for (const b of bytes) code += ALPHABET[b % ALPHABET.length];
    const now = Date.now();
    desktopPairs.set(code, {
      code,
      status: "pending",
      createdAt: now,
      expiresAt: now + DESKTOP_PAIR_TTL_MS,
    });
    const serverUrl = env.PUBLIC_BASE_URL.replace(/\/$/, "");
    return reply.send({
      code,
      approveUrl: `${serverUrl}/desktop-pair/${code}`,
      expiresAt: new Date(now + DESKTOP_PAIR_TTL_MS).toISOString(),
    });
  });

  // -------- desktop-pair-status (anonymous, polled by desktop) --------
  app.get<{ Querystring: { code?: string } }>("/devices/desktop-pair-status", {
    config: { rateLimit: { max: 600, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    _purgeExpiredDesktopPairs();
    const code = (req.query?.code ?? "").toString().trim().toUpperCase();
    if (!code) return reply.code(400).send({ error: "missing_code" });
    const p = desktopPairs.get(code);
    if (!p) return reply.code(404).send({ status: "expired" });
    if (p.status === "denied") {
      desktopPairs.delete(code);
      return reply.code(410).send({ status: "denied" });
    }
    if (p.status === "pending") {
      return reply.code(202).send({ status: "pending" });
    }
    // Approved — return tokens ONCE then delete (single use).
    const out = {
      status: "approved",
      accessToken: p.accessToken!,
      accessTokenExpiresAt: p.accessTokenExpiresAt?.toISOString(),
      refreshToken: p.refreshToken!,
      deviceId: p.deviceId!,
      userId: p.userId!,
      userEmail: p.userEmail,
      userName: p.userName,
    };
    desktopPairs.delete(code);
    return reply.send(out);
  });

  // -------- desktop-pair browser-side approve page --------
  // GET /desktop-pair/:code + POST .../approve + POST .../deny live in
  // pairPageRoutes() below (registered at root, NOT under /api/v1) so a
  // phone camera scanning the QR-encoded URL actually resolves them.

  // -------- desktop-pair approve via native APP (Bearer auth) --------
  // Phone APP scans desktop's QR — which encodes
  // https://<server>/desktop-pair/<CODE> — extracts CODE, posts here
  // with its Bearer access token. We approve on behalf of the APP user
  // without needing them to log in via web again.
  //
  // Same token mint as the cookie-auth /desktop-pair/<code>/approve
  // route; just a different auth method on the way in. Anonymous
  // status poll on the desktop side picks up the approval the same way.
  app.post<{ Body: { code?: string } }>("/devices/desktop-pair-approve", async (req, reply) => {
    if (!(await ensureAppsEnabled(reply, req))) return;
    _purgeExpiredDesktopPairs();
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;

    const code = String(req.body?.code ?? "").toUpperCase().trim();
    if (!code) return reply.code(400).send({ error: "missing_code" });

    // Try desktopPairs first (normal path). Fall back to webPairs so
    // old iOS / Android APP builds — whose scanner regex only matches
    // /desktop-pair/<CODE> — can also approve web 扫码登录 sessions
    // without needing a new APP release. Web QR encodes its URL with
    // the /desktop-pair/ prefix; the code-namespace is shared.
    const desktopP = desktopPairs.get(code);
    if (desktopP) {
      if (desktopP.status !== "pending") {
        return reply.code(409).send({ error: "not_pending", status: desktopP.status });
      }
      const ua = String(req.headers["user-agent"] ?? "").slice(0, 500);
      const refresh = await issueRefreshToken();
      const { upsertDeviceForUser } = await import("../lib/devices.js");
      const device = await upsertDeviceForUser({
        userId: user.id,
        label: "Desktop (Mac/Windows)",
        kind: "desktop",
        appVersion: null,
        clientDeviceId: code,
        refreshHash: refresh.hash,
        refreshPrefix: refresh.prefix,
        ip: req.ip,
        userAgent: ua,
      });
      if (!device) return reply.code(500).send({ error: "device_create_failed" });
      const access = signAccessToken(user.id, device.id);
      desktopP.status = "approved";
      desktopP.userId = user.id;
      desktopP.accessToken = access.token;
      desktopP.accessTokenExpiresAt = access.expiresAt;
      desktopP.refreshToken = refresh.plain;
      desktopP.deviceId = device.id;
      desktopP.userEmail = user.email;
      desktopP.userName = user.displayName;
      // `kind` lets newer mobile builds (iOS v1.4.4+ / Android v0.9.2+)
      // show the correct success copy without relying on URL-prefix
      // sniffing. Older clients ignore unknown fields → no break.
      return reply.send({ ok: true, kind: "desktop" });
    }
    // webPairs fallback. Same approval semantics as POST /devices/
    // web-pair-approve below — just mark the entry approved with the
    // bearer-authenticated user; the browser polling web-pair-status
    // picks it up and plants the cookie session.
    //
    // Why this fallback exists: the web QR encodes a /desktop-pair/<CODE>
    // URL (not /web-pair/<CODE>) so OLD mobile builds — whose scanner
    // regex only matches /desktop-pair/ — recognize it. They post here
    // thinking it's a desktop pair; we look up webPairs by the same
    // code namespace and dispatch correctly. New builds use kind to
    // render "网页端正在登录" instead of the desktop copy.
    const webP = webPairs.get(code);
    if (webP) {
      if (webP.status !== "pending") {
        return reply.code(409).send({ error: "not_pending", status: webP.status });
      }
      if (!(await ensureQrLoginEnabled(reply, req))) return;
      webP.status = "approved";
      webP.userId = user.id;
      return reply.send({ ok: true, kind: "web" });
    }
    return reply.code(404).send({ error: "expired_or_unknown" });
  });

  // ============================================================
  // Web QR-pair (scan-to-login from a browser). Same structure as
  // desktop-pair but lighter — the browser is already a cookie-
  // session host, so the "approve" step just plants a bwc_sid
  // cookie via createSession() and the user lands on /app. No
  // refresh / access tokens involved.
  //
  // Flow:
  //   1. Browser:  POST  /api/v1/devices/web-pair-init       →  { code, approveUrl, expiresAt }
  //   2. Browser:  show QR encoding https://<host>/web-pair/<code>
  //   3. Phone:    scans, opens that URL in browser (cookie auth — already
  //                logged in via web), OR phone APP scans + POSTs
  //                /api/v1/devices/web-pair-approve with bearer token
  //   4. Phone:    renders approve/deny page (web) or auto-approves (APP)
  //   5. Phone:    POST /web-pair/<code>/approve (cookie auth, CSRF)
  //   6. Server:   marks code approved with userId
  //   7. Browser:  GET /api/v1/devices/web-pair-status?code=...
  //                → 200 + { redirectTo: "/app" } AND sets bwc_sid cookie
  //                  (single-use — entry deleted after this call)
  //                → 202 if still pending
  //                → 404 if expired/unknown
  //                → 410 if denied
  //   8. Browser:  follows redirect, lands signed-in.
  //
  // WebPair type + Map + purge helper live at module scope —
  // see the comment block at the top of the file.

  // Master switch for the web 扫码登录 flow. Distinct from
  // ensureAppsEnabled so admins can keep native APPs working while
  // turning off the cross-device QR login on /login. Sends a friendly
  // 403 so the client-side JS in login.ejs can show "管理员已停用扫码登录"
  // instead of a generic error.
  async function ensureQrLoginEnabled(reply: FastifyReply, req?: { log: { warn: (msg: unknown, ...args: unknown[]) => void }; url?: string; ip?: string }): Promise<boolean> {
    const s = await getSettings();
    if (s.qrLoginEnabled) return true;
    if (req) req.log.warn({ event: "qr_login_disabled_block", path: req.url, ip: req.ip }, "QR scan-login blocked: qrLoginEnabled=false. Toggle in admin → API → 网页扫码登录.");
    reply.code(403).send({ error: "qr_login_disabled", message: "管理员已停用网页扫码登录功能。请用密码 / Passkey 登录。" });
    return false;
  }

  // -------- web-pair-init (anonymous — browser starts the QR flow) --------
  // Anonymous because the calling browser has no session yet (that's the
  // whole point). The one-time code IS the proof of authorization once
  // the phone approves. Rate-limited per IP so a stranger can't churn
  // codes faster than 30/min.
  //
  // Gated on TWO flags:
  //   - appsEnabled  (master APP feature) — phone APP needs this to
  //     approve via Bearer; if it's off, the whole flow is pointless.
  //   - qrLoginEnabled (this feature specifically) — admin's explicit
  //     "don't surface QR scan-login on /login" toggle.
  app.post("/devices/web-pair-init", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    if (!(await ensureAppsEnabled(reply, req))) return;
    if (!(await ensureQrLoginEnabled(reply, req))) return;
    _purgeExpiredWebPairs();
    const { randomBytes } = await import("node:crypto");
    // Same alphabet as desktop-pair (visually-unambiguous uppercase). 8
    // chars → ~40 bits of entropy, plenty for a 5-minute window.
    const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    const bytes = randomBytes(8);
    let code = "";
    for (const b of bytes) code += ALPHABET[b % ALPHABET.length];
    const now = Date.now();
    webPairs.set(code, {
      code,
      status: "pending",
      createdAt: now,
      expiresAt: now + WEB_PAIR_TTL_MS,
    });
    const serverUrl = env.PUBLIC_BASE_URL.replace(/\/$/, "");
    // QR-encoded URL uses the /desktop-pair/ prefix instead of /web-pair/
    // — this lets the OLD iOS / Android APP scanner regex (which only
    // matches /desktop-pair/<CODE>) recognize the QR. New APP builds also
    // accept both prefixes; phone-camera browser scans still resolve
    // because /desktop-pair/:code page route dispatches webPairs lookups
    // when the code isn't in desktopPairs (see the page handler below).
    // Trade-off: code namespace is shared between desktop and web pairs,
    // but collisions are astronomically rare with 8-char [A-Z0-9] codes.
    const approveUrl = `${serverUrl}/desktop-pair/${code}`;
    // Pre-render the QR server-side as SVG so the login page doesn't
    // need a JS QR library bundled. Margin 1 for tight quiet zone;
    // EC level M is enough — short URL, low chance of scan artifacts.
    const qrSvg = await QRCode.toString(approveUrl, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    return reply.send({
      code,
      approveUrl,
      qrSvg,
      expiresAt: new Date(now + WEB_PAIR_TTL_MS).toISOString(),
    });
  });

  // -------- web-pair-status (anonymous, polled by browser) --------
  // CRITICAL: on approval this call plants the bwc_sid cookie via
  // createSession() so the browser lands fully signed in. That means
  // the polling browser MUST be the same one that called init — but
  // we don't enforce that with a "init token" because the random
  // 8-char code itself is the proof (40 bits, 5min TTL, single-use).
  // An attacker who steals the code from another browser's network
  // tab could redeem it — same threat model as the desktop-pair flow.
  app.get<{ Querystring: { code?: string } }>("/devices/web-pair-status", {
    config: { rateLimit: { max: 600, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    if (!(await ensureQrLoginEnabled(reply, req))) return;
    _purgeExpiredWebPairs();
    const code = (req.query?.code ?? "").toString().trim().toUpperCase();
    if (!code) return reply.code(400).send({ error: "missing_code" });
    const p = webPairs.get(code);
    if (!p) return reply.code(404).send({ status: "expired" });
    if (p.status === "denied") {
      webPairs.delete(code);
      return reply.code(410).send({ status: "denied" });
    }
    if (p.status === "pending") {
      return reply.code(202).send({ status: "pending" });
    }
    // Approved — plant the session cookie and tell the browser where
    // to go. Single-use: delete the entry so a second status poll
    // (e.g. from a different tab that grabbed the code) returns 404.
    if (!p.userId) {
      // Shouldn't happen — approved without userId is a server bug.
      webPairs.delete(code);
      return reply.code(500).send({ status: "internal_error" });
    }
    // Look up the user so we can:
    //   - confirm the account is still active (admin may have suspended
    //     it between approval and the polling browser's next tick)
    //   - decide mfaSatisfied: the phone-side session that approved this
    //     pair was already MFA-verified, so we trust it.
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, p.userId)).limit(1);
    if (!user || !userIsActive(user)) {
      webPairs.delete(code);
      return reply.code(403).send({ status: "account_disabled" });
    }
    await createSession(reply, user.id, { mfaSatisfied: true });
    const { setThemeCookies } = await import("../lib/user_theme.js");
    setThemeCookies(reply, user.themePalette, user.themeDensity);
    // Fire-and-forget the security-conscious notifications. Don't block
    // the response — the user already sees the redirect.
    void (async () => {
      try {
        const { recordLoginEvent } = await import("../lib/login_history.js");
        await recordLoginEvent(req, user.id, "qr");
      } catch (err) { req.log.warn({ err }, "qr_login_event_failed"); }
    })();
    void (async () => {
      try {
        const { notifyLoginSuccess } = await import("../lib/login_alert.js");
        await notifyLoginSuccess(req, user, "qr");
      } catch (err) { req.log.warn({ err }, "qr_login_alert_failed"); }
    })();
    webPairs.delete(code);
    return reply.send({ status: "approved", redirectTo: "/app" });
  });

  // -------- web-pair browser-side approve page --------
  // GET /web-pair/:code + POST .../approve + POST .../deny live in
  // pairPageRoutes() below (registered at root, NOT under /api/v1) so a
  // phone camera scanning the QR-encoded URL actually resolves them.

  // -------- web-pair approve via native APP (Bearer auth) --------
  // Phone APP scans the browser's QR — encoding https://<host>/web-pair/<CODE>
  // — extracts CODE, posts here with its Bearer access token. Approves
  // on behalf of the APP user without bouncing through SFSafariView.
  app.post<{ Body: { code?: string } }>("/devices/web-pair-approve", async (req, reply) => {
    if (!(await ensureAppsEnabled(reply, req))) return;
    if (!(await ensureQrLoginEnabled(reply, req))) return;
    _purgeExpiredWebPairs();
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;

    const code = String(req.body?.code ?? "").toUpperCase().trim();
    if (!code) return reply.code(400).send({ error: "missing_code" });

    const p = webPairs.get(code);
    if (!p) return reply.code(404).send({ error: "expired_or_unknown" });
    if (p.status !== "pending") {
      return reply.code(409).send({ error: "not_pending", status: p.status });
    }
    p.status = "approved";
    p.userId = user.id;
    // `kind` mirrors what /devices/desktop-pair-approve returns, so the
    // mobile success-screen renderer can use the same field regardless
    // of which approve endpoint the client called.
    return reply.send({ ok: true, kind: "web" });
  });
}

/**
 * Page routes for the QR scan-login approve flows. Registered ONCE at
 * the root prefix (NOT under /api or /api/v1) — the QR code on the
 * desktop / browser encodes a bare URL like https://<host>/desktop-pair/
 * <CODE>, and that's what a phone camera (with no app installed) will
 * try to open. If we only registered these under /api/v1, every camera
 * scan got a 404.
 *
 * The route handlers read/write the same module-level `desktopPairs`
 * and `webPairs` Maps that deviceRoutes()'s API endpoints use, so the
 * code created by POST /api/v1/devices/{desktop,web}-pair-init is the
 * same code these page handlers look up.
 */
export async function pairPageRoutes(app: FastifyInstance) {
  // ---- Reusable helper for the「未登录」→ /login redirect chain ----
  async function loadAuthedUser(req: FastifyRequest): Promise<schema.User | null> {
    return loadUserFromRequest(req);
  }

  // ============================================================
  // Desktop QR-pair browser-side approve page
  // ============================================================

  app.get<{ Params: { code: string } }>("/desktop-pair/:code", async (req, reply) => {
    _purgeExpiredDesktopPairs();
    _purgeExpiredWebPairs();
    const code = req.params.code.toUpperCase();
    // The QR-encoded URL for both flows is /desktop-pair/<CODE> (so
    // old APP regexes match — see web-pair-init for rationale). Dispatch
    // here: desktopPairs lookup first; if absent, try webPairs and
    // forward to the web-pair page (which renders the proper template
    // + posts to /web-pair/:code/approve so the bearer-less cookie
    // flow works correctly).
    if (!desktopPairs.has(code) && webPairs.has(code)) {
      return reply.redirect(`/web-pair/${code}`);
    }
    const p = desktopPairs.get(code);
    const user = await loadAuthedUser(req);
    if (!user) {
      const back = encodeURIComponent(`/desktop-pair/${code}`);
      return reply.redirect(`/login?return_to=${back}`);
    }
    const siteName = (await getSettings()).siteName || "ByWave Calendar";
    // flash: null — partials/flash.ejs guards on `flash && ...`, but
    // layout.ejs references `flash` directly so the locals object MUST
    // contain the key, else EJS throws "flash is not defined".
    if (!p) {
      return reply.view("desktop-pair", {
        title: tr(req, "page.desktopSignIn"), state: "expired", user,
        csrfToken: csrfTokenFor(req), siteName, flash: null,
      });
    }
    if (p.status !== "pending") {
      return reply.view("desktop-pair", {
        title: tr(req, "page.desktopSignIn"),
        state: p.status === "approved" ? "already_approved" : "denied",
        user, csrfToken: csrfTokenFor(req), siteName, flash: null,
      });
    }
    return reply.view("desktop-pair", {
      title: tr(req, "page.desktopSignIn"), state: "pending", code, user,
      csrfToken: csrfTokenFor(req), siteName, flash: null,
    });
  });

  app.post<{ Params: { code: string } }>("/desktop-pair/:code/approve", async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    if (!(await siteAppsEnabled())) {
      return reply.code(403).type("text/html").send(
        `<p>${tr(req, "errorPage.appsDisabled.heading")}. ${tr(req, "errorPage.appsDisabled.message")}</p>`,
      );
    }
    _purgeExpiredDesktopPairs();
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const code = req.params.code.toUpperCase();
    const p = desktopPairs.get(code);
    if (!p) return reply.redirect(`/desktop-pair/${code}`);
    if (p.status !== "pending") return reply.redirect(`/desktop-pair/${code}`);

    const ua = String(req.headers["user-agent"] ?? "").slice(0, 500);
    const refresh = await issueRefreshToken();
    const { upsertDeviceForUser } = await import("../lib/devices.js");
    const device = await upsertDeviceForUser({
      userId: user.id,
      label: "Desktop (Mac/Windows)",
      kind: "desktop",
      appVersion: null,
      clientDeviceId: code,
      refreshHash: refresh.hash,
      refreshPrefix: refresh.prefix,
      ip: req.ip,
      userAgent: ua,
    });
    if (!device) return reply.code(500).send({ error: "device_create_failed" });
    const access = signAccessToken(user.id, device.id);

    p.status = "approved";
    p.userId = user.id;
    p.accessToken = access.token;
    p.accessTokenExpiresAt = access.expiresAt;
    p.refreshToken = refresh.plain;
    p.deviceId = device.id;
    p.userEmail = user.email;
    p.userName = user.displayName;

    return reply.redirect(`/desktop-pair/${code}`);
  });

  app.post<{ Params: { code: string } }>("/desktop-pair/:code/deny", async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    _purgeExpiredDesktopPairs();
    // 丢弃返回值会让 TypeScript 沉默，所以这里显式判空（漏掉的话未认证请求会执行下面的副作用）。
    if (!(await requireUserOrSend(req, reply))) return reply;
    const code = req.params.code.toUpperCase();
    const p = desktopPairs.get(code);
    if (p && p.status === "pending") p.status = "denied";
    return reply.redirect(`/desktop-pair/${code}`);
  });

  // ============================================================
  // Web QR-pair browser-side approve page
  // ============================================================

  app.get<{ Params: { code: string } }>("/web-pair/:code", async (req, reply) => {
    // ensureQrLoginEnabled lives inside deviceRoutes(); here we inline
    // the same check using the shared site-settings helper.
    if (!(await siteQrLoginEnabled())) {
      return reply.code(403).type("text/html").send(
        `<p>${tr(req, "login.qrAdminDisabled")}</p>`,
      );
    }
    _purgeExpiredWebPairs();
    const code = req.params.code.toUpperCase();
    const p = webPairs.get(code);
    const user = await loadAuthedUser(req);
    if (!user) {
      const back = encodeURIComponent(`/web-pair/${code}`);
      return reply.redirect(`/login?return_to=${back}`);
    }
    const siteName = (await getSettings()).siteName || "ByWave Calendar";
    // flash: null — required by layout.ejs (see desktop-pair branch above).
    if (!p) {
      return reply.view("web-pair", {
        title: tr(req, "page.webQrSignIn"), state: "expired", user,
        csrfToken: csrfTokenFor(req), siteName, flash: null,
      });
    }
    if (p.status !== "pending") {
      return reply.view("web-pair", {
        title: tr(req, "page.webQrSignIn"),
        state: p.status === "approved" ? "already_approved" : "denied",
        user, csrfToken: csrfTokenFor(req), siteName, flash: null,
      });
    }
    return reply.view("web-pair", {
      title: tr(req, "page.webQrSignIn"), state: "pending", code, user,
      csrfToken: csrfTokenFor(req), siteName, flash: null,
    });
  });

  app.post<{ Params: { code: string } }>("/web-pair/:code/approve", async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    _purgeExpiredWebPairs();
    const user = await requireUserOrSend(req, reply);
    if (!user) return reply;
    const code = req.params.code.toUpperCase();
    const p = webPairs.get(code);
    if (!p) return reply.redirect(`/web-pair/${code}`);
    if (p.status !== "pending") return reply.redirect(`/web-pair/${code}`);
    p.status = "approved";
    p.userId = user.id;
    return reply.redirect(`/web-pair/${code}`);
  });

  app.post<{ Params: { code: string } }>("/web-pair/:code/deny", async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    _purgeExpiredWebPairs();
    // 丢弃返回值会让 TypeScript 沉默，所以这里显式判空（漏掉的话未认证请求会执行下面的副作用）。
    if (!(await requireUserOrSend(req, reply))) return reply;
    const code = req.params.code.toUpperCase();
    const p = webPairs.get(code);
    if (p && p.status === "pending") p.status = "denied";
    return reply.redirect(`/web-pair/${code}`);
  });
}
