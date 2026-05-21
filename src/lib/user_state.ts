// Centralized user-active gate. Admins disable accounts via /admin/users —
// every credential-accepting entry point must check this, otherwise the
// disabled user keeps slipping in via CalDAV / API tokens / SSO / Passkey.
//
// We had a hole here: only the web login form + session loader checked
// disabledAt. CalDAV basic-auth, bearer-token auth, SSO callback, and
// Passkey verify all ignored it.

import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";

export function userIsActive(user: { disabledAt: Date | null } | null | undefined): boolean {
  return !!user && user.disabledAt === null;
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
