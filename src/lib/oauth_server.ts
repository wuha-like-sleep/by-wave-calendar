// OAuth 2.0 authorization server. Implements the authorization code
// flow with PKCE (RFC 7636 S256). We do NOT support the implicit flow
// (security-discouraged since 2019) or refresh tokens (yet).
//
// Token lifecycle:
//   1. /oauth/authorize?client_id=...&response_type=code&...
//      — user sees consent screen, approves, we issue auth code.
//   2. App POSTs to /oauth/token with the code + PKCE verifier.
//      — we exchange for an opaque access token (30-day default).
//   3. App calls /api/v1/* with Authorization: Bearer <access_token>.
//      — token validated via verifyOAuthToken below; resolves to user_id.

import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { hashPassword, verifyPassword } from "./password.js";
import { userIsActive } from "./user_state.js";

const TOKEN_PREFIX = "bwo_";
const PREFIX_LEN = 8;
const SECRET_LEN = 32;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghijkmnpqrstuvwxyz";

function randFromAlphabet(n: number): string {
  const bytes = randomBytes(n);
  let out = "";
  for (let i = 0; i < n; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

// Available permission scopes. Keep these coarse for now; finer-grained
// (per-calendar) can come later if anyone needs it.
export const OAUTH_SCOPES = {
  "read:events": "查看你的日历和事件",
  "write:events": "创建、修改、删除你的事件",
  "read:profile": "读取你的账号信息（邮箱、显示名）",
} as const;
export type OAuthScope = keyof typeof OAUTH_SCOPES;

// ---------- Client (third-party app) management ----------

export async function createOAuthClient(input: {
  name: string;
  description?: string;
  logoUrl?: string;
  redirectUris: string[];
  allowedScopes: OAuthScope[];
}): Promise<{ id: string; clientId: string; clientSecret: string }> {
  const clientId = "bwc_app_" + randFromAlphabet(8);
  const clientSecret = TOKEN_PREFIX + randFromAlphabet(SECRET_LEN);
  const clientSecretHash = await hashPassword(clientSecret);
  const [row] = await db.insert(schema.oauthClients).values({
    clientId,
    clientSecretHash,
    name: input.name,
    description: input.description ?? null,
    logoUrl: input.logoUrl ?? null,
    redirectUris: input.redirectUris.join("\n"),
    allowedScopes: input.allowedScopes,
  }).returning({ id: schema.oauthClients.id });
  if (!row) throw new Error("oauth_client insert failed");
  return { id: row.id, clientId, clientSecret };
}

export async function findClientByClientId(clientId: string): Promise<schema.OAuthClient | null> {
  const [row] = await db.select().from(schema.oauthClients).where(eq(schema.oauthClients.clientId, clientId)).limit(1);
  return row ?? null;
}

// ---------- Authorization code ----------

// PKCE S256 verification.
function pkceMatches(challenge: string | null, verifier: string | undefined): boolean {
  if (!challenge) return true;  // client didn't use PKCE; permitted for confidential clients
  if (!verifier) return false;
  const computed = createHash("sha256").update(verifier).digest("base64url");
  return computed === challenge;
}

export async function issueAuthorizationCode(input: {
  clientId: string;
  userId: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string | null;
}): Promise<string> {
  const code = randomBytes(32).toString("base64url");
  await db.insert(schema.oauthAuthorizationCodes).values({
    code,
    clientId: input.clientId,
    userId: input.userId,
    redirectUri: input.redirectUri,
    scopes: input.scopes,
    codeChallenge: input.codeChallenge,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),  // 10 minutes
  });
  return code;
}

// ---------- Token exchange ----------

export async function exchangeCodeForToken(input: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  codeVerifier?: string;
}): Promise<{ accessToken: string; expiresIn: number; scope: string } | { error: string }> {
  // 1) Look up the client
  const client = await findClientByClientId(input.clientId);
  if (!client || !client.enabled) return { error: "invalid_client" };

  // 2) Verify client secret
  if (!(await verifyPassword(input.clientSecret, client.clientSecretHash))) {
    return { error: "invalid_client" };
  }

  // 3) Look up the code
  const [row] = await db.select().from(schema.oauthAuthorizationCodes).where(eq(schema.oauthAuthorizationCodes.code, input.code)).limit(1);
  if (!row) return { error: "invalid_grant" };

  // Code is one-time-use; delete regardless of outcome.
  await db.delete(schema.oauthAuthorizationCodes).where(eq(schema.oauthAuthorizationCodes.code, input.code));

  if (row.expiresAt < new Date()) return { error: "invalid_grant" };
  if (row.clientId !== client.id) return { error: "invalid_grant" };
  if (row.redirectUri !== input.redirectUri) return { error: "invalid_grant" };
  if (!pkceMatches(row.codeChallenge, input.codeVerifier)) return { error: "invalid_grant" };

  // 4) Verify user is still active
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, row.userId)).limit(1);
  if (!userIsActive(user)) return { error: "invalid_grant" };

  // 5) Mint the access token
  const prefix = randFromAlphabet(PREFIX_LEN);
  const secret = randFromAlphabet(SECRET_LEN);
  const accessToken = `${TOKEN_PREFIX}${prefix}_${secret}`;
  const tokenHash = await hashPassword(accessToken);
  const expiresIn = 30 * 24 * 60 * 60;  // 30 days

  await db.insert(schema.oauthAccessTokens).values({
    tokenHash,
    prefix,
    clientId: client.id,
    userId: row.userId,
    scopes: row.scopes,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
  });

  return {
    accessToken,
    expiresIn,
    scope: (row.scopes as string[]).join(" "),
  };
}

// ---------- Token verification (called from session.ts) ----------

export function looksLikeOAuthToken(s: string): boolean {
  return /^bwo_[A-Za-z0-9]{8}_[A-Za-z0-9]{32}$/.test(s);
}

export async function verifyOAuthToken(token: string): Promise<{ userId: string; scopes: string[]; tokenId: string } | null> {
  if (!looksLikeOAuthToken(token)) return null;
  const m = token.match(/^bwo_([A-Za-z0-9]{8})_/);
  if (!m) return null;
  const prefix = m[1]!;
  const [row] = await db
    .select()
    .from(schema.oauthAccessTokens)
    .where(and(eq(schema.oauthAccessTokens.prefix, prefix), gt(schema.oauthAccessTokens.expiresAt, new Date())))
    .limit(1);
  if (!row) return null;
  if (row.revokedAt) return null;
  if (!(await verifyPassword(token, row.tokenHash))) return null;
  // User still active?
  const [user] = await db.select({ disabledAt: schema.users.disabledAt }).from(schema.users).where(eq(schema.users.id, row.userId)).limit(1);
  if (!userIsActive(user)) return null;
  return { userId: row.userId, scopes: row.scopes as string[], tokenId: row.id };
}

export async function touchOAuthToken(tokenId: string): Promise<void> {
  await db.update(schema.oauthAccessTokens).set({ lastUsedAt: new Date() }).where(eq(schema.oauthAccessTokens.id, tokenId));
}

export async function revokeOAuthToken(userId: string, tokenId: string): Promise<void> {
  await db.update(schema.oauthAccessTokens).set({ revokedAt: new Date() })
    .where(and(eq(schema.oauthAccessTokens.id, tokenId), eq(schema.oauthAccessTokens.userId, userId)));
}
