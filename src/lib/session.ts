import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { newSessionId } from "./ids.js";
import { env } from "../env.js";

const COOKIE_NAME = "bwc_sid";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
// "Remember me" sessions stick for 30 days.
const SESSION_TTL_MS = 30 * ONE_DAY_MS;
// Transient ("one-time") sessions get a 1-day server-side backstop so
// abandoned rows get pruned, but the browser cookie itself is a session
// cookie (no expires attribute) so most browsers drop it on close. The
// 1-day DB TTL is the safety net for browsers that "restore last session"
// across restarts and for tab/browser variants that hold cookies longer.
const SESSION_TRANSIENT_TTL_MS = 1 * ONE_DAY_MS;

export async function createSession(
  reply: FastifyReply,
  userId: string,
  opts: { mfaSatisfied?: boolean; rememberMe?: boolean } = {},
): Promise<string> {
  const id = newSessionId();
  // Default rememberMe=true preserves the pre-checkbox behavior for all
  // call sites we haven't audited (SSO, register, native-bridge, etc.).
  // Web /login form passes false when the user leaves the box unchecked.
  const rememberMe = opts.rememberMe ?? true;
  const ttl = rememberMe ? SESSION_TTL_MS : SESSION_TRANSIENT_TTL_MS;
  const expiresAt = new Date(Date.now() + ttl);
  await db.insert(schema.sessions).values({
    id,
    userId,
    expiresAt,
    mfaSatisfied: opts.mfaSatisfied ?? true,
  });
  // Cookie shape:
  //   rememberMe=true  → persistent cookie with expires=<30d>
  //   rememberMe=false → session cookie (no expires/maxAge), deleted on
  //                      browser close per the cookie spec. We still
  //                      flag httpOnly + secure + sameSite=lax + signed.
  const cookieOpts: Parameters<FastifyReply["setCookie"]>[2] = {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    signed: true,
  };
  if (rememberMe) cookieOpts.expires = expiresAt;
  reply.setCookie(COOKIE_NAME, id, cookieOpts);
  return id;
}

export async function destroySession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const raw = req.cookies[COOKIE_NAME];
  if (raw) {
    const unsigned = req.unsignCookie(raw);
    if (unsigned.valid && unsigned.value) {
      await db.delete(schema.sessions).where(eq(schema.sessions.id, unsigned.value));
    }
  }
  reply.clearCookie(COOKIE_NAME, { path: "/" });
}

export async function destroyAllUserSessions(userId: string): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
}

export async function markSessionMfaSatisfied(req: FastifyRequest): Promise<void> {
  const raw = req.cookies[COOKIE_NAME];
  if (!raw) return;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return;
  await db
    .update(schema.sessions)
    .set({ mfaSatisfied: true })
    .where(eq(schema.sessions.id, unsigned.value));
}

export type LoadedSession = {
  user: schema.User;
  sessionId: string;
  mfaSatisfied: boolean;
};

export async function loadSession(req: FastifyRequest): Promise<LoadedSession | null> {
  const raw = req.cookies[COOKIE_NAME];
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;

  const rows = await db
    .select({
      user: schema.users,
      expiresAt: schema.sessions.expiresAt,
      mfaSatisfied: schema.sessions.mfaSatisfied,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(eq(schema.sessions.id, unsigned.value))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) {
    await db.delete(schema.sessions).where(eq(schema.sessions.id, unsigned.value));
    return null;
  }
  // Suspended account: drop the session entirely so the admin's "stop this
  // user" intent is immediate even for already-logged-in tabs.
  if (row.user.disabledAt) {
    await db.delete(schema.sessions).where(eq(schema.sessions.id, unsigned.value));
    return null;
  }
  return { user: row.user, sessionId: unsigned.value, mfaSatisfied: row.mfaSatisfied };
}

export async function loadUserFromRequest(req: FastifyRequest): Promise<schema.User | null> {
  const s = await loadSession(req);
  if (!s) return null;
  if (s.user.mfaEnabled && !s.mfaSatisfied) return null;
  return s.user;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: schema.User;
  }
}

export async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<schema.User> {
  if (req.user) return req.user;

  // 1) Bearer token (third-party API integration). Only honored when admin
  //    has enabled the API feature in /admin/api. Successful auth bypasses
  //    CSRF since the caller isn't a browser running with our cookies.
  //
  //    Two token formats are accepted:
  //      bwc_*  — admin-issued API token (long-lived, full account scope)
  //      bwo_*  — OAuth 2.0 access token (user-granted, scope-restricted)
  const auth = String(req.headers.authorization || "");
  if (auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    const { db, schema: s } = await import("../db/client.js");
    const { eq } = await import("drizzle-orm");

    // Try OAuth access token first (cheap looksLike check).
    const { looksLikeOAuthToken, verifyOAuthToken, touchOAuthToken } = await import("./oauth_server.js");
    if (looksLikeOAuthToken(token)) {
      const verified = await verifyOAuthToken(token);
      if (verified) {
        const [u] = await db.select().from(s.users).where(eq(s.users.id, verified.userId)).limit(1);
        if (u) {
          req.user = u;
          void touchOAuthToken(verified.tokenId).catch(() => undefined);
          (req as unknown as { authVia: string; oauthScopes: string[] }).authVia = "oauth";
          (req as unknown as { oauthScopes: string[] }).oauthScopes = verified.scopes;
          return u;
        }
      }
      reply.code(401).send({ error: "invalid_token" });
      throw new Error("invalid_token");
    }

    const { looksLikeApiToken, verifyApiToken, touchApiToken } = await import("./api_token.js");
    if (looksLikeApiToken(token)) {
      const verified = await verifyApiToken(token);
      if (verified) {
        const [u] = await db.select().from(s.users).where(eq(s.users.id, verified.userId)).limit(1);
        if (u) {
          req.user = u;
          void touchApiToken(verified.tokenId, req.ip).catch(() => undefined);
          // Tag the request so downstream handlers can tell session vs API.
          (req as unknown as { authVia: string }).authVia = "api_token:" + verified.scope;
          return u;
        }
      }
      reply.code(401).send({ error: "invalid_token" });
      throw new Error("invalid_token");
    }

    // External IdP (Keycloak) access token — ByWave as OAuth resource server.
    // Keycloak access tokens are RS256 JWTs that also start with "eyJ", so they
    // match the device-token regex below; we MUST resolve them here first.
    // resolveExternalIdpUser returns matched:false unless the token's `iss`
    // equals a configured SSO provider issuer, so our own device JWTs fall
    // straight through to the device path.
    if (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) {
      const { resolveExternalIdpUser } = await import("./external_idp.js");
      const res = await resolveExternalIdpUser(token, req);
      if (res.matched) {
        if (res.user) {
          req.user = res.user;
          (req as unknown as { authVia: string }).authVia = "idp:" + res.provider;
          // Tag service-client (cross-account) access so the onResponse hook can
          // log every mutation for forensics — this is the most powerful auth
          // path, so its writes must leave a trail.
          if (res.serviceClient) {
            (req as unknown as { idpServiceClient?: string; idpActedAs?: string }).idpServiceClient = res.serviceClient;
            (req as unknown as { idpActedAs?: string }).idpActedAs = res.user.email;
          }
          // Auto-provisioning a real account is significant + infrequent →
          // record it in the admin audit log (not just server logs).
          if (res.provisioned) {
            const { audit } = await import("./audit.js");
            void audit(req, res.user.id, "idp.account_provisioned", {
              targetType: "user", targetId: res.user.id,
              details: { client: res.serviceClient, email: res.user.email },
            }).catch(() => undefined);
          }
          return res.user;
        }
        reply.code(res.code).send({ error: res.error });
        throw new Error(res.error);
      }
      // matched:false → not one of our IdPs; fall through to device-token path.
    }

    // Device access token (JWT, HS256 — issued via /api/v1/devices/pair-claim
    // or /api/v1/auth/refresh). Used by native iOS / Android / desktop apps.
    // The token's `did` claim points to a `devices` row — if that row was
    // revoked we reject regardless of signature/expiry, so admin revokes
    // take effect within 1 hour (the JWT TTL) at worst.
    //
    // Also gated by site_settings.appsEnabled: when admin turns off the
    // APP feature, even valid+unexpired JWTs stop working immediately.
    const { looksLikeAccessToken, verifyAccessToken } = await import("./device_tokens.js");
    if (looksLikeAccessToken(token)) {
      const { getSettings } = await import("./site_settings.js");
      const settings = await getSettings();
      if (!settings.appsEnabled) {
        reply.code(403).send({ error: "apps_disabled" });
        throw new Error("apps_disabled");
      }
      const payload = verifyAccessToken(token);
      if (payload) {
        const { loadDeviceById } = await import("./devices.js");
        const device = await loadDeviceById(payload.did);
        if (device && device.userId === payload.sub) {
          const [u] = await db.select().from(s.users).where(eq(s.users.id, payload.sub)).limit(1);
          const { userIsActive } = await import("./user_state.js");
          if (u && userIsActive(u)) {
            req.user = u;
            (req as unknown as { authVia: string; deviceId: string }).authVia = "device:" + device.kind;
            (req as unknown as { deviceId: string }).deviceId = device.id;
            return u;
          }
        }
      }
      reply.code(401).send({ error: "invalid_token" });
      throw new Error("invalid_token");
    }
  }

  // 2) Session cookie (normal browser flow).
  const user = await loadUserFromRequest(req);
  if (!user) {
    reply.code(401).send({ error: "unauthorized" });
    throw new Error("unauthorized");
  }
  req.user = user;
  return user;
}
