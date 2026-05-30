// User-registration invites (site_settings.registration_mode = "invite").
//
// An admin generates a token in /admin/site; the invitee registers via
// /register?invite=<token>. The token is VALIDATED when the register form
// loads and on POST, but only CONSUMED (atomically) once email verification
// completes and the user row is actually created — so an abandoned
// registration doesn't burn a single-use invite.

import { and, desc, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { newInvitationToken } from "./ids.js";

export type InviteValidation =
  | { ok: true; invite: schema.SignupInvite }
  | { ok: false; reason: "not_found" | "revoked" | "expired" | "exhausted" | "email_mismatch" };

export async function createInvite(opts: {
  createdBy: string;
  email?: string | null;
  note?: string | null;
  maxUses?: number;
  expiresInDays?: number | null;
}): Promise<schema.SignupInvite> {
  const token = newInvitationToken();
  const expiresAt =
    opts.expiresInDays && opts.expiresInDays > 0
      ? new Date(Date.now() + opts.expiresInDays * 24 * 60 * 60 * 1000)
      : null;
  const [row] = await db
    .insert(schema.signupInvites)
    .values({
      token,
      email: opts.email?.toLowerCase().trim() || null,
      note: opts.note?.trim() || null,
      createdBy: opts.createdBy,
      maxUses: Math.max(1, Math.min(1000, opts.maxUses ?? 1)),
      expiresAt,
    })
    .returning();
  return row!;
}

function checkInvite(inv: schema.SignupInvite | undefined, email?: string | null): InviteValidation {
  if (!inv) return { ok: false, reason: "not_found" };
  if (inv.revokedAt) return { ok: false, reason: "revoked" };
  if (inv.expiresAt && inv.expiresAt.getTime() < Date.now()) return { ok: false, reason: "expired" };
  if (inv.usedCount >= inv.maxUses) return { ok: false, reason: "exhausted" };
  if (inv.email && email && inv.email !== email.toLowerCase().trim()) return { ok: false, reason: "email_mismatch" };
  return { ok: true, invite: inv };
}

/** Read-only validity check — no consumption. Use to gate the form + POST. */
export async function validateInvite(token: string | undefined, email?: string | null): Promise<InviteValidation> {
  if (!token) return { ok: false, reason: "not_found" };
  const [inv] = await db
    .select()
    .from(schema.signupInvites)
    .where(eq(schema.signupInvites.token, token))
    .limit(1);
  return checkInvite(inv, email);
}

/** Atomically consume one use (SELECT … FOR UPDATE). Returns inviter id on success. */
export async function consumeInvite(
  token: string,
  email?: string | null,
): Promise<{ ok: boolean; invitedBy?: string | null }> {
  return db.transaction(async (tx) => {
    const [inv] = await tx
      .select()
      .from(schema.signupInvites)
      .where(eq(schema.signupInvites.token, token))
      .limit(1)
      .for("update");
    const v = checkInvite(inv, email);
    if (!v.ok) return { ok: false };
    await tx
      .update(schema.signupInvites)
      .set({ usedCount: inv!.usedCount + 1 })
      .where(eq(schema.signupInvites.token, token));
    return { ok: true, invitedBy: inv!.createdBy };
  });
}

export async function listInvites(): Promise<schema.SignupInvite[]> {
  return db
    .select()
    .from(schema.signupInvites)
    .orderBy(desc(schema.signupInvites.createdAt))
    .limit(200);
}

export async function revokeInvite(token: string): Promise<void> {
  await db
    .update(schema.signupInvites)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.signupInvites.token, token), isNull(schema.signupInvites.revokedAt)));
}
