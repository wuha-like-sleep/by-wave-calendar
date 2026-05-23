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
// In-flight de-dup: iOS Calendar fires 10+ requests in parallel during a
// sync, so 10 requests can all miss the cache before the first one's
// bcrypt finishes — all 10 then re-run bcrypt. Map each cache key to
// the *promise* of the verify result so subsequent callers share the
// outcome instead of paying bcrypt N times.
type VerifyResult =
  | { ok: true; userId: string }
  | { ok: false; message: string; errParam?: string };
const inFlight = new Map<string, Promise<VerifyResult>>();
let coalesced = 0;

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
export function getCalDavAuthCacheStats(): { size: number; hits: number; misses: number; coalesced: number; hitRate: number } {
  const total = cacheHits + cacheMisses;
  return {
    size: authCache.size,
    hits: cacheHits,
    misses: cacheMisses,
    coalesced,
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

  // In-flight dedup: while one request is paying for bcrypt, parallel
  // requests with the same credentials wait on its Promise instead of
  // each running their own bcrypt. iOS Calendar opens ~10 concurrent
  // connections during a sync, so this cuts cold-start auth cost from
  // 10×bcrypt to 1×bcrypt.
  let verifyPromise: Promise<VerifyResult> | undefined = inFlight.get(ckey);
  if (verifyPromise) {
    coalesced++;
  } else {
    const fresh = verifyAndCache(email, password, ckey);
    inFlight.set(ckey, fresh);
    fresh.finally(() => inFlight.delete(ckey));
    verifyPromise = fresh;
  }
  const verified = await verifyPromise;
  if (!verified.ok) return send401(reply, verified.message, verified.errParam);

  // Re-fetch the (possibly cached-only-by-id) user row so we apply the
  // disabled-account check on every request even when the verify path
  // was a shared promise. This is a fast indexed PK lookup.
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, verified.userId)).limit(1);
  if (!user) return send401(reply, "Unauthorized");
  if (!userIsActive(user)) return send401(reply, "Account disabled", "account_disabled");

  // Mark that this connection went through the slow path so the request
  // log (if enabled in admin diagnostics) can show before/after impact.
  (req as { caldavAuthCacheMiss?: boolean }).caldavAuthCacheMiss = true;

  return user;
}

// Bcrypt + DB user lookup + password comparison. Returns a discriminated
// result; the caller decides how to render the 401. Called via the
// inFlight Promise map so parallel CalDAV requests share one verification.
async function verifyAndCache(email: string, password: string, ckey: string): Promise<VerifyResult> {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (!user) return { ok: false, message: "Unauthorized" };

  let verified = false;
  let usedAppPassword = false;
  if (looksLikeAppPassword(password)) {
    verified = await verifyAppPassword(user.id, password);
    if (verified) usedAppPassword = true;
  }
  // MFA on means the only valid CalDAV credential is an app password —
  // refuse primary password and tell the client how to fix it.
  if (!verified && !user.mfaEnabled) {
    verified = await verifyPassword(password, user.passwordHash);
  } else if (!verified && user.mfaEnabled && !usedAppPassword) {
    return {
      ok: false,
      message: "MFA 已启用 — 请在 /app/settings 创建应用密码",
      errParam: "mfa_requires_app_password",
    };
  }
  if (!verified) return { ok: false, message: "Unauthorized" };

  // Insert into the cache so the next ~10 requests from this client
  // skip bcrypt entirely. Evict LRU when full.
  if (authCache.size >= AUTH_CACHE_MAX) {
    const oldestKey = authCache.keys().next().value;
    if (oldestKey) authCache.delete(oldestKey);
  }
  authCache.set(ckey, { userId: user.id, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });

  return { ok: true, userId: user.id };
}
