import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { createSession, destroySession, requireUser } from "../lib/session.js";

const credsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  displayName: z.string().min(1).max(100).optional(),
});

export async function authRoutes(app: FastifyInstance) {
  app.post("/api/auth/register", async (req, reply) => {
    const body = credsSchema.parse(req.body);
    const existing = await db.select().from(schema.users).where(eq(schema.users.email, body.email)).limit(1);
    if (existing.length > 0) {
      return reply.code(409).send({ error: "email_already_registered" });
    }
    const passwordHash = await hashPassword(body.password);
    const [user] = await db
      .insert(schema.users)
      .values({ email: body.email, passwordHash, displayName: body.displayName })
      .returning();
    if (!user) return reply.code(500).send({ error: "insert_failed" });
    await createSession(reply, user.id);
    return reply.send({ id: user.id, email: user.email, displayName: user.displayName, isAdmin: user.isAdmin });
  });

  app.post("/api/auth/login", async (req, reply) => {
    const body = credsSchema.pick({ email: true, password: true }).parse(req.body);
    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, body.email)).limit(1);
    if (!user) return reply.code(401).send({ error: "invalid_credentials" });
    const ok = await verifyPassword(body.password, user.passwordHash);
    if (!ok) return reply.code(401).send({ error: "invalid_credentials" });
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
