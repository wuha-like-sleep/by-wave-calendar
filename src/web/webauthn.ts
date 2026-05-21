import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import {
  buildAuthenticationOptions,
  buildRegistrationOptions,
  consumeChallenge,
  newDeviceName,
  storeChallenge,
  verifyAuthentication,
  verifyRegistration,
} from "../lib/webauthn.js";
import { verifyCsrf } from "../lib/csrf.js";
import { createSession, loadSession } from "../lib/session.js";
import { notifyLoginSuccess } from "../lib/login_alert.js";
import { recordLoginEvent } from "../lib/login_history.js";
import { setThemeCookies } from "../lib/user_theme.js";

export async function webauthnRoutes(app: FastifyInstance) {
  // ---- Registration (must be authed) ----
  app.post("/webauthn/register/options", async (req, reply) => {
    const s = await loadSession(req);
    if (!s) return reply.code(401).send({ error: "unauthorized" });
    if (!verifyCsrf(req, reply)) return;

    const existing = await db
      .select({ credentialId: schema.webauthnCredentials.credentialId })
      .from(schema.webauthnCredentials)
      .where(eq(schema.webauthnCredentials.userId, s.user.id));

    const { options, challenge } = await buildRegistrationOptions(
      { id: s.user.id, email: s.user.email, displayName: s.user.displayName },
      existing.map((e) => e.credentialId),
    );

    storeChallenge(reply, { challenge, intent: "register", userId: s.user.id });
    return reply.send(options);
  });

  app.post("/webauthn/register/verify", async (req, reply) => {
    const s = await loadSession(req);
    if (!s) return reply.code(401).send({ error: "unauthorized" });
    if (!verifyCsrf(req, reply)) return;

    const challenge = consumeChallenge(req, reply);
    if (!challenge || challenge.intent !== "register" || challenge.userId !== s.user.id) {
      return reply.code(400).send({ error: "challenge_mismatch" });
    }

    const parsed = z
      .object({ response: z.any(), deviceName: z.string().max(100).optional() })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request" });

    let verification;
    try {
      verification = await verifyRegistration(parsed.data.response, challenge.challenge);
    } catch (err) {
      req.log.warn({ err }, "webauthn_register_failed");
      return reply.code(400).send({ error: "verification_failed" });
    }
    if (!verification.verified || !verification.registrationInfo) {
      return reply.code(400).send({ error: "verification_failed" });
    }

    const info = verification.registrationInfo;
    const credential = info.credential;
    const transportsRaw = parsed.data.response?.response?.transports;
    const transports = Array.isArray(transportsRaw) ? transportsRaw.filter((t) => typeof t === "string") : null;

    await db.insert(schema.webauthnCredentials).values({
      userId: s.user.id,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString("base64url"),
      counter: credential.counter ?? 0,
      transports,
      deviceName: (parsed.data.deviceName?.trim() || newDeviceName()).slice(0, 100),
    });

    return reply.send({ ok: true });
  });

  app.post<{ Params: { id: string } }>("/webauthn/credentials/:id/delete", async (req, reply) => {
    const s = await loadSession(req);
    if (!s) return reply.code(401).send({ error: "unauthorized" });
    if (!verifyCsrf(req, reply)) return;
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return reply.code(400).send({ error: "bad_request" });
    await db
      .delete(schema.webauthnCredentials)
      .where(and(eq(schema.webauthnCredentials.id, id.data), eq(schema.webauthnCredentials.userId, s.user.id)));
    return reply.send({ ok: true });
  });

  // ---- Authentication (no session needed) ----
  app.post("/webauthn/auth/options", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    const body = z.object({ email: z.string().email().optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "bad_request" });

    let allowIds: string[] = [];
    if (body.data.email) {
      const [u] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, body.data.email)).limit(1);
      if (u) {
        const creds = await db
          .select({ credentialId: schema.webauthnCredentials.credentialId })
          .from(schema.webauthnCredentials)
          .where(eq(schema.webauthnCredentials.userId, u.id));
        allowIds = creds.map((c) => c.credentialId);
      }
    }

    const { options, challenge } = await buildAuthenticationOptions(allowIds);
    storeChallenge(reply, { challenge, intent: "authenticate" });
    return reply.send(options);
  });

  app.post("/webauthn/auth/verify", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    if (!verifyCsrf(req, reply)) return;
    const challenge = consumeChallenge(req, reply);
    if (!challenge || challenge.intent !== "authenticate") {
      return reply.code(400).send({ error: "challenge_mismatch" });
    }
    const parsed = z.object({ response: z.any() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request" });

    const credId = parsed.data.response?.id;
    if (!credId || typeof credId !== "string") return reply.code(400).send({ error: "bad_request" });

    const [credRow] = await db
      .select({
        id: schema.webauthnCredentials.id,
        userId: schema.webauthnCredentials.userId,
        credentialId: schema.webauthnCredentials.credentialId,
        publicKey: schema.webauthnCredentials.publicKey,
        counter: schema.webauthnCredentials.counter,
        transports: schema.webauthnCredentials.transports,
      })
      .from(schema.webauthnCredentials)
      .where(eq(schema.webauthnCredentials.credentialId, credId))
      .limit(1);
    if (!credRow) return reply.code(401).send({ error: "credential_unknown" });

    const decoded = Buffer.from(credRow.publicKey, "base64url");
    const buf = new ArrayBuffer(decoded.byteLength);
    const publicKey = new Uint8Array(buf);
    publicKey.set(decoded);

    let verification;
    try {
      verification = await verifyAuthentication(parsed.data.response, challenge.challenge, {
        id: credRow.credentialId,
        publicKey,
        counter: credRow.counter,
        transports: (credRow.transports ?? undefined) as never,
      });
    } catch (err) {
      req.log.warn({ err }, "webauthn_auth_failed");
      return reply.code(401).send({ error: "verification_failed" });
    }
    if (!verification.verified) return reply.code(401).send({ error: "verification_failed" });

    await db
      .update(schema.webauthnCredentials)
      .set({ counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date() })
      .where(eq(schema.webauthnCredentials.id, credRow.id));

    // Passkey login = both factors satisfied (something-you-have + verification)
    await createSession(reply, credRow.userId, { mfaSatisfied: true });
    const [usr] = await db.select().from(schema.users).where(eq(schema.users.id, credRow.userId)).limit(1);
    if (usr) {
      void notifyLoginSuccess(req, usr, "passkey").catch((err) => req.log.warn({ err }, "login_alert_failed"));
      setThemeCookies(reply, usr.themePalette, usr.themeDensity);
    }
    void recordLoginEvent(req, credRow.userId, "passkey").catch((err) => req.log.warn({ err }, "login_event_failed"));
    return reply.send({ ok: true, redirect: "/app" });
  });
}
