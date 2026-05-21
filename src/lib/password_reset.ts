import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, schema } from "../db/client.js";

const TTL_MS = 60 * 60 * 1000; // 1 hour

export function newResetToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function createReset(userId: string): Promise<string> {
  const token = newResetToken();
  await db.insert(schema.passwordResets).values({
    token,
    userId,
    expiresAt: new Date(Date.now() + TTL_MS),
  });
  return token;
}

export async function loadValidReset(token: string): Promise<{ userId: string } | null> {
  const [row] = await db
    .select()
    .from(schema.passwordResets)
    .where(and(
      eq(schema.passwordResets.token, token),
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
    .where(eq(schema.passwordResets.token, token));
}
