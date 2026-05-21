import { createHash, randomInt } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { sendMail } from "./mailer.js";
import { verificationCodeMail } from "./email_templates.js";
import { env } from "../env.js";

const TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 6;

export function genCode(): string {
  // 6-digit zero-padded
  const n = randomInt(0, 1_000_000);
  return n.toString().padStart(6, "0");
}

export function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export type PendingRegistration = {
  passwordHash: string;
  displayName: string | null;
};

export async function issueCode(email: string, payload: PendingRegistration): Promise<{ ok: boolean; code?: string }> {
  const code = genCode();
  const codeHash = hashCode(code);
  const expiresAt = new Date(Date.now() + TTL_MS);
  await db
    .insert(schema.emailVerifications)
    .values({ email, codeHash, payload: payload as unknown as object, expiresAt, attempts: 0 })
    .onConflictDoUpdate({
      target: schema.emailVerifications.email,
      set: { codeHash, payload: payload as unknown as object, expiresAt, attempts: 0, createdAt: new Date() },
    });

  const mail = verificationCodeMail(email, code);
  const res = await sendMail(mail);
  if (!res.ok) {
    if (env.NODE_ENV === "development") return { ok: true, code };
    return { ok: false };
  }
  return { ok: true };
}

export async function verifyCode(
  email: string,
  code: string,
): Promise<{ ok: boolean; reason?: "no_pending" | "expired" | "too_many_attempts" | "wrong"; payload?: PendingRegistration }> {
  const [row] = await db
    .select()
    .from(schema.emailVerifications)
    .where(eq(schema.emailVerifications.email, email))
    .limit(1);
  if (!row) return { ok: false, reason: "no_pending" };
  if (row.expiresAt.getTime() < Date.now()) {
    await db.delete(schema.emailVerifications).where(eq(schema.emailVerifications.email, email));
    return { ok: false, reason: "expired" };
  }
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, reason: "too_many_attempts" };

  const codeHash = hashCode(code.trim());
  if (codeHash !== row.codeHash) {
    await db
      .update(schema.emailVerifications)
      .set({ attempts: row.attempts + 1 })
      .where(eq(schema.emailVerifications.email, email));
    return { ok: false, reason: "wrong" };
  }

  const payload = row.payload as unknown as PendingRegistration;
  await db.delete(schema.emailVerifications).where(eq(schema.emailVerifications.email, email));
  return { ok: true, payload };
}

export async function cleanupExpired(): Promise<void> {
  await db.delete(schema.emailVerifications).where(lt(schema.emailVerifications.expiresAt, new Date()));
}
