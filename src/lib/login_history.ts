import type { FastifyRequest } from "fastify";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";

export type LoginMethod = "password" | "passkey" | "mfa" | "sso" | "qr";

export async function recordLoginEvent(
  req: FastifyRequest,
  userId: string,
  method: LoginMethod,
): Promise<void> {
  const ua = String(req.headers["user-agent"] ?? "").slice(0, 500);
  await db.insert(schema.loginEvents).values({
    userId,
    method,
    ip: req.ip,
    userAgent: ua,
  });
}

export async function listRecentLogins(userId: string, limit = 30) {
  return db
    .select()
    .from(schema.loginEvents)
    .where(eq(schema.loginEvents.userId, userId))
    .orderBy(desc(schema.loginEvents.createdAt))
    .limit(limit);
}
