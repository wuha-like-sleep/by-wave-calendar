// CalDAV 认证的两道闸：**猜密码** 和 **烧 CPU**。
//
// 这两件事必须分开判，用同一个判据一定会漏掉一半 —— 第一版就是这么漏的，
// 下面「第一版错在哪」有完整记录，别再合回去。
//
// ── 背景：为什么 CalDAV 特殊 ──────────────────────────────────────────
//
// CalDAV 的每一条路由都写着 config: { rateLimit: false }。那不是「放宽」，
// 是**根本没挂上限流钩子** —— @fastify/rate-limit 的 onRoute 里
// `config.rateLimit != null` 对 false 成立（JS 里 false != null），于是进了
// 那个分支、既不报错也不调 addRouteRateHook，而会挂全局限流器的那个 else
// 分支被跳过了。全站唯一一处完全不受限流约束的认证入口。
//
// 而两步验证关着时（账号默认状态），CalDAV 收的就是账号主密码；
// 密码校验是 bcryptjs —— 纯 JS、cost 12、每次 250-400ms，跑在唯一的主线程上。
//
// ── 第一版错在哪（三条，都是实测确认的）────────────────────────────────
//
// 1. **check-then-act**：闸门同步读内存计数，而写计数排在 `await verify` 之后。
//    并发一波请求全部在计数还是 0 的时候通过 —— 而「并发打一波」正是 DoS 的
//    标准做法。闸门位置对（在 bcrypt 之前），但判据在它要守的那个窗口里恒为 0。
//    典型的「绿着而洞开着」：门开着，只是没人走到写计数那一行。
// 2. **判据数的是「不同凭据个数」**，而烧 CPU 不需要换密码：同一个错误密码
//    重复发，集合永远是 1，永远不触发，而每一发都跑一次 bcrypt。
//    更难堪的是，第一版的测试把这个行为**钉成了期望**：连发 20 次同一个
//    错误密码、断言每次都是 401（也就是每次都跑了 bcrypt）。
// 3. **按账号的键里含 IP**，换 IP 就从 0 开始。一个 IPv6 /64 就是 2^64 个键。
//
// ── 现在的形状 ────────────────────────────────────────────────────────
//
// **闸一：CPU 准入**（挡烧 CPU，不关心密码内容）
//   按 IP 记「跑了多少次 bcrypt」和「此刻有几个在跑」，**名额在 await 之前占、
//   在 finally 里还**。这样并发穿不过去，重复同一个密码也照样算。
//   它是资源限制不是认证判定，所以回 429 + Retry-After，退避后自己恢复。
//
// **闸二：猜密码**（挡撞库，不关心 CPU）
//   按**邮箱**记不同的错误凭据个数，键里**不含 IP** —— 换 IP 换不掉。
//   「不同凭据」这个判据在这里是对的：用户改了密码、客户端还攥着旧的猛打，
//   那是同一个错误凭据，只算一次，不误伤。
//
// 另外 basicAuth 会**遵守**全站的账号锁定（isLocked），但**不写**它 ——
// 不写是故意的：CalDAV 不认证也能打，让它能把别人的账号锁死，等于开了一条
// 针对任意用户的拒绝服务。读而不写，既堵住「网页锁了还能从 CalDAV 继续猜」，
// 又不给攻击者一根锁人的杠杆。

import type { FastifyReply, FastifyRequest } from "fastify";
import crypto from "node:crypto";

// ── 闸一：CPU 准入 ──
/** 同一个 IP 每分钟允许触发多少次 bcrypt。
 *  正常客户端的成本：认证缓存 60 秒，所以一条凭据每分钟最多 1 次；
 *  一家人几台设备、几个账号，个位数。60 给得很宽，稳态下碰不到。 */
const BCRYPT_PER_IP_PER_MIN = 60;
const BCRYPT_WINDOW_MS = 60 * 1000;
/** 同一个 IP 同时在跑的 bcrypt 上限。正常客户端一次同步开约 10 个并发连接，
 *  但那 10 个是**同一条凭据**，走 in-flight 去重只占 1 个名额。 */
const BCRYPT_INFLIGHT_PER_IP = 4;

// ── 闸二：猜密码 ──
/** 同一个**邮箱**在窗口内允许试错的**不同密码**个数。键里不含 IP。
 *  10 比第一版的 5 松一点：因为现在换 IP 不再重置，10 次是真的 10 次。 */
const GUESS_MAX = 10;
const GUESS_WINDOW_MS = 60 * 60 * 1000;
/** 一个窗口里最多记多少个不同指纹 —— 不封顶的话一次爆发就能撑出一个无界 Set。
 *  到顶之后就当作「已超限」，不再往里塞。 */
const GUESS_SET_CAP = 64;

/** 两张表各自的行数上限；满了按最老的窗口淘汰。 */
const MAX_TRACKED = 20_000;

type GuessWindow = { creds: Set<string>; firstAt: number; overflowed: boolean };
type CpuWindow = { count: number; firstAt: number; inflight: number };

const guessByEmail = new Map<string, GuessWindow>();
const cpuByIp = new Map<string, CpuWindow>();

let blockedRequests = 0;
let lockedAccounts = 0;
let cpuRejections = 0;

/** 凭据指纹。绝不留明文密码 —— 这张表比认证缓存活得久得多。 */
function credFingerprint(email: string, password: string): string {
  return crypto.createHash("sha256").update(`${email}\0${password}`).digest("base64url");
}

function evictIfFull(map: Map<string, unknown>): void {
  if (map.size < MAX_TRACKED) return;
  const oldest = map.keys().next().value;
  if (oldest !== undefined) map.delete(oldest);
}

// ---------------------------------------------------------------------------
// 闸一：CPU 准入
// ---------------------------------------------------------------------------

/**
 * 申请一个「跑 bcrypt」的名额。
 *
 * **必须在 await 之前调用，而且必须配对 releaseBcryptSlot()。**
 * 第一版的洞就是「读的状态要等 await 之后才写」—— 占坑要发生在进门那一刻，
 * 不能等出门时再补记，否则并发一波全部穿过去。
 *
 * 返回 0 表示放行；正数表示还要等多少秒。
 */
export function acquireBcryptSlot(ip: string): number {
  const now = Date.now();
  let w = cpuByIp.get(ip);
  if (w && now - w.firstAt > BCRYPT_WINDOW_MS) {
    // 窗口翻篇。inflight 是跨窗口的实时值，不能跟着清零。
    w = { count: 0, firstAt: now, inflight: w.inflight };
    cpuByIp.set(ip, w);
  }
  if (!w) {
    evictIfFull(cpuByIp);
    w = { count: 0, firstAt: now, inflight: 0 };
    cpuByIp.set(ip, w);
  }
  if (w.inflight >= BCRYPT_INFLIGHT_PER_IP) {
    cpuRejections++;
    return 1;  // 同时在跑的太多，等一秒就够 —— 这是瞬时拥塞不是封禁
  }
  if (w.count >= BCRYPT_PER_IP_PER_MIN) {
    cpuRejections++;
    return Math.max(1, Math.ceil((w.firstAt + BCRYPT_WINDOW_MS - now) / 1000));
  }
  w.count++;
  w.inflight++;
  return 0;
}

/** 归还名额。**必须放在 finally 里** —— 漏还一次，这个 IP 的并发额度就永久少一个。 */
export function releaseBcryptSlot(ip: string): void {
  const w = cpuByIp.get(ip);
  if (w && w.inflight > 0) w.inflight--;
}

// ---------------------------------------------------------------------------
// 闸二：猜密码
// ---------------------------------------------------------------------------

/** 这个**邮箱**现在是不是已经被猜太多次了。键里不含 IP，换 IP 换不掉。
 *  返回 0 放行，正数是还要等多少秒。 */
export function guessRetryAfter(email: string): number {
  const w = guessByEmail.get(email);
  if (!w) return 0;
  const now = Date.now();
  if (now - w.firstAt > GUESS_WINDOW_MS) { guessByEmail.delete(email); return 0; }
  const over = w.overflowed || w.creds.size >= GUESS_MAX;
  return over ? Math.max(1, Math.ceil((w.firstAt + GUESS_WINDOW_MS - now) / 1000)) : 0;
}

/**
 * 记一次认证失败。
 *
 * **只在「给了凭据但不对」时调用。** 完全没带 Authorization 头的那个 401
 * 绝不能算 —— Apple 的发现流程第一个请求按设计就是不带凭据的，
 * 算上它等于每次正常同步都自罚一次。
 *
 * 「这个邮箱没注册」也要记：不记的话，攻击者可以靠「哪些邮箱会被节流」
 * 反推出哪些邮箱注册过。
 */
export function recordGuessFailure(email: string, password: string): void {
  const now = Date.now();
  let w = guessByEmail.get(email);
  if (w && now - w.firstAt > GUESS_WINDOW_MS) w = undefined;
  if (!w) {
    evictIfFull(guessByEmail);
    w = { creds: new Set(), firstAt: now, overflowed: false };
    guessByEmail.set(email, w);
  }
  if (w.creds.size >= GUESS_SET_CAP) { w.overflowed = true; return; }
  const before = w.creds.size;
  w.creds.add(credFingerprint(email, password));
  if (before < GUESS_MAX && w.creds.size >= GUESS_MAX) lockedAccounts++;
}

/** 认证成功之后清掉这个邮箱的失败记录 —— 人只是打错了几次，改对了不该继续背着。 */
export function clearGuessFailures(email: string): void {
  guessByEmail.delete(email);
}

// ---------------------------------------------------------------------------

export function noteCalDavAuthBlocked(): void {
  blockedRequests++;
}

/** 给后台看的。没有这个的话，「正在被撞库」这件事在服务端是完全不可见的 ——
 *  这也正是修之前的状态。 */
export function getCalDavThrottleStats(): {
  trackedAccounts: number; trackedIps: number;
  blockedRequests: number; lockedAccounts: number; cpuRejections: number;
} {
  return {
    trackedAccounts: guessByEmail.size,
    trackedIps: cpuByIp.size,
    blockedRequests,
    lockedAccounts,
    cpuRejections,
  };
}

/** 把 429 发出去。**不是 401** —— 401 会让 CalDAV 客户端以为凭据错了，
 *  有些会弹窗要用户重输密码，那正好把用户推去做更多次失败尝试。
 *  429 + Retry-After 是「你太快了，等一下」，主流客户端会退避。 */
export function sendCalDavThrottled(reply: FastifyReply, retryAfterSec: number): null {
  noteCalDavAuthBlocked();
  reply.header("Retry-After", String(Math.max(1, retryAfterSec)));
  void reply.code(429).type("text/plain").send("Too many failed authentication attempts");
  return null;
}

/** 测试用：全部清空。 */
export function __resetCalDavThrottleForTest(): void {
  guessByEmail.clear();
  cpuByIp.clear();
  blockedRequests = 0;
  lockedAccounts = 0;
  cpuRejections = 0;
}

export const CALDAV_THROTTLE_LIMITS = {
  BCRYPT_PER_IP_PER_MIN, BCRYPT_INFLIGHT_PER_IP, BCRYPT_WINDOW_MS,
  GUESS_MAX, GUESS_WINDOW_MS, GUESS_SET_CAP,
} as const;

/** 结构化日志。没有 actorUserId，所以不进 admin 审计表
 *  （那张表的语义是「管理员做了什么」）。 */
export function logCalDavAuthFailure(req: FastifyRequest, email: string, reason: string): void {
  req.log.warn({ msg: "caldav_auth_failed", ip: req.ip, email, reason }, "caldav_auth_failed");
}
