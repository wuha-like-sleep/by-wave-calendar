import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { newSessionId } from "./ids.js";
import { env } from "../env.js";

const COOKIE_NAME = "bwc_sid";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 30 * ONE_DAY_MS;

export async function createSession(
  reply: FastifyReply,
  userId: string,
  opts: { mfaSatisfied?: boolean } = {},
): Promise<string> {
  const id = newSessionId();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(schema.sessions).values({
    id,
    userId,
    expiresAt,
    mfaSatisfied: opts.mfaSatisfied ?? true,
  });
  reply.setCookie(COOKIE_NAME, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
    signed: true,
  });
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
  const user = req.user ?? (await loadUserFromRequest(req));
  if (!user) {
    reply.code(401).send({ error: "unauthorized" });
    throw new Error("unauthorized");
  }
  req.user = user;
  return user;
}
