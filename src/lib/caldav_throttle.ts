// CalDAV 认证失败节流。
//
// ── 为什么需要 ──────────────────────────────────────────────────────────
//
// CalDAV 的每一条路由都写着 config: { rateLimit: false }。那不是「放宽」,
// 是**根本没挂上限流钩子** —— @fastify/rate-limit 的 onRoute 里
// `routeOptions.config.rateLimit != null` 对 false 成立(JS 里 false != null),
// 于是进了那个分支、既不报错也不调 addRouteRateHook,而会挂全局限流器的
// `else if (global)` 分支被跳过了。全站唯一一处完全不受限流约束的认证入口。
//
// 后果两条:
//   1. 任何人知道一个注册邮箱,就能以**不受任何限制**的速率在线猜这个账号的
//      主密码(两步验证关着时,CalDAV 收的就是主密码)。服务端不留痕迹、
//      不触发账号锁定、后台也看不出正在被打。
//   2. 更紧迫的一半,**不需要猜中任何密码**:每个请求都强制服务端在唯一的
//      主线程上跑一次 cost 12 的纯 JS bcrypt。用大量**不同**密码并发打,
//      in-flight 去重合并不了(它只合并完全相同的凭据),单进程就能被拖死 ——
//      网页、API、三端同步一起停。
//
// ── 为什么限的是「失败」而不是「请求数」────────────────────────────────
//
// CalDAV 客户端的现实(caldav_auth.ts 顶上那段注释自己就写了):iOS/macOS
// 日历和 DAVx⁵ 一次同步打 10-20 个请求、约 10 个并发连接,Apple 后台约
// 15 分钟轮询一次;家里几台设备、公司整层楼都可能共用一个出口 IP。
// 按请求数限 IP,正是会把正常用户挡在门外的那种做法。
//
// 按「失败」限,配置正确的客户端稳态下产生 0 次失败,成本为零。
//
// 而且计的是**不同的错误凭据个数**,不是失败请求数:用户改了密码、客户端
// 还拿着旧的猛打十几个并发请求 —— 那是同一个错误凭据,只算 1 次。
// 不这么算的话,阈值必须放到 10-20 才不误伤,而那对攻击者就太松了。

import type { FastifyReply, FastifyRequest } from "fastify";
import crypto from "node:crypto";

/** 同一个 (IP, 邮箱) 在窗口内允许试错的**不同密码**个数。
 *  人真的连试 5 个不同密码,本来就该被拦一下。 */
const PER_ACCOUNT_MAX = 5;
const PER_ACCOUNT_WINDOW_MS = 15 * 60 * 1000;

/** 同一个 IP 在窗口内允许的**不同失败凭据**总数 —— 拦「拿一个邮箱列表喷」。
 *  50 足够高:一个小办公室同一天有三个人重配客户端不会误伤。 */
const PER_IP_MAX = 50;
const PER_IP_WINDOW_MS = 60 * 60 * 1000;

/** 两张表各自的行数上限。攻击者可以靠轮换邮箱/IP 把表撑大,
 *  所以必须有上限;满了就按最老的窗口淘汰。 */
const MAX_TRACKED = 20_000;

type Window = { creds: Set<string>; firstAt: number };

const perAccount = new Map<string, Window>();
const perIp = new Map<string, Window>();

let blockedRequests = 0;
let lockedKeys = 0;

/** 凭据指纹。绝不留明文密码 —— 这张表比认证缓存活得久得多。 */
function credFingerprint(email: string, password: string): string {
  return crypto.createHash("sha256").update(`${email}\0${password}`).digest("base64url");
}

function bump(map: Map<string, Window>, key: string, cred: string, windowMs: number): number {
  const now = Date.now();
  let w = map.get(key);
  if (w && now - w.firstAt > windowMs) w = undefined;   // 窗口过期,重新开始
  if (!w) {
    if (map.size >= MAX_TRACKED) {
      // 淘汰最老的那条。Map 的迭代顺序就是插入顺序,够用。
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    w = { creds: new Set(), firstAt: now };
    map.set(key, w);
  }
  w.creds.add(cred);
  return w.creds.size;
}

function overLimit(map: Map<string, Window>, key: string, windowMs: number, max: number): number {
  const w = map.get(key);
  if (!w) return 0;
  if (Date.now() - w.firstAt > windowMs) { map.delete(key); return 0; }
  return w.creds.size >= max ? Math.ceil((w.firstAt + windowMs - Date.now()) / 1000) : 0;
}

/**
 * 这次请求该不该在跑 bcrypt **之前**就被拒掉。
 *
 * 返回 0 表示放行;返回正数表示还要等多少秒(直接当 Retry-After 用)。
 *
 * 必须在 bcrypt 之前调用 —— 挡在后面的话,DoS 那一半完全没被挡住:
 * 攻击者要的就是让你跑 bcrypt,他不在乎你最后回什么。
 */
export function calDavAuthRetryAfter(ip: string, email: string): number {
  const a = overLimit(perAccount, `${ip}\0${email}`, PER_ACCOUNT_WINDOW_MS, PER_ACCOUNT_MAX);
  const b = overLimit(perIp, ip, PER_IP_WINDOW_MS, PER_IP_MAX);
  return Math.max(a, b);
}

/**
 * 记一次认证失败。
 *
 * **只在「给了凭据但不对」时调用。** 完全没带 Authorization 头的那个 401
 * 绝不能算进来 —— Apple 的发现流程第一个请求按设计就是不带凭据的,
 * 算上它等于每次正常同步都自罚一次。
 *
 * 「这个邮箱没注册」也要记:不记的话,攻击者可以靠「哪些邮箱会被节流」
 * 反推出哪些邮箱注册过。
 */
export function recordCalDavAuthFailure(ip: string, email: string, password: string): void {
  const cred = credFingerprint(email, password);
  const n = bump(perAccount, `${ip}\0${email}`, cred, PER_ACCOUNT_WINDOW_MS);
  bump(perIp, ip, cred, PER_IP_WINDOW_MS);
  if (n === PER_ACCOUNT_MAX) lockedKeys++;
}

/** 认证成功之后清掉这个 (IP, 邮箱) 的失败记录 —— 人只是打错了几次,
 *  改对了就不该继续背着。IP 那层不清:横扫是另一回事。 */
export function clearCalDavAuthFailures(ip: string, email: string): void {
  perAccount.delete(`${ip}\0${email}`);
}

export function noteCalDavAuthBlocked(): void {
  blockedRequests++;
}

/** 给后台看的。没有这个的话,「正在被撞库」这件事在服务端是完全不可见的 ——
 *  这也正是修之前的状态。 */
export function getCalDavThrottleStats(): {
  trackedAccounts: number; trackedIps: number; blockedRequests: number; lockedKeys: number;
} {
  return {
    trackedAccounts: perAccount.size,
    trackedIps: perIp.size,
    blockedRequests,
    lockedKeys,
  };
}

/** 把 429 发出去。**不是 401** —— 401 会让 CalDAV 客户端以为凭据错了,
 *  有些会弹窗要用户重输密码,那正好把用户推去做更多次失败尝试。
 *  429 + Retry-After 是「你太快了,等一下」,主流客户端会退避。 */
export function sendCalDavThrottled(reply: FastifyReply, retryAfterSec: number): null {
  noteCalDavAuthBlocked();
  reply.header("Retry-After", String(Math.max(1, retryAfterSec)));
  void reply.code(429).type("text/plain").send("Too many failed authentication attempts");
  return null;
}

/** 测试用:把两张表清空。 */
export function __resetCalDavThrottleForTest(): void {
  perAccount.clear();
  perIp.clear();
  blockedRequests = 0;
  lockedKeys = 0;
}

export const CALDAV_THROTTLE_LIMITS = {
  PER_ACCOUNT_MAX, PER_ACCOUNT_WINDOW_MS, PER_IP_MAX, PER_IP_WINDOW_MS,
} as const;

/** 只在 basicAuth 里用:把「这次失败」记下来,顺便给日志一条结构化的记录。
 *  没有 actorUserId,所以不进 admin 审计表(那张表的语义是「管理员做了什么」)。 */
export function logCalDavAuthFailure(req: FastifyRequest, email: string, reason: string): void {
  req.log.warn({ msg: "caldav_auth_failed", ip: req.ip, email, reason }, "caldav_auth_failed");
}
