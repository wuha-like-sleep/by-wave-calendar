import { randomBytes } from "node:crypto";
import { and, asc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { hashPassword, verifyPassword } from "./password.js";
import { getSettings } from "./site_settings.js";
import { userIsActive } from "./user_state.js";

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

/** The 8-char public prefix of a token string (never the secret part).
 *  For failure logging — the prefix is safe to record, the full token is not. */
export function apiTokenPrefix(token: string): string | null {
  return extractPrefix(token);
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
      useCount: schema.apiTokens.useCount,
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

// Self-service cap: how many live tokens one user may hold at once. Kept
// small on purpose — these are long-lived account-level credentials, and a
// handful covers the usual n8n / Zapier / script setups.
export const MAX_API_TOKENS_PER_USER = 5;

// User-facing: list only the caller's own non-revoked tokens (same field
// set as the admin list, minus the owner join).
export async function listApiTokensForUser(userId: string) {
  return db
    .select({
      id: schema.apiTokens.id,
      label: schema.apiTokens.label,
      prefix: schema.apiTokens.prefix,
      scope: schema.apiTokens.scope,
      lastUsedAt: schema.apiTokens.lastUsedAt,
      lastUsedIp: schema.apiTokens.lastUsedIp,
      useCount: schema.apiTokens.useCount,
      expiresAt: schema.apiTokens.expiresAt,
      createdAt: schema.apiTokens.createdAt,
    })
    .from(schema.apiTokens)
    .where(and(eq(schema.apiTokens.userId, userId), isNull(schema.apiTokens.revokedAt)))
    .orderBy(asc(schema.apiTokens.createdAt));
}

export async function countActiveApiTokensForUser(userId: string): Promise<number> {
  const rows = await db
    .select({ id: schema.apiTokens.id })
    .from(schema.apiTokens)
    .where(and(eq(schema.apiTokens.userId, userId), isNull(schema.apiTokens.revokedAt)));
  return rows.length;
}

// User-facing revoke: the userId condition is the whole point — a user must
// never be able to revoke someone else's token by guessing its id. Returns
// true only when a row was actually revoked, so callers can skip the audit
// entry for no-op attempts.
export async function revokeApiTokenForUser(userId: string, id: string): Promise<boolean> {
  const rows = await db
    .update(schema.apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.apiTokens.id, id), eq(schema.apiTokens.userId, userId), isNull(schema.apiTokens.revokedAt)))
    .returning({ id: schema.apiTokens.id });
  return rows.length > 0;
}

/**
 * Rotate a token: issue a NEW token with the same userId/label/scope, then put
 * the OLD token on a short grace period instead of revoking it immediately.
 *
 * Why a grace period instead of insta-revoke: external integrations (n8n,
 * Zapier, cron, custom scripts) need a window to pick up the new secret and
 * roll over their config without an outage. The default 7 days matches the
 * "AWS-style credential rotation" expectation and is long enough that an
 * operator who runs rotation at the start of the week will have a working
 * weekend even if migration slips.
 *
 * Implementation: we DON'T touch `revokedAt` on the old token (which would
 * 401 it immediately). We just compress its `expiresAt` to `now + graceDays`,
 * so verifyApiToken's expiry check kicks in after the grace ends. If the old
 * token already had a NEARER expiresAt (e.g. it was already on a 1-day TTL),
 * we leave that alone — we never EXTEND a token's life via rotation.
 *
 * Returns the same shape as createApiToken (id + plain + prefix of the NEW
 * token). The caller surfaces `plain` once and only once — same one-shot
 * "save it now or lose it" UX as initial creation.
 *
 * Throws if the source token id doesn't exist or has already been revoked.
 */
export async function rotateApiToken(input: {
  oldTokenId: string;
  graceDays?: number;
  /** Optional override of the new token's label. Defaults to old label
   *  (admins can keep their "n8n integration" label across rotations). */
  newLabel?: string;
}): Promise<IssuedApiToken & { oldExpiresAt: Date }> {
  const grace = input.graceDays ?? 7;
  const [old] = await db
    .select()
    .from(schema.apiTokens)
    .where(eq(schema.apiTokens.id, input.oldTokenId))
    .limit(1);
  if (!old) throw new Error("api_token rotate: source token not found");
  if (old.revokedAt) throw new Error("api_token rotate: source token already revoked");
  const now = new Date();
  const proposedExpiry = new Date(now.getTime() + grace * 24 * 60 * 60 * 1000);
  // Don't extend lifetime — if the old token already expires sooner, keep that.
  const oldExpiresAt = old.expiresAt && old.expiresAt < proposedExpiry
    ? old.expiresAt
    : proposedExpiry;

  // Mint the new token first. If this succeeds but the old-token update fails
  // (extremely unlikely but possible under DB hiccup), we have an extra valid
  // token — fail-safe direction for an integration-critical flow. The opposite
  // (old shrunk, new never minted) would mean a 7-day outage; that's the
  // failure we explicitly avoid by ordering writes this way.
  const issued = await createApiToken({
    userId: old.userId,
    label: input.newLabel?.trim() || old.label,
    scope: old.scope === "read" ? "read" : "write",
    expiresInDays: null,  // new token follows the org's standard "no expiry"
                          // default; admin can rotate it again later
  });

  await db
    .update(schema.apiTokens)
    .set({ expiresAt: oldExpiresAt })
    .where(eq(schema.apiTokens.id, input.oldTokenId));

  return { ...issued, oldExpiresAt };
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
  // Disabled-account gate: token outlives the user's UI session. An admin
  // who disables a user must also stop their integrations (n8n, Zapier).
  const [owner] = await db
    .select({ disabledAt: schema.users.disabledAt })
    .from(schema.users)
    .where(eq(schema.users.id, row.userId))
    .limit(1);
  if (!userIsActive(owner)) return null;
  const scope = row.scope === "read" ? "read" : "write";
  return { userId: row.userId, scope, tokenId: row.id };
}

export async function touchApiToken(tokenId: string, ip: string): Promise<void> {
  const now = new Date();
  await db
    .update(schema.apiTokens)
    .set({
      lastUsedAt: now,
      lastUsedIp: ip,
      // Same UPDATE, so the lifetime call count costs no extra write.
      useCount: sql`${schema.apiTokens.useCount} + 1`,
    })
    .where(eq(schema.apiTokens.id, tokenId));
  // Daily rollup for the settings page's 30-day usage view. One extra
  // indexed upsert per authenticated request — the same order of write
  // cost as the UPDATE above. The increment is a single atomic statement
  // (INSERT … ON CONFLICT DO UPDATE … count = count + 1), so concurrent
  // requests can't lose counts the way a read-modify-write would.
  //
  // Deliberately decoupled from the UPDATE above: if the rollup table is
  // ever missing (migration bookkeeping desync), last-used tracking must
  // keep working — the caller already treats touch as best-effort, and a
  // stats gap is recoverable while a broken touch is not.
  try {
    await db
      .insert(schema.apiTokenDailyUsage)
      .values({ tokenId, day: apiTokenDayKey(now), count: 1 })
      .onConflictDoUpdate({
        target: [schema.apiTokenDailyUsage.tokenId, schema.apiTokenDailyUsage.day],
        set: { count: sql`${schema.apiTokenDailyUsage.count} + 1` },
      });
  } catch {
    // best-effort stats — see above
  }
}

/** UTC calendar day (YYYY-MM-DD) used as the daily-usage bucket key. */
export function apiTokenDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export type ApiTokenUsageSummary = {
  /** Total calls across the user's live tokens in the window. */
  total: number;
  /** One entry per day in the window, oldest first, zero-filled. */
  perDay: { day: string; count: number }[];
  /** Per-token totals in the window, in token creation order. */
  perToken: { tokenId: string; label: string; count: number }[];
};

/**
 * The settings page's "last N days" usage view model. Only the caller's
 * own, non-revoked tokens are counted (a revoked token's history goes
 * with it — the view answers "what are my live integrations doing").
 * Rows are tiny (≤ 5 tokens × N days), so aggregation happens in JS
 * rather than with a GROUP BY over a join.
 */
export async function getApiTokenUsageSummary(userId: string, days = 30): Promise<ApiTokenUsageSummary> {
  const now = new Date();
  const dayKeys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    dayKeys.push(apiTokenDayKey(new Date(now.getTime() - i * 24 * 60 * 60 * 1000)));
  }
  const since = dayKeys[0]!;
  const tokens = await listApiTokensForUser(userId);
  const rows = await db
    .select({
      tokenId: schema.apiTokenDailyUsage.tokenId,
      day: schema.apiTokenDailyUsage.day,
      count: schema.apiTokenDailyUsage.count,
    })
    .from(schema.apiTokenDailyUsage)
    .innerJoin(schema.apiTokens, eq(schema.apiTokens.id, schema.apiTokenDailyUsage.tokenId))
    .where(and(eq(schema.apiTokens.userId, userId), gte(schema.apiTokenDailyUsage.day, since)));
  const byDay = new Map<string, number>(dayKeys.map((d) => [d, 0]));
  const byToken = new Map<string, number>();
  // Rows belonging to since-revoked tokens are skipped entirely, so the
  // three numbers always reconcile: total = Σ perDay = Σ perToken.
  const liveIds = new Set(tokens.map((t) => t.id));
  let total = 0;
  for (const r of rows) {
    if (!liveIds.has(r.tokenId)) continue;
    if (byDay.has(r.day)) byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.count);
    byToken.set(r.tokenId, (byToken.get(r.tokenId) ?? 0) + r.count);
    total += r.count;
  }
  return {
    total,
    perDay: dayKeys.map((day) => ({ day, count: byDay.get(day) ?? 0 })),
    perToken: tokens.map((t) => ({ tokenId: t.id, label: t.label, count: byToken.get(t.id) ?? 0 })),
  };
}

// How long daily usage rows are kept. The view only ever shows 30 days;
// 90 matches the house retention norm (soft-deleted events, read
// notifications) and leaves slack for month-boundary questions without
// letting a stats table grow forever (≤ 90 rows per token).
export const API_TOKEN_USAGE_RETENTION_DAYS = 90;

/** Housekeeping: drop daily-usage rows older than the retention window. */
export async function purgeOldApiTokenUsage(now = new Date()): Promise<{ purged: number }> {
  const cutoff = apiTokenDayKey(new Date(now.getTime() - (API_TOKEN_USAGE_RETENTION_DAYS - 1) * 24 * 60 * 60 * 1000));
  const rows = await db
    .delete(schema.apiTokenDailyUsage)
    .where(lt(schema.apiTokenDailyUsage.day, cutoff))
    .returning({ tokenId: schema.apiTokenDailyUsage.tokenId });
  return { purged: rows.length };
}
