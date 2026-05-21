import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { hashPassword, passwordPolicyError, verifyPassword, verifyPasswordTimingSafe } from "../lib/password.js";
import { createSession, destroySession, requireUser } from "../lib/session.js";
import { userIsActive } from "../lib/user_state.js";

// Tightened schema — same length range as the web flow; the web routes
// additionally enforce passwordPolicyError on the way in. Without this
// the JSON API was the cheat code for creating "12345678" accounts.
// Email is normalized (lowercase + trim) here so /api/auth/register and
// /api/auth/login agree with every other login path. Otherwise a user
// could register "ADMIN@x.com" via the JSON API and create a shadow
// row that bypasses the lowercase-keyed disabled-account check.
const credsSchema = z.object({
  email: z.string().email().transform((s) => s.toLowerCase().trim()),
  password: z.string().min(10).max(200),
  displayName: z.string().min(1).max(100).optional(),
});

export async function authRoutes(app: FastifyInstance) {
  app.post("/api/auth/register", async (req, reply) => {
    const body = credsSchema.parse(req.body);
    // Match the web flow's policy (≥10 chars, ≥1 letter, ≥1 digit) so the
    // API can't be used as a back door to create weak-password accounts.
    const policyErr = passwordPolicyError(body.password);
    if (policyErr) return reply.code(400).send({ error: "weak_password", message: policyErr });
    const existing = await db.select().from(schema.users).where(eq(schema.users.email, body.email)).limit(1);
    if (existing.length > 0) {
      return reply.code(409).send({ error: "email_already_registered" });
    }
    const passwordHash = await hashPassword(body.password);
    // Catch unique-constraint violations explicitly: the SELECT above
    // doesn't synchronize with a concurrent INSERT, so two parallel
    // POST /api/auth/register with the same email could both pass the
    // existence check. The DB unique index on users.email protects us,
    // but only if we surface the conflict as 409 instead of 500.
    let user: schema.User | undefined;
    try {
      [user] = await db
        .insert(schema.users)
        .values({ email: body.email, passwordHash, displayName: body.displayName })
        .returning();
    } catch (err) {
      const msg = err instanceof Error ? err.message.toLowerCase() : "";
      if (msg.includes("duplicate") || msg.includes("unique") || msg.includes("users_email_unique")) {
        return reply.code(409).send({ error: "email_already_registered" });
      }
      throw err;
    }
    if (!user) return reply.code(500).send({ error: "insert_failed" });
    await createSession(reply, user.id);
    return reply.send({ id: user.id, email: user.email, displayName: user.displayName, isAdmin: user.isAdmin });
  });

  app.post("/api/auth/login", async (req, reply) => {
    // Login route loosens the password rule (passwordPolicyError is for
    // NEW passwords only; legacy ones may pre-date the policy bump) but
    // keeps email normalization.
    const loginBody = z.object({
      email: z.string().email().transform((s) => s.toLowerCase().trim()),
      password: z.string().min(1).max(200),
    }).parse(req.body);
    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, loginBody.email)).limit(1);
    if (!user) {
      // Timing-safe: burn the same CPU as a real verify so the
      // does-this-email-exist channel is closed.
      await verifyPasswordTimingSafe(loginBody.password);
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    const ok = await verifyPassword(loginBody.password, user.passwordHash);
    if (!ok) return reply.code(401).send({ error: "invalid_credentials" });
    // Disabled-account gate: API login route was bypassing the check that
    // the web login form does. Return the same 401 so we don't leak the
    // disabled-vs-doesn't-exist distinction.
    if (!userIsActive(user)) return reply.code(401).send({ error: "invalid_credentials" });
    await createSession(reply, user.id);
    return reply.send({ id: user.id, email: user.email, displayName: user.displayName, isAdmin: user.isAdmin });
  });

  app.post("/api/auth/logout", async (req, reply) => {
    await destroySession(req, reply);
    return reply.send({ ok: true });
  });

  app.get("/api/auth/me", async (req, reply) => {
    const user = await requireUser(req, reply);
    return reply.send({ id: user.id, email: user.email, displayName: user.displayName, isAdmin: user.isAdmin });
  });
}
