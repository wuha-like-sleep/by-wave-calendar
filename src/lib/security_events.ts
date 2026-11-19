// 主动防御的留痕层：认证失败与限流触发，按时间窗采样写进 admin_audit_log。
//
// ── 为什么要采样，而不是一条失败写一行 ────────────────────────────────
//
// 这三类事件的共同点是**量完全由攻击者决定**：
//   · 拿着词表喷 API Token 猜测（verifyApiToken 失败）
//   · 撞库 / 猜密码（各登录入口的认证失败）
//   · 把某个敏感接口顶到 429 之后还一直打（限流触发）
// 一条失败写一行的话，攻击者只要把量打上去，就能把审计表和磁盘一起打爆 ——
// 留痕机制自己变成拒绝服务。所以这里的形状是：
//
//   内存里按 (类别, IP, 目标) 分桶计数，10 分钟一个窗口；
//   只在累计数跨过里程碑（1、10、100、1000…）时写一行；
//   每行 details.failures 写的是**自上一行以来的增量**，不是累计 ——
//   这样后台聚合视图 SUM(failures) 得到的仍然是精确总数，采样不丢账。
//   details.totalInWindow 另给累计数，方便人直接读单行。
//
// 低量攻击也不会被采掉：每个桶的第一条失败必写一行（里程碑含 1）。
//
// 另外还有一道全局闸：每个窗口内最多写 EMIT_BUDGET 行（三类合计）。
// 攻击者同时轮换大量 IP 时，每个 (IP,目标) 桶的第一行都会想落库，
// 这道闸保证最坏情况下审计表的写入速率也是有界的；被压掉的行数会记进
// 下一行成功写出的 details.suppressedEmissions，不静默消失。
//
// 状态只在内存里：进程重启会清掉未跨里程碑的计数。对「看得见攻击」这个
// 目标来说可以接受 —— 重启后第一条失败立刻又会写一行。
//
// 红线：这里只记 token 的 prefix（8 位公开标识，本来就印在后台列表里），
// 绝不记完整 token、密码、验证码。

import type { FastifyRequest } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { audit } from "./audit.js";

/** 一个采样窗口的长度。 */
const WINDOW_MS = 10 * 60 * 1000;
/** 跨过这些累计数时写一行。 */
const MILESTONES = [1, 10, 100, 1000, 10000, 100000];
/** 每个窗口内三类事件合计最多落多少行。 */
const EMIT_BUDGET_PER_WINDOW = 300;
/** 内存里最多跟踪多少个桶，满了淘汰最老的（照 caldav_throttle 的做法）。 */
const MAX_TRACKED_KEYS = 10_000;

type Bucket = { count: number; emittedUpTo: number; firstAt: number };
const buckets = new Map<string, Bucket>();

let budgetWindowStart = 0;
let budgetUsed = 0;
let budgetSuppressed = 0;

function nextMilestone(emittedUpTo: number): number {
  for (const m of MILESTONES) if (m > emittedUpTo) return m;
  // 超过最后一个里程碑之后，每再攒 100000 条写一行。
  return (Math.floor(emittedUpTo / 100000) + 1) * 100000;
}

/**
 * 同步记一笔，并决定这一笔要不要落库。
 *
 * 计数和里程碑判定全部同步完成（不夹 await）—— 并发请求穿不过去，
 * 不会出现 caldav_throttle 第一版那种「写计数排在 await 之后」的洞。
 * 返回 null = 这一笔只计数不落库；返回 { delta, total } = 调用方该写一行，
 * delta 是自上一行以来的失败数（聚合 SUM 用），total 是窗口内累计。
 */
function hit(key: string): { delta: number; total: number; suppressed: number } | null {
  const now = Date.now();
  let b = buckets.get(key);
  if (b && now - b.firstAt >= WINDOW_MS) {
    buckets.delete(key);
    b = undefined;
  }
  if (!b) {
    if (buckets.size >= MAX_TRACKED_KEYS) {
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
    b = { count: 0, emittedUpTo: 0, firstAt: now };
    buckets.set(key, b);
  }
  b.count++;
  if (b.count < nextMilestone(b.emittedUpTo)) return null;
  const delta = b.count - b.emittedUpTo;
  const total = b.count;
  b.emittedUpTo = b.count;

  // 全局落库预算（按窗口对齐到桶的窗口长度，粗粒度即可）。
  const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  if (windowStart !== budgetWindowStart) {
    budgetWindowStart = windowStart;
    budgetUsed = 0;
    budgetSuppressed = 0;
  }
  if (budgetUsed >= EMIT_BUDGET_PER_WINDOW) {
    budgetSuppressed++;
    return null;
  }
  budgetUsed++;
  const suppressed = budgetSuppressed;
  budgetSuppressed = 0;
  return { delta, total, suppressed };
}

function sampledDetails(base: Record<string, unknown>, s: { delta: number; total: number; suppressed: number }): Record<string, unknown> {
  return {
    ...base,
    failures: s.delta,
    totalInWindow: s.total,
    windowMinutes: WINDOW_MS / 60_000,
    ...(s.suppressed > 0 ? { suppressedEmissions: s.suppressed } : {}),
  };
}

// ---------------------------------------------------------------------------
// API Token 验证失败
// ---------------------------------------------------------------------------

/**
 * 记一次 API Token 验证失败（session.ts 在回 401 之前调用）。
 * prefix 命中真实 token 时把行归到 token 主人名下，方便后台按账号聚合；
 * 命不中（纯猜测）actor 为空，靠 details.prefix + IP 归属。
 * 整个函数不抛错 —— 留痕失败绝不能影响认证本身的响应。
 */
export async function recordApiTokenAuthFailure(req: FastifyRequest, prefix: string): Promise<void> {
  try {
    const s = hit(`token|${req.ip}|${prefix}`);
    if (!s) return;
    let ownerId: string | null = null;
    if (prefix) {
      const [row] = await db
        .select({ userId: schema.apiTokens.userId })
        .from(schema.apiTokens)
        .where(and(eq(schema.apiTokens.prefix, prefix), isNull(schema.apiTokens.revokedAt)))
        .limit(1);
      ownerId = row?.userId ?? null;
    }
    await audit(req, ownerId, "api_token.auth_failed", {
      targetType: "api_token",
      details: sampledDetails({
        prefix: prefix || null,
        // 路径去掉 query —— 上面可能挂着搜索词之类不该进审计表的东西
        // （与 session.ts 里 idp 建号审计同口径）。
        path: String(req.url ?? "").split("?")[0],
      }, s),
    });
  } catch {
    // 留痕是旁路：写不进去也不要把 401 变成 500。
  }
}

// ---------------------------------------------------------------------------
// 登录失败（密码 / MFA 验证码，含查无此人）
// ---------------------------------------------------------------------------

/**
 * 记一次登录认证失败。各登录入口在 recordFailedLogin（计入账号锁定）的
 * 同一位置调用 —— 凡是计入锁定的失败，也在这里留痕；查无此人的尝试
 * userId 传 null、靠 details.email 归属（不记的话，攻击者喷洒邮箱时
 * 后台就完全看不见这批不存在的账号被试过）。
 */
export async function recordLoginAuthFailure(
  req: FastifyRequest,
  email: string,
  userId: string | null,
  stage?: "mfa",
): Promise<void> {
  try {
    const s = hit(`login|${req.ip}|${email}`);
    if (!s) return;
    await audit(req, userId, "auth.login_failed", {
      targetType: "user",
      ...(userId ? { targetId: userId } : {}),
      details: sampledDetails({
        email,
        ...(stage ? { stage } : {}),
      }, s),
    });
  } catch {
    // 同上：旁路失败不影响登录响应。
  }
}

// ---------------------------------------------------------------------------
// 限流触发（429）
// ---------------------------------------------------------------------------

/**
 * 只给这些敏感路由的 429 留痕 —— 全站每条路由的 429 都写的话，
 * 正常业务高峰（比如某个客户端抽风重试）就能把审计表灌满。
 * 键是归一化后的「方法 + 路由模板」：/api 与 /api/v1 是同一条路由
 * （与 rate_limit_store 的归一口径一致），模板里的 :id 保持原样。
 */
const SENSITIVE_RATE_LIMIT_ROUTES = new Set([
  "POST /login",
  "POST /login/mfa",
  "POST /register",
  "POST /forgot-password",
  "POST /verify-email",
  "POST /verify-email/resend",
  "POST /api/auth/login",
  "POST /api/auth/login-password",
  "POST /api/auth/login-mfa-verify",
  "POST /api/devices/pair-claim",
  "POST /app/settings/api-tokens",
  "POST /app/settings/api-tokens/:id/revoke",
  "POST /admin/api/tokens",
  "POST /admin/api/tokens/:id/revoke",
  "POST /admin/api/tokens/:id/rotate",
]);

export function rateLimitRouteOf(req: FastifyRequest): string {
  const raw = req.routeOptions?.url ?? String(req.url ?? "").split("?")[0] ?? "";
  const normalized = raw.replace(/^\/api\/v1(?=\/|$)/, "/api");
  return `${req.method} ${normalized}`;
}

/**
 * @fastify/rate-limit 的 onExceeded 回调（同步触发）：只做同步计数，
 * 落库的那一步异步飘走。非敏感路由直接忽略。
 */
export function recordRateLimitExceeded(req: FastifyRequest): void {
  const route = rateLimitRouteOf(req);
  if (!SENSITIVE_RATE_LIMIT_ROUTES.has(route)) return;
  const s = hit(`rl|${req.ip}|${route}`);
  if (!s) return;
  void audit(req, null, "rate_limit.exceeded", {
    targetType: "rate_limit",
    details: sampledDetails({ route }, s),
  }).catch(() => undefined);
}

/** 测试用：全部清空。 */
export function __resetSecurityEventsForTest(): void {
  buckets.clear();
  budgetWindowStart = 0;
  budgetUsed = 0;
  budgetSuppressed = 0;
}
