// Centralized user-active gate. Admins disable accounts via /admin/users —
// every credential-accepting entry point must check this, otherwise the
// disabled user keeps slipping in via CalDAV / API tokens / SSO / Passkey.
//
// We had a hole here: only the web login form + session loader checked
// disabledAt. CalDAV basic-auth, bearer-token auth, SSO callback, and
// Passkey verify all ignored it.

import { and, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";

export function userIsActive(user: { disabledAt: Date | null } | null | undefined): boolean {
  return !!user && user.disabledAt === null;
}

// How many usable (not disabled) admins exist right now. Caller uses this
// to refuse demote/disable/delete operations that would leave the system
// with zero admins — a footgun that requires manual DB intervention to
// recover from. Returns the COUNT, not a boolean, so callers can phrase
// the error message ("you are the last admin" vs "only N admins remain").
export async function countActiveAdmins(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`cast(count(*) as int)` })
    .from(schema.users)
    .where(and(eq(schema.users.isAdmin, true), isNull(schema.users.disabledAt)));
  return row?.n ?? 0;
}

// Bulk-revoke every long-lived credential a user has so that disabling /
// kicking them is actually effective. Sessions still need a separate
// `delete from sessions where user_id = ?` because they're an opaque
// blob keyed by sid; we don't track them as revocable.
export async function revokeAllUserCredentials(userId: string): Promise<void> {
  const now = new Date();
  await db
    .update(schema.apiTokens)
    .set({ revokedAt: now })
    .where(eq(schema.apiTokens.userId, userId));
  await db
    .update(schema.appPasswords)
    .set({ revokedAt: now })
    .where(eq(schema.appPasswords.userId, userId));
}
