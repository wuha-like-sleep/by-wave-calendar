// OAuth 2.0 authorization server routes (we are the IdP). Three
// endpoints make up the dance:
//
//   GET  /oauth/authorize  — consent screen + auth code issuance
//   POST /oauth/token      — exchange code for access token
//   GET  /oauth/userinfo   — OpenID-style "who am I" introspection
//
// For an end-to-end walkthrough see the /admin/oauth-apps "如何接入"
// section, which the admin UI links to.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { loadSession } from "../lib/session.js";
import { csrfTokenFor, verifyCsrf } from "../lib/csrf.js";
import { tForRequest } from "../lib/i18n.js";
import {
  findClientByClientId,
  issueAuthorizationCode,
  exchangeCodeForToken,
  OAUTH_SCOPES,
} from "../lib/oauth_server.js";

const authorizeQuery = z.object({
  client_id: z.string(),
  redirect_uri: z.string().url(),
  response_type: z.literal("code"),
  scope: z.string().optional(),
  state: z.string().optional(),
  code_challenge: z.string().optional(),
  code_challenge_method: z.literal("S256").optional(),
});

/** Request-scoped translate for route handlers — flash messages, page
 *  titles, error-view copy. Locale comes from `req.locale`, stashed by the
 *  view-locals hook in src/server.ts. See tForRequest in src/lib/i18n.ts. */
function tr(req: FastifyRequest, key: string, vars?: Record<string, string | number>): string {
  return tForRequest(req)(key, vars);
}

export async function oauthServerRoutes(app: FastifyInstance) {
  // GET /oauth/authorize — consent screen. If the user isn't logged in,
  // redirect them to /login with a return-to so they bounce back here.
  app.get("/oauth/authorize", async (req, reply) => {
    const q = authorizeQuery.safeParse(req.query);
    if (!q.success) {
      return reply.code(400).view("error", {
        title: tr(req, "page.oauthError"), user: null, csrfToken: csrfTokenFor(req), flash: {},
        statusCode: 400, heading: tr(req, "errorPage.oauth.badRequestHeading"),
        message: tr(req, "errorPage.oauth.badRequestMessage"),
      });
    }

    const client = await findClientByClientId(q.data.client_id);
    if (!client || !client.enabled) {
      return reply.code(400).view("error", {
        title: tr(req, "page.oauthError"), user: null, csrfToken: csrfTokenFor(req), flash: {},
        statusCode: 400, heading: tr(req, "errorPage.oauth.unknownClientHeading"),
        message: tr(req, "errorPage.oauth.unknownClientMessage", { clientId: q.data.client_id }),
      });
    }

    // Strict redirect_uri equality check (no substring/regex — too easy
    // to slip an open-redirect past).
    const allowed = client.redirectUris.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!allowed.includes(q.data.redirect_uri)) {
      return reply.code(400).view("error", {
        title: tr(req, "page.oauthError"), user: null, csrfToken: csrfTokenFor(req), flash: {},
        statusCode: 400, heading: tr(req, "errorPage.oauth.redirectUriHeading"),
        message: tr(req, "errorPage.oauth.redirectUriMessage", { name: client.name }),
      });
    }

    // Parse requested scopes; clamp to what the client is allowed to ask for.
    const requested = (q.data.scope || "read:events").split(" ").map((s) => s.trim()).filter(Boolean);
    const allowedScopes = client.allowedScopes as string[];
    const finalScopes = requested.filter((s) => allowedScopes.includes(s));
    if (finalScopes.length === 0) {
      return reply.code(400).view("error", {
        title: tr(req, "page.oauthError"), user: null, csrfToken: csrfTokenFor(req), flash: {},
        statusCode: 400, heading: tr(req, "errorPage.oauth.scopeHeading"),
        message: tr(req, "errorPage.oauth.scopeMessage"),
      });
    }

    // Need to be logged in to consent.
    const session = await loadSession(req);
    if (!session) {
      // Stash the authorize URL in a cookie so /login can bounce back.
      const back = req.url;
      reply.setCookie("bwc_post_login_url", back, {
        path: "/", maxAge: 600, httpOnly: true, sameSite: "lax",
      });
      return reply.redirect("/login?notice=" + encodeURIComponent(tr(req, "flash.oauth.signInToAuthorize", { name: client.name })));
    }

    return reply.view("oauth/consent", {
      title: tr(req, "page.oauthAuthorize", { name: client.name }),
      user: session.user, csrfToken: csrfTokenFor(req), flash: {},
      client: {
        name: client.name,
        description: client.description,
        logoUrl: client.logoUrl,
        clientId: client.clientId,
      },
      scopes: finalScopes.map((s) => ({ name: s, description: (OAUTH_SCOPES as Record<string, string>)[s] || s })),
      // We pass the request params through hidden form fields so the
      // approve POST carries them.
      params: q.data,
      finalScopes,
    });
  });

  // POST /oauth/authorize — user clicked Approve / Deny.
  app.post("/oauth/authorize", async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    const session = await loadSession(req);
    if (!session) return reply.redirect("/login");

    const body = z.object({
      client_id: z.string(),
      redirect_uri: z.string().url(),
      scope: z.string(),
      state: z.string().optional(),
      code_challenge: z.string().optional(),
      decision: z.enum(["approve", "deny"]),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send("bad_request");

    const client = await findClientByClientId(body.data.client_id);
    if (!client || !client.enabled) return reply.code(400).send("invalid_client");

    const allowed = client.redirectUris.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!allowed.includes(body.data.redirect_uri)) return reply.code(400).send("invalid_redirect_uri");

    const sep = body.data.redirect_uri.includes("?") ? "&" : "?";
    if (body.data.decision === "deny") {
      const url = `${body.data.redirect_uri}${sep}error=access_denied${body.data.state ? "&state=" + encodeURIComponent(body.data.state) : ""}`;
      return reply.redirect(url);
    }

    // Approve: issue auth code, redirect to client with code + state.
    const scopes = body.data.scope.split(" ").filter(Boolean);
    const code = await issueAuthorizationCode({
      clientId: client.id,
      userId: session.user.id,
      redirectUri: body.data.redirect_uri,
      scopes,
      codeChallenge: body.data.code_challenge || null,
    });
    const url = `${body.data.redirect_uri}${sep}code=${encodeURIComponent(code)}${body.data.state ? "&state=" + encodeURIComponent(body.data.state) : ""}`;
    return reply.redirect(url);
  });

  // POST /oauth/token — code → access token. Standard OAuth-style form.
  // Accepts client_id+client_secret in body OR Basic Auth header.
  app.post("/oauth/token", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = z.object({
      grant_type: z.literal("authorization_code"),
      code: z.string(),
      redirect_uri: z.string().url(),
      client_id: z.string().optional(),
      client_secret: z.string().optional(),
      code_verifier: z.string().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });

    // Pull credentials: Basic Auth header takes precedence.
    let clientId = body.data.client_id;
    let clientSecret = body.data.client_secret;
    const authHdr = String(req.headers.authorization || "");
    if (authHdr.toLowerCase().startsWith("basic ")) {
      try {
        const decoded = Buffer.from(authHdr.slice(6).trim(), "base64").toString("utf8");
        const idx = decoded.indexOf(":");
        if (idx > 0) {
          clientId = decoded.slice(0, idx);
          clientSecret = decoded.slice(idx + 1);
        }
      } catch { /* fallthrough to body creds */ }
    }
    if (!clientId || !clientSecret) {
      return reply.code(400).send({ error: "invalid_client" });
    }

    const result = await exchangeCodeForToken({
      code: body.data.code,
      clientId,
      clientSecret,
      redirectUri: body.data.redirect_uri,
      codeVerifier: body.data.code_verifier,
    });
    if ("error" in result) {
      return reply.code(400).send({ error: result.error });
    }
    return reply.send({
      access_token: result.accessToken,
      token_type: "Bearer",
      expires_in: result.expiresIn,
      scope: result.scope,
    });
  });

  // GET /oauth/userinfo — sugar for "who is this token" introspection.
  // Bearer-only; works with both OAuth and API tokens (via requireUser
  // chain) but exposes scope info only for OAuth.
  app.get("/oauth/userinfo", async (req, reply) => {
    const { requireUser } = await import("../lib/session.js");
    const user = await requireUser(req, reply);
    const scopes = (req as unknown as { oauthScopes?: string[] }).oauthScopes ?? null;
    return reply.send({
      sub: user.id,
      email: user.email,
      name: user.displayName,
      email_verified: user.emailVerified,
      ...(scopes ? { scope: scopes.join(" ") } : {}),
    });
  });

  // POST /oauth/revoke — user-side revocation. Caller passes their own
  // active token to invalidate it.
  app.post("/oauth/revoke", async (req, reply) => {
    const body = z.object({ token: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const { looksLikeOAuthToken, verifyOAuthToken } = await import("../lib/oauth_server.js");
    if (!looksLikeOAuthToken(body.data.token)) return reply.send({ ok: true });
    const v = await verifyOAuthToken(body.data.token);
    if (!v) return reply.send({ ok: true });
    await db.update(schema.oauthAccessTokens).set({ revokedAt: new Date() }).where(eq(schema.oauthAccessTokens.id, v.tokenId));
    return reply.send({ ok: true });
  });
}
