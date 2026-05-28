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
import { requireUser, loadUserFromRequest, createSession } from "../lib/session.js";
import { csrfTokenFor, verifyCsrf } from "../lib/csrf.js";
import { env } from "../env.js";
import { getSettings } from "../lib/site_settings.js";
import { verifyPassword, verifyPasswordTimingSafe } from "../lib/password.js";
import { isLocked, recordFailedLogin, resetFailedLogin } from "../lib/login_lockout.js";
import { userIsActive } from "../lib/user_state.js";
import { issueRefreshToken, signAccessToken } from "../lib/device_tokens.js";
import {
  initPairing,
  claimPairing,
  refreshAccessToken,
  listDevicesForUser,
  revokeDevice,
} from "../lib/devices.js";

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

export async function deviceRoutes(app: FastifyInstance) {
  // -------- pair-init (web user starts the QR flow) --------
  // We accept any authed user (cookie or bearer). The response carries
  // both the structured payload (for the app to consume after scan) and
  // an SVG-encoded QR for the web page to drop in directly.
  app.post("/devices/pair-init", async (req, reply) => {
    const user = await requireUser(req, reply);
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
    const user = await requireUser(req, reply);
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
    const user = await requireUser(req, reply);
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
    const user = await requireUser(req, reply);
    if (!user) return;
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
    const user = await requireUser(req, reply);
    if (!user) return;
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
    const user = await requireUser(req, reply);
    if (!user) return;
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
    const user = await requireUser(req, reply);
    if (!user) return;
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
    // Re-using the existing security-change email + invalidating sessions
    // is intentional — change-password should kick all other clients out.
    // The CURRENT device's refresh token stays valid (we don't touch
    // the devices table here), so the APP can keep working. Other web
    // sessions and other devices get 401 on next call.
    const { sendMail } = await import("../lib/mailer.js");
    const { securityChangeMail } = await import("../lib/email_templates.js");
    void sendMail(securityChangeMail(user.email, { kind: "password_changed" }))
      .catch((err) => req.log.warn({ err }, "password_change_mail_failed"));
    const { destroyAllUserSessions } = await import("../lib/session.js");
    await destroyAllUserSessions(user.id);
    return reply.send({ ok: true });
  });

  app.post("/account/delete", {
    config: { rateLimit: { max: 3, timeWindow: "5 minutes" } },
  }, async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const body = z.object({
      password: z.string().min(1).max(200),
      confirm: z.literal("删除我的账号"),
    }).safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "bad_confirmation", message: "请输入密码并精确输入「删除我的账号」以确认" });
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
    const user = await requireUser(req, reply);
    if (!user) return;
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
    const user = await requireUser(req, reply);
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
    const user = await requireUser(req, reply);
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
    const user = await requireUser(req, reply);
    if (!user) return;

    const code = String(req.body?.code ?? "").toUpperCase().trim();
    if (!code) return reply.code(400).send({ error: "missing_code" });

    const p = desktopPairs.get(code);
    if (!p) return reply.code(404).send({ error: "expired_or_unknown" });
    if (p.status !== "pending") {
      return reply.code(409).send({ error: "not_pending", status: p.status });
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

    p.status = "approved";
    p.userId = user.id;
    p.accessToken = access.token;
    p.accessTokenExpiresAt = access.expiresAt;
    p.refreshToken = refresh.plain;
    p.deviceId = device.id;
    p.userEmail = user.email;
    p.userName = user.displayName;

    return reply.send({ ok: true });
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
    const approveUrl = `${serverUrl}/web-pair/${code}`;
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
    const user = await requireUser(req, reply);
    if (!user) return;

    const code = String(req.body?.code ?? "").toUpperCase().trim();
    if (!code) return reply.code(400).send({ error: "missing_code" });

    const p = webPairs.get(code);
    if (!p) return reply.code(404).send({ error: "expired_or_unknown" });
    if (p.status !== "pending") {
      return reply.code(409).send({ error: "not_pending", status: p.status });
    }
    p.status = "approved";
    p.userId = user.id;
    return reply.send({ ok: true });
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
    const code = req.params.code.toUpperCase();
    const p = desktopPairs.get(code);
    const user = await loadAuthedUser(req);
    if (!user) {
      const back = encodeURIComponent(`/desktop-pair/${code}`);
      return reply.redirect(`/login?return_to=${back}`);
    }
    const siteName = (await getSettings()).siteName || "ByWave Calendar";
    if (!p) {
      return reply.view("desktop-pair", {
        title: "桌面端登录", state: "expired", user,
        csrfToken: csrfTokenFor(req), siteName,
      });
    }
    if (p.status !== "pending") {
      return reply.view("desktop-pair", {
        title: "桌面端登录",
        state: p.status === "approved" ? "already_approved" : "denied",
        user, csrfToken: csrfTokenFor(req), siteName,
      });
    }
    return reply.view("desktop-pair", {
      title: "桌面端登录", state: "pending", code, user,
      csrfToken: csrfTokenFor(req), siteName,
    });
  });

  app.post<{ Params: { code: string } }>("/desktop-pair/:code/approve", async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    if (!(await siteAppsEnabled())) {
      return reply.code(403).type("text/html").send(
        "<p>管理员已停用 APP 同步。请联系管理员后再试。</p>",
      );
    }
    _purgeExpiredDesktopPairs();
    const user = await requireUser(req, reply);
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
    await requireUser(req, reply);
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
        "<p>管理员已停用网页扫码登录功能。请用密码或 Passkey 登录。</p>",
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
    if (!p) {
      return reply.view("web-pair", {
        title: "网页扫码登录", state: "expired", user,
        csrfToken: csrfTokenFor(req), siteName,
      });
    }
    if (p.status !== "pending") {
      return reply.view("web-pair", {
        title: "网页扫码登录",
        state: p.status === "approved" ? "already_approved" : "denied",
        user, csrfToken: csrfTokenFor(req), siteName,
      });
    }
    return reply.view("web-pair", {
      title: "网页扫码登录", state: "pending", code, user,
      csrfToken: csrfTokenFor(req), siteName,
    });
  });

  app.post<{ Params: { code: string } }>("/web-pair/:code/approve", async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    _purgeExpiredWebPairs();
    const user = await requireUser(req, reply);
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
    await requireUser(req, reply);
    const code = req.params.code.toUpperCase();
    const p = webPairs.get(code);
    if (p && p.status === "pending") p.status = "denied";
    return reply.redirect(`/web-pair/${code}`);
  });
}
