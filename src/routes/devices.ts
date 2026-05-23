// REST endpoints for the native-app device pairing flow.
//
// /api/v1/devices/pair-init     (auth required — web session or bearer)
//   user clicks "pair new device" → we return a fresh code + QR data.
// /api/v1/devices/pair-claim    (no auth — code IS the auth)
//   the phone POSTs the scanned code → we issue refresh + access tokens.
// /api/v1/auth/refresh          (no auth — refresh token IS the auth)
//   the phone trades a refresh token for a fresh access JWT.
// /api/v1/devices               (auth — list / revoke own devices)
// /api/v1/devices/me            (auth — what device am I, if I'm a bearer-bound app)

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import QRCode from "qrcode";
import { eq } from "drizzle-orm";
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
async function ensureAppsEnabled(reply: FastifyReply): Promise<boolean> {
  const s = await getSettings();
  if (s.appsEnabled) return true;
  reply.code(403).send({ error: "apps_disabled", message: "管理员已停用 APP 同步" });
  return false;
}

export async function deviceRoutes(app: FastifyInstance) {
  // -------- pair-init (web user starts the QR flow) --------
  // We accept any authed user (cookie or bearer). The response carries
  // both the structured payload (for the app to consume after scan) and
  // an SVG-encoded QR for the web page to drop in directly.
  app.post("/devices/pair-init", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!(await ensureAppsEnabled(reply))) return;
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
    if (!(await ensureAppsEnabled(reply))) return;
    const body = z.object({
      code: z.string().min(4).max(20),
      label: z.string().min(1).max(60),
      kind: z.enum(["ios", "android", "desktop", "other"]).default("other"),
      appVersion: z.string().max(40).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });

    const ua = String(req.headers["user-agent"] ?? "").slice(0, 500);
    const result = await claimPairing({
      code: body.data.code.trim().toUpperCase(),
      label: body.data.label,
      kind: body.data.kind,
      appVersion: body.data.appVersion ?? null,
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
    if (!(await ensureAppsEnabled(reply))) return;
    const body = z.object({
      email: z.string().email().max(254).transform((s) => s.toLowerCase().trim()),
      password: z.string().min(1).max(200),
      label: z.string().min(1).max(60),
      kind: z.enum(["ios", "android", "desktop", "other"]).default("other"),
      appVersion: z.string().max(40).optional(),
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

    // Create the device row + tokens.
    const refresh = await issueRefreshToken();
    const ua = String(req.headers["user-agent"] ?? "").slice(0, 500);
    const [device] = await db.insert(schema.devices).values({
      userId: user.id,
      label: body.data.label.trim(),
      kind: body.data.kind,
      refreshTokenHash: refresh.hash,
      refreshTokenPrefix: refresh.prefix,
      appVersion: body.data.appVersion ?? null,
      firstSeenIp: req.ip,
      firstUserAgent: ua,
      lastSeenAt: new Date(),
      lastSeenIp: req.ip,
    }).returning();
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
    if (!(await ensureAppsEnabled(reply))) return;
    const body = z.object({ refreshToken: z.string().min(20).max(80) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const result = await refreshAccessToken({ refreshToken: body.data.refreshToken, ip: req.ip });
    if (!result) return reply.code(401).send({ error: "invalid_refresh_token" });
    return reply.send({
      accessToken: result.accessToken,
      accessTokenExpiresAt: result.expiresAt.toISOString(),
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
