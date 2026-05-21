import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { hashPassword, verifyPassword } from "./password.js";

const CHALLENGE_TTL_MS = 10 * 60 * 1000; // 10 min
const MAX_ATTEMPTS = 5;

export function hashStr(s: string): string {
  return createHash("sha256").update(env.SESSION_SECRET).update(s).digest("hex");
}

// "Looks familiar" = the user has at least one prior successful login_event
// with the same (ip_hash, ua_hash) combo. We hash with the session secret so
// the table doesn't accidentally store rotatable PII in plain text. If we
// have NO history at all for a user (fresh account), treat as familiar to
// avoid bouncing them out of their first real session.
export async function isLoginFamiliar(userId: string, ip: string, ua: string): Promise<boolean> {
  const ipHash = hashStr(ip);
  const uaHash = hashStr(ua.slice(0, 500));
  const [any] = await db
    .select({ id: schema.loginEvents.id })
    .from(schema.loginEvents)
    .where(eq(schema.loginEvents.userId, userId))
    .limit(1);
  if (!any) return true; // brand new user — first login is implicitly trusted
  const [match] = await db
    .select({ id: schema.loginEvents.id })
    .from(schema.loginEvents)
    .where(and(eq(schema.loginEvents.userId, userId), eq(schema.loginEvents.ip, ip)))
    .orderBy(desc(schema.loginEvents.createdAt))
    .limit(1);
  if (match) return true;
  // Also accept if the same UA hash (e.g. user moves between WiFi & cellular).
  const recent = await db
    .select({ ua: schema.loginEvents.userAgent })
    .from(schema.loginEvents)
    .where(eq(schema.loginEvents.userId, userId))
    .orderBy(desc(schema.loginEvents.createdAt))
    .limit(10);
  for (const r of recent) {
    if (hashStr(r.ua.slice(0, 500)) === uaHash) return true;
  }
  return false;
}

export type IssuedChallenge = { token: string; code: string };

export async function createLoginChallenge(userId: string, ip: string, ua: string): Promise<IssuedChallenge> {
  const token = randomBytes(24).toString("base64url");
  const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
  const codeHash = await hashPassword(code);
  await db.insert(schema.loginChallenges).values({
    token,
    userId,
    codeHash,
    ipHash: hashStr(ip),
    uaHash: hashStr(ua.slice(0, 500)),
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
  });
  return { token, code };
}

export type VerifyResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "no_challenge" | "expired" | "too_many_attempts" | "wrong" };

export async function verifyLoginChallenge(token: string, code: string): Promise<VerifyResult> {
  const [row] = await db.select().from(schema.loginChallenges).where(eq(schema.loginChallenges.token, token)).limit(1);
  if (!row) return { ok: false, reason: "no_challenge" };
  if (row.expiresAt < new Date()) {
    await db.delete(schema.loginChallenges).where(eq(schema.loginChallenges.token, token));
    return { ok: false, reason: "expired" };
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    await db.delete(schema.loginChallenges).where(eq(schema.loginChallenges.token, token));
    return { ok: false, reason: "too_many_attempts" };
  }
  const ok = await verifyPassword(code.trim(), row.codeHash);
  if (!ok) {
    await db
      .update(schema.loginChallenges)
      .set({ attempts: row.attempts + 1 })
      .where(eq(schema.loginChallenges.token, token));
    return { ok: false, reason: "wrong" };
  }
  await db.delete(schema.loginChallenges).where(eq(schema.loginChallenges.token, token));
  return { ok: true, userId: row.userId };
}

export async function destroyChallenge(token: string): Promise<void> {
  await db.delete(schema.loginChallenges).where(eq(schema.loginChallenges.token, token));
}
