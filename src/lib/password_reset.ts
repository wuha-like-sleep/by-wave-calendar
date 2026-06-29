import { randomBytes, createHash } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, schema } from "../db/client.js";

const TTL_MS = 60 * 60 * 1000; // 1 hour

export function newResetToken(): string {
  return randomBytes(32).toString("base64url");
}

// Store only a SHA-256 of the token, never the raw value. The token is 256-bit
// random so a plain (unsalted) hash is sufficient and not brute-forceable —
// a leaked DB / backup / log can no longer be turned into live reset links.
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createReset(userId: string): Promise<string> {
  const token = newResetToken();
  await db.insert(schema.passwordResets).values({
    token: hashToken(token),
    userId,
    expiresAt: new Date(Date.now() + TTL_MS),
  });
  return token; // raw token goes only into the emailed link
}

export async function loadValidReset(token: string): Promise<{ userId: string } | null> {
  const [row] = await db
    .select()
    .from(schema.passwordResets)
    .where(and(
      eq(schema.passwordResets.token, hashToken(token)),
      isNull(schema.passwordResets.usedAt),
      gt(schema.passwordResets.expiresAt, new Date()),
    ))
    .limit(1);
  return row ? { userId: row.userId } : null;
}

export async function consumeReset(token: string): Promise<void> {
  await db
    .update(schema.passwordResets)
    .set({ usedAt: new Date() })
    .where(eq(schema.passwordResets.token, hashToken(token)));
}
