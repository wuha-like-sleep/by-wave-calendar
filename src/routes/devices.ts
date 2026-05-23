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

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import QRCode from "qrcode";
import { requireUser } from "../lib/session.js";
import { env } from "../env.js";
import {
  initPairing,
  claimPairing,
  refreshAccessToken,
  listDevicesForUser,
  revokeDevice,
} from "../lib/devices.js";

export async function deviceRoutes(app: FastifyInstance) {
  // -------- pair-init (web user starts the QR flow) --------
  // We accept any authed user (cookie or bearer). The response carries
  // both the structured payload (for the app to consume after scan) and
  // an SVG-encoded QR for the web page to drop in directly.
  app.post("/devices/pair-init", async (req, reply) => {
    const user = await requireUser(req, reply);
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

  // -------- refresh access token --------
  // Phone hits this on 401 or when its cached access token is near expiry.
  app.post("/auth/refresh", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
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
