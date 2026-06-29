import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { hashPassword, passwordPolicyError, verifyPassword, verifyPasswordTimingSafe } from "../lib/password.js";
import { createSession, destroySession, requireUser } from "../lib/session.js";
import { userIsActive } from "../lib/user_state.js";
import { ok, err } from "../lib/api_response.js";
import { env } from "../env.js";
import { isLocked, recordFailedLogin, resetFailedLogin } from "../lib/login_lockout.js";

// Tightened schema — same length range as the web flow; the web routes
// additionally enforce passwordPolicyError on the way in. Without this
// the JSON API was the cheat code for creating "12345678" accounts.
// Email is normalized (lowercase + trim) here so register and login
// agree with every other login path. Otherwise a user could register
// "ADMIN@x.com" via the JSON API and create a shadow row that bypassed
// the lowercase-keyed disabled-account check.
const credsSchema = z.object({
  email: z.string().email().transform((s) => s.toLowerCase().trim()),
  password: z.string().min(10).max(200),
  displayName: z.string().min(1).max(100).optional(),
});

// Routes are written with paths relative to a prefix; the plugin is
// mounted twice at /api and /api/v1 in server.ts. Response shape
// switches based on which URL the client hit (via the ok()/err()
// helpers): legacy /api returns bare payloads, /api/v1 returns the
// envelope { ok, data | error, meta? }.
export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/register", async (req, reply) => {
    const body = credsSchema.parse(req.body);
    const policyErr = passwordPolicyError(body.password);
    if (policyErr) return err(req, reply, 400, "weak_password", policyErr);
    const existing = await db.select().from(schema.users).where(eq(schema.users.email, body.email)).limit(1);
    if (existing.length > 0) {
      return err(req, reply, 409, "email_already_registered", "邮箱已注册");
    }
    const passwordHash = await hashPassword(body.password);
    // Catch unique-constraint violations explicitly: the SELECT above
    // doesn't synchronize with a concurrent INSERT, so two parallel
    // registers with the same email could both pass the existence check.
    // The DB unique index on users.email protects us, but only if we
    // surface the conflict as 409 instead of 500.
    let user: schema.User | undefined;
    try {
      [user] = await db
        .insert(schema.users)
        .values({ email: body.email, passwordHash, displayName: body.displayName })
        .returning();
    } catch (e) {
      const msg = e instanceof Error ? e.message.toLowerCase() : "";
      if (msg.includes("duplicate") || msg.includes("unique") || msg.includes("users_email_unique")) {
        return err(req, reply, 409, "email_already_registered", "邮箱已注册");
      }
      throw e;
    }
    if (!user) return err(req, reply, 500, "insert_failed", "创建账号失败");
    await createSession(reply, user.id);
    return ok(req, reply, { id: user.id, email: user.email, displayName: user.displayName, isAdmin: user.isAdmin });
  });

  app.post("/auth/login", {
    // Per-route auth limiter — the global 120/min was the only brake on this
    // path, letting it be used to brute-force around the account lockout.
    config: { rateLimit: { max: env.RATE_LIMIT_AUTH_PER_MINUTE, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    // Login loosens the password length floor — passwordPolicyError is
    // for NEW passwords only; legacy ones may pre-date the policy bump.
    const loginBody = z.object({
      email: z.string().email().transform((s) => s.toLowerCase().trim()),
      password: z.string().min(1).max(200),
    }).parse(req.body);
    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, loginBody.email)).limit(1);
    if (!user) {
      // Timing-safe: burn the same CPU as a real verify so the
      // does-this-email-exist channel is closed.
      await verifyPasswordTimingSafe(loginBody.password);
      return err(req, reply, 401, "invalid_credentials", "邮箱或密码错误");
    }
    // Account lockout — mirror the web /login path so the JSON API can't be
    // used to brute-force around the lockout (or keep hitting a web-locked
    // account). Same brake on both surfaces.
    if (isLocked(user)) {
      return err(req, reply, 401, "account_locked", "账号已临时锁定，请稍后再试或重置密码");
    }
    const passOk = await verifyPassword(loginBody.password, user.passwordHash);
    if (!passOk) {
      await recordFailedLogin(user);
      return err(req, reply, 401, "invalid_credentials", "邮箱或密码错误");
    }
    // Disabled-account gate: return the same 401 so we don't leak the
    // disabled-vs-doesn't-exist distinction.
    if (!userIsActive(user)) return err(req, reply, 401, "invalid_credentials", "邮箱或密码错误");
    await resetFailedLogin(user.id);
    await createSession(reply, user.id);
    return ok(req, reply, { id: user.id, email: user.email, displayName: user.displayName, isAdmin: user.isAdmin });
  });

  app.post("/auth/logout", async (req, reply) => {
    await destroySession(req, reply);
    return ok(req, reply, { ok: true });
  });

  app.get("/auth/me", async (req, reply) => {
    const user = await requireUser(req, reply);
    return ok(req, reply, { id: user.id, email: user.email, displayName: user.displayName, isAdmin: user.isAdmin });
  });
}
