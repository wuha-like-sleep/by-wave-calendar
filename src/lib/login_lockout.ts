import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { getSettings } from "./site_settings.js";

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
  const settings = await getSettings();
  // Lockout disabled — increment counter for logging but never actually lock.
  if (!settings.lockoutEnabled) {
    await db.update(schema.users)
      .set({ failedLoginCount: user.failedLoginCount + 1, updatedAt: new Date() })
      .where(eq(schema.users.id, user.id));
    return;
  }
  const threshold = Math.max(1, settings.lockoutThreshold);
  const lockoutMs = Math.max(1, settings.lockoutMinutes) * 60_000;
  const newCount = user.failedLoginCount + 1;
  const update: Partial<schema.User> = { failedLoginCount: newCount, updatedAt: new Date() };
  if (newCount >= threshold) {
    update.lockedUntil = new Date(Date.now() + lockoutMs);
    update.failedLoginCount = 0; // reset counter once we've actually locked
  }
  await db.update(schema.users).set(update).where(eq(schema.users.id, user.id));
}

export async function resetFailedLogin(userId: string): Promise<void> {
  await db
    .update(schema.users)
    .set({ failedLoginCount: 0, lockedUntil: null, updatedAt: new Date() })
    .where(eq(schema.users.id, userId));
}
