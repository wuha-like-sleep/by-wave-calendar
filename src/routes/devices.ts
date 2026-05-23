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

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import QRCode from "qrcode";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { requireUser } from "../lib/session.js";
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
    });
  });

  // -------- password login (alternative to QR pairing) --------
  // For users who'd rather type email+password than scan a QR. Same
  // safeguards as the web login flow:
  //   - Disabled-account check
  //   - Login lockout (15min after 5 failures)
  //   - Timing-safe verify so non-existent emails don't leak
  // Refuses when MFA is enabled — we don't expose a phone-typed TOTP
  // path yet; users with MFA must use QR pairing (where they're
  // already authenticated on the web with MFA satisfied).
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

    // MFA gate — refuse password login when MFA is on. The user has to
    // do QR pairing instead (where they sign in with MFA on the web).
    // We don't surface TOTP-on-phone yet; can add a later iteration if
    // there's demand.
    if (user.mfaEnabled) {
      return reply.code(412).send({
        error: "mfa_required",
        message: "你的账号开启了二次验证。请改用「扫码登录」：在网页 /app/settings 里点「绑定新设备」",
      });
    }

    // Create the device row + tokens (or reuse existing one for the same
    // clientDeviceId — see upsertDeviceForUser).
    const refresh = await issueRefreshToken();
    const ua = String(req.headers["user-agent"] ?? "").slice(0, 500);
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
}
