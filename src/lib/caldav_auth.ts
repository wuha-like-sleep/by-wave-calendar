import type { FastifyReply, FastifyRequest } from "fastify";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { verifyPassword } from "./password.js";
import { looksLikeAppPassword, verifyAppPassword } from "./app_password.js";
import { userIsActive } from "./user_state.js";
import {
  acquireBcryptSlot, releaseBcryptSlot,
  guessRetryAfter, recordGuessFailure, clearGuessFailures,
  sendCalDavThrottled, logCalDavAuthFailure,
} from "./caldav_throttle.js";
import { isLocked } from "./login_lockout.js";

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
  // 同 caldav.ts 的 sendXml：send 之后必须让 handler 拿到 reply，
  // 否则响应体会在 compress 的 onSend 里被丢掉（本函数返回 null 供调用方
  // `return send401(...)` 用，reply 已发出这一点由调用方的 return 表达）。
  void reply.code(401).type("text/plain").send(body);
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

  // ── 闸二：这个邮箱被猜太多次了吗 ──
  // 键里不含 IP:换 IP 换不掉(第一版的键是 `${ip}\0${email}`,一个 IPv6 /64
  // 就是 2^64 个键,等于没有上限)。放在缓存命中之后 —— 缓存命中说明凭据是
  // 对的,不该被别人对同一个邮箱的乱猜连坐。
  const guessWait = guessRetryAfter(email);
  if (guessWait > 0) {
    logCalDavAuthFailure(req, email, "guess_throttled");
    return sendCalDavThrottled(reply, guessWait);
  }

  // In-flight dedup: while one request is paying for bcrypt, parallel
  // requests with the same credentials wait on its Promise instead of
  // each running their own bcrypt. iOS Calendar opens ~10 concurrent
  // connections during a sync, so this cuts cold-start auth cost from
  // 10×bcrypt to 1×bcrypt.
  let verifyPromise: Promise<VerifyResult> | undefined = inFlight.get(ckey);
  // 名额跟着「真的要跑一次 bcrypt」走,不是跟着请求走。
  // 一次正常同步是 10 个并发请求 × **同一条凭据**,去重之后只跑 1 次 bcrypt ——
  // 按请求占名额的话,并发上限会把一次正常同步挡掉一大半(实测 10 条挡 6 条)。
  // 而攻击者用的是互不相同的密码,每条都是新 ckey、新 bcrypt,照样一人一个名额。
  let heldSlot = false;
  if (verifyPromise) {
    coalesced++;
  } else {
    // ── 闸一：算力准入 ──
    // **名额在这里占、在下面的 finally 里还。** 第一版把「记一次失败」放在
    // await 之后,于是并发一波请求全部在计数还是 0 的时候通过 —— 闸门位置对
    // (在 bcrypt 之前),判据却在它要守的那个窗口里恒为 0。典型的
    // 「绿着而洞开着」:门开着,只是没人走到写计数那一行。占坑必须在进门那一刻。
    //
    // 它不看密码内容,所以「重复同一个错误密码」也照样算 —— 那正是第一版
    // 漏掉的变体:不同凭据集合永远是 1,而每一发都跑一次 bcrypt。
    const cpuWait = acquireBcryptSlot(req.ip);
    if (cpuWait > 0) {
      logCalDavAuthFailure(req, email, "cpu_throttled");
      return sendCalDavThrottled(reply, cpuWait);
    }
    heldSlot = true;
    // .finally 必须接在同一条链上再赋值，**不能单独调用**。
    // `fresh.finally(...)` 会派生出一条新 promise，而那条没有任何人 await：
    // 数据库抖一下（ECONNREFUSED / 连接被重置）verifyAndCache 一 reject，
    // 派生链跟着 reject → unhandledRejection → server.ts 的进程级兜底
    // 认定它不是良性双写，process.exit(1) → 整个服务挂掉。
    //
    // 而认证缓存只有 60 秒、Apple 后台轮询约 15 分钟一次，所以**每一次真实的
    // Apple 轮询都是缓存未命中**，也就是每一次都走这条路径。数据库只要抖一下，
    // 一条正常的日历同步就能把进程打死，PM2 拉起来后 DB 还没好就是 crash-loop。
    const fresh = verifyAndCache(email, password, ckey)
      .finally(() => inFlight.delete(ckey));
    inFlight.set(ckey, fresh);
    verifyPromise = fresh;
  }
  let verified: VerifyResult;
  try {
    verified = await verifyPromise;
  } finally {
    // 漏还一次,这个 IP 的并发额度就永久少一个 —— 占了就必须还。
    if (heldSlot) releaseBcryptSlot(req.ip);
  }
  if (!verified.ok) {
    // 只有走到这里才算「给了凭据但不对」。上面那个「完全没带 Authorization 头」
    // 的 401 绝不能算 —— Apple 的发现流程第一个请求按设计就是不带凭据的,
    // 算上它等于每次正常同步都自罚一次。
    recordGuessFailure(email, password);
    logCalDavAuthFailure(req, email, verified.errParam ?? "bad_credentials");
    return send401(reply, verified.message, verified.errParam);
  }
  // 对了就把这个邮箱的失败记录清掉 —— 人只是打错了几次,改对了不该继续背着。
  clearGuessFailures(email);

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

  // 全站的账号锁定,CalDAV 以前完全不看 —— 于是一个已经被网页端撞库锁掉的
  // 账号,从 CalDAV 依然可以接着猜。这里**只读不写**:CalDAV 不认证也能打,
  // 让它能把别人的账号锁死等于开了一条针对任意用户的拒绝服务。
  // 读而不写,既堵住「网页锁了还能从这儿继续猜」,又不给攻击者一根锁人的杠杆。
  // 位置在 bcrypt 之前:锁着的账号连密码都不用算。
  if (isLocked(user)) return { ok: false, message: "Account temporarily locked" };

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
