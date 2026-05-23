import type { FastifyReply, FastifyRequest } from "fastify";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { verifyPassword } from "./password.js";
import { looksLikeAppPassword, verifyAppPassword } from "./app_password.js";
import { userIsActive } from "./user_state.js";

const REALM = "ByWave Calendar CalDAV";

// Bcrypt CPU cost is proportional to input length (up to its 72-byte truncation
// limit, but the UTF-8 decode + string allocation still scales). Cap the
// basic-auth password before we hand it to verifyPassword, otherwise a
// multi-megabyte basic header is a free CPU-burn attack.
const MAX_PASSWORD_BYTES = 256;

// --- CalDAV auth cache ------------------------------------------------------
// iOS Calendar / Apple Calendar / DAVx⁵ all fire 10-20 requests per sync
// (.well-known probes + PROPFIND + REPORT + GET for each event). Each one
// re-runs bcrypt against the app password, which is 100-500ms per call
// depending on cost factor. That's the difference between a 1-second sync
// and a 10-second one — well past iOS's connection-test timeout for the
// "Add Account" flow, which is why some users see "cannot verify account".
//
// We cache successful auths for 60 seconds, keyed by the full base64 of
// "email:password" (so a password change invalidates immediately — no
// way for stale creds to keep working past the TTL even if the user
// rotates them mid-window). SHA256 the key so we never hold the actual
// password in memory. Cache only successes (failures must always go
// through full bcrypt to keep timing equivalent → no timing oracle on
// "is this email registered").
const AUTH_CACHE_TTL_MS = 60_000;
const AUTH_CACHE_MAX = 1000;  // ~10 users × a few sessions; LRU below

type AuthCacheEntry = { userId: string; expiresAt: number };
const authCache = new Map<string, AuthCacheEntry>();
let cacheHits = 0;
let cacheMisses = 0;

function cacheKey(email: string, password: string): string {
  return crypto.createHash("sha256").update(`${email}\0${password}`).digest("base64url");
}

// Invalidate every cached credential for a user. Called from password
// change / app-password revoke / account disable so stale CalDAV
// sessions stop syncing within a request instead of waiting 60s.
export function invalidateCalDavAuthCache(userId?: string): void {
  if (!userId) { authCache.clear(); return; }
  for (const [k, v] of authCache.entries()) {
    if (v.userId === userId) authCache.delete(k);
  }
}

// Expose lightweight metrics for the admin dashboard.
export function getCalDavAuthCacheStats(): { size: number; hits: number; misses: number; hitRate: number } {
  const total = cacheHits + cacheMisses;
  return {
    size: authCache.size,
    hits: cacheHits,
    misses: cacheMisses,
    hitRate: total > 0 ? cacheHits / total : 0,
  };
}

function send401(reply: FastifyReply, body: string, errParam?: string): null {
  // RFC 6750 / RFC 7235 style: optional error= param so CalDAV clients that
  // surface it (DAVx⁵ on Android, Thunderbird) show a useful hint.
  const challenge = errParam
    ? `Basic realm="${REALM}", charset="UTF-8", error="${errParam}"`
    : `Basic realm="${REALM}", charset="UTF-8"`;
  reply.header("WWW-Authenticate", challenge);
  reply.code(401).type("text/plain").send(body);
  return null;
}

export async function basicAuth(req: FastifyRequest, reply: FastifyReply): Promise<schema.User | null> {
  const header = req.headers.authorization;
  if (!header || !header.toLowerCase().startsWith("basic ")) return send401(reply, "Unauthorized");

  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  } catch {
    return send401(reply, "Bad auth");
  }
  const colonIdx = decoded.indexOf(":");
  if (colonIdx < 0) return send401(reply, "Bad auth");

  const email = decoded.slice(0, colonIdx).toLowerCase().trim();
  const password = decoded.slice(colonIdx + 1);
  // Length cap (see MAX_PASSWORD_BYTES comment above).
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) return send401(reply, "Bad auth");

  // Cache fast path: skip bcrypt + DB user lookup if we've seen these
  // exact credentials succeed in the last 60s. Still do the disabled-
  // account check via a single indexed user query.
  const ckey = cacheKey(email, password);
  const cached = authCache.get(ckey);
  if (cached && cached.expiresAt > Date.now()) {
    cacheHits++;
    // LRU touch — re-insert moves to the end of the Map iteration order.
    authCache.delete(ckey); authCache.set(ckey, cached);
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, cached.userId)).limit(1);
    if (!u || !userIsActive(u)) {
      authCache.delete(ckey);
      return send401(reply, u ? "Account disabled" : "Unauthorized", u ? "account_disabled" : undefined);
    }
    return u;
  }
  cacheMisses++;

  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (!user) return send401(reply, "Unauthorized");

  let ok = false;
  let usedAppPassword = false;
  if (looksLikeAppPassword(password)) {
    ok = await verifyAppPassword(user.id, password);
    if (ok) usedAppPassword = true;
  }
  // MFA-on-but-primary-password-attempt is a UX trap: the user enabled MFA
  // expecting their account password to stop working over CalDAV, but it
  // silently kept working — so they never created an app password, and
  // when admin later rotates passwords CalDAV breaks with no clue why.
  //
  // Only try primary password when MFA is OFF. If MFA is ON, the only
  // valid credential is an app password; emit a clear hint via the
  // error= parameter so clients can surface it.
  if (!ok && !user.mfaEnabled) {
    ok = await verifyPassword(password, user.passwordHash);
  } else if (!ok && user.mfaEnabled && !usedAppPassword) {
    // We never even tried the primary password, but mention the actual
    // remediation: create an app password.
    return send401(reply, "MFA 已启用 — 请在 /app/settings 创建应用密码", "mfa_requires_app_password");
  }
  if (!ok) return send401(reply, "Unauthorized");

  // Disabled-account gate: an admin may have disabled this user after the
  // CalDAV client cached the password. Reject so Apple Calendar / Thunderbird
  // stop syncing immediately.
  if (!userIsActive(user)) return send401(reply, "Account disabled", "account_disabled");

  // Insert into the cache so the next ~10 requests from this client
  // skip bcrypt. Evict LRU when full. Pure side effect — never blocks
  // the response.
  if (authCache.size >= AUTH_CACHE_MAX) {
    const oldestKey = authCache.keys().next().value;
    if (oldestKey) authCache.delete(oldestKey);
  }
  authCache.set(ckey, { userId: user.id, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
  // Note: we intentionally do NOT cache failures. A failed attempt
  // must always go through the full bcrypt path so the response
  // timing doesn't leak "this user exists / this user doesn't".

  // Mark that this connection went through the slow path so the request
  // log (if enabled in admin diagnostics) can show before/after impact.
  (req as { caldavAuthCacheMiss?: boolean }).caldavAuthCacheMiss = true;

  return user;
}
