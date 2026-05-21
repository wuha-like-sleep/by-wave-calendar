import { randomBytes } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { hashPassword, verifyPassword } from "./password.js";
import { getSettings } from "./site_settings.js";

// Token format: bwc_<8-char-prefix>_<24-char-secret>
// The prefix lets us index lookups; the secret is bcrypt-hashed at rest.
const PREFIX_LEN = 8;
const SECRET_LEN = 24;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghijkmnpqrstuvwxyz";
const TOKEN_PREFIX_LITERAL = "bwc_";

function randomFrom(alphabet: string, len: number): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

export function looksLikeApiToken(s: string): boolean {
  // bwc_<8 chars>_<24 chars> = 4 + 8 + 1 + 24 = 37
  return /^bwc_[A-Za-z0-9]{8}_[A-Za-z0-9]{24}$/.test(s);
}

function extractPrefix(token: string): string | null {
  const m = token.match(/^bwc_([A-Za-z0-9]{8})_/);
  return m ? (m[1] ?? null) : null;
}

export type IssuedApiToken = {
  id: string;
  plain: string;
  prefix: string;
};

export async function createApiToken(input: {
  userId: string;
  label: string;
  scope?: "read" | "write";
  expiresInDays?: number | null;
}): Promise<IssuedApiToken> {
  const prefix = randomFrom(ALPHABET, PREFIX_LEN);
  const secret = randomFrom(ALPHABET, SECRET_LEN);
  const plain = `${TOKEN_PREFIX_LITERAL}${prefix}_${secret}`;
  const tokenHash = await hashPassword(plain);
  const expiresAt = input.expiresInDays && input.expiresInDays > 0
    ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
    : null;
  const [row] = await db.insert(schema.apiTokens).values({
    userId: input.userId,
    label: input.label.trim() || "未命名",
    prefix,
    tokenHash,
    scope: input.scope ?? "write",
    expiresAt,
  }).returning({ id: schema.apiTokens.id });
  if (!row) throw new Error("api_token insert failed");
  return { id: row.id, plain, prefix };
}

// Admin-facing: list every non-revoked token across the whole site, joined
// with the impersonated user's email for the management table.
export async function listAllApiTokens() {
  return db
    .select({
      id: schema.apiTokens.id,
      label: schema.apiTokens.label,
      prefix: schema.apiTokens.prefix,
      scope: schema.apiTokens.scope,
      lastUsedAt: schema.apiTokens.lastUsedAt,
      lastUsedIp: schema.apiTokens.lastUsedIp,
      expiresAt: schema.apiTokens.expiresAt,
      createdAt: schema.apiTokens.createdAt,
      userEmail: schema.users.email,
      userId: schema.apiTokens.userId,
    })
    .from(schema.apiTokens)
    .innerJoin(schema.users, eq(schema.users.id, schema.apiTokens.userId))
    .where(isNull(schema.apiTokens.revokedAt))
    .orderBy(asc(schema.apiTokens.createdAt));
}

export async function revokeApiTokenAdmin(id: string): Promise<void> {
  await db
    .update(schema.apiTokens)
    .set({ revokedAt: new Date() })
    .where(eq(schema.apiTokens.id, id));
}

export type VerifiedToken = {
  userId: string;
  scope: "read" | "write";
  tokenId: string;
};

// Resolve a bearer string to a (userId, scope). Returns null on any failure —
// disabled flag, malformed shape, no match, hash mismatch, expired, revoked.
// Caller bumps last_used_at / last_used_ip on success via touchApiToken().
export async function verifyApiToken(token: string): Promise<VerifiedToken | null> {
  if (!looksLikeApiToken(token)) return null;
  const settings = await getSettings();
  if (!settings.apiEnabled) return null;
  const prefix = extractPrefix(token);
  if (!prefix) return null;
  const [row] = await db
    .select()
    .from(schema.apiTokens)
    .where(and(eq(schema.apiTokens.prefix, prefix), isNull(schema.apiTokens.revokedAt)))
    .limit(1);
  if (!row) return null;
  if (row.expiresAt && row.expiresAt < new Date()) return null;
  if (!(await verifyPassword(token, row.tokenHash))) return null;
  const scope = row.scope === "read" ? "read" : "write";
  return { userId: row.userId, scope, tokenId: row.id };
}

export async function touchApiToken(tokenId: string, ip: string): Promise<void> {
  await db
    .update(schema.apiTokens)
    .set({ lastUsedAt: new Date(), lastUsedIp: ip })
    .where(eq(schema.apiTokens.id, tokenId));
}
