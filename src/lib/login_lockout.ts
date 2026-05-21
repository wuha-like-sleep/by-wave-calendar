import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";

const MAX_FAILED = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

export type User = schema.User;

export function isLocked(user: User): boolean {
  if (!user.lockedUntil) return false;
  return user.lockedUntil.getTime() > Date.now();
}

export function lockedRemainingMinutes(user: User): number {
  if (!user.lockedUntil) return 0;
  const ms = user.lockedUntil.getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 60_000));
}

export async function recordFailedLogin(user: User): Promise<void> {
  const newCount = user.failedLoginCount + 1;
  const update: Partial<schema.User> = { failedLoginCount: newCount, updatedAt: new Date() };
  if (newCount >= MAX_FAILED) {
    update.lockedUntil = new Date(Date.now() + LOCKOUT_MS);
    update.failedLoginCount = 0; // reset count after locking
  }
  await db.update(schema.users).set(update).where(eq(schema.users.id, user.id));
}

export async function resetFailedLogin(userId: string): Promise<void> {
  await db
    .update(schema.users)
    .set({ failedLoginCount: 0, lockedUntil: null, updatedAt: new Date() })
    .where(eq(schema.users.id, userId));
}
