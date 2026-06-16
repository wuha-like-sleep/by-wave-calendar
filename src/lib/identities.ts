// Linked external login identities. One ByWave account can have several ways
// to sign in (password + one or more SSO identities). The SSO callback resolves
// a login by (provider, subject) via these rows first, then falls back to email.
import { and, eq, asc } from "drizzle-orm";
import { db, schema } from "../db/client.js";

export async function listIdentities(userId: string): Promise<schema.UserIdentity[]> {
  return db
    .select()
    .from(schema.userIdentities)
    .where(eq(schema.userIdentities.userId, userId))
    .orderBy(asc(schema.userIdentities.createdAt));
}

export async function findUserIdByIdentity(provider: string, subject: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: schema.userIdentities.userId })
    .from(schema.userIdentities)
    .where(and(eq(schema.userIdentities.provider, provider), eq(schema.userIdentities.subject, subject)))
    .limit(1);
  return row?.userId ?? null;
}

export type LinkResult = { ok: true; created: boolean } | { ok: false; reason: "linked_to_other" };

/**
 * Bind (provider, subject) to a user. Idempotent for the same user; refuses if
 * the identity is already bound to a DIFFERENT account (the caller surfaces a
 * "this SSO identity is already linked elsewhere" error).
 */
export async function linkIdentity(input: {
  userId: string;
  provider: string;
  subject: string;
  email: string | null;
}): Promise<LinkResult> {
  const owner = await findUserIdByIdentity(input.provider, input.subject);
  if (owner) {
    return owner === input.userId ? { ok: true, created: false } : { ok: false, reason: "linked_to_other" };
  }
  await db
    .insert(schema.userIdentities)
    .values({ userId: input.userId, provider: input.provider, subject: input.subject, email: input.email })
    .onConflictDoNothing();
  return { ok: true, created: true };
}

/** Remove an identity owned by `userId`. Returns false if not found / not owned. */
export async function unlinkIdentity(userId: string, identityId: string): Promise<boolean> {
  const res = await db
    .delete(schema.userIdentities)
    .where(and(eq(schema.userIdentities.id, identityId), eq(schema.userIdentities.userId, userId)))
    .returning({ id: schema.userIdentities.id });
  return res.length > 0;
}
