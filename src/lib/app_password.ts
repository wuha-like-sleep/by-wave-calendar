import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { hashPassword, verifyPassword } from "./password.js";

const PREFIX_LEN = 8;
const SECRET_LEN = 24;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomToken(len: number): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

export type IssuedAppPassword = { id: string; plain: string; prefix: string };

export async function createAppPassword(userId: string, label: string): Promise<IssuedAppPassword> {
  const prefix = randomToken(PREFIX_LEN);
  const secret = randomToken(SECRET_LEN);
  const plain = `${prefix}-${secret}`;
  const tokenHash = await hashPassword(plain);
  const [row] = await db
    .insert(schema.appPasswords)
    .values({ userId, label: label.trim() || "未命名设备", prefix, tokenHash, scope: "caldav" })
    .returning({ id: schema.appPasswords.id });
  if (!row) throw new Error("insert_failed");
  return { id: row.id, plain, prefix };
}

export async function listAppPasswords(userId: string) {
  return db
    .select({
      id: schema.appPasswords.id,
      label: schema.appPasswords.label,
      prefix: schema.appPasswords.prefix,
      lastUsedAt: schema.appPasswords.lastUsedAt,
      createdAt: schema.appPasswords.createdAt,
    })
    .from(schema.appPasswords)
    .where(and(eq(schema.appPasswords.userId, userId), isNull(schema.appPasswords.revokedAt)))
    .orderBy(schema.appPasswords.createdAt);
}

export async function revokeAppPassword(userId: string, id: string): Promise<void> {
  await db
    .update(schema.appPasswords)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.appPasswords.id, id), eq(schema.appPasswords.userId, userId)));
}

export async function verifyAppPassword(userId: string, presented: string): Promise<boolean> {
  const dash = presented.indexOf("-");
  if (dash !== PREFIX_LEN) return false;
  const prefix = presented.slice(0, PREFIX_LEN);
  const rows = await db
    .select()
    .from(schema.appPasswords)
    .where(and(
      eq(schema.appPasswords.userId, userId),
      eq(schema.appPasswords.prefix, prefix),
      isNull(schema.appPasswords.revokedAt),
    ))
    .limit(1);
  const row = rows[0];
  if (!row) return false;
  if (!(await verifyPassword(presented, row.tokenHash))) return false;
  await db
    .update(schema.appPasswords)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.appPasswords.id, row.id));
  return true;
}

export function looksLikeAppPassword(s: string): boolean {
  return s.length === PREFIX_LEN + 1 + SECRET_LEN && s[PREFIX_LEN] === "-";
}
