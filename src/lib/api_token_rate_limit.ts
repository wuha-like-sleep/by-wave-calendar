// 每枚个人 API Token 的调用限流（固定窗口，进程内计数）。
//
// ── 为什么需要这一层 ──────────────────────────────────────────────────
// 全站已有按 IP 的全局限流（120 次/分钟），但它对 Token 场景有个盲区：
// 一枚泄漏的 Token 被放在很多 IP 后面轮着打，每个 IP 都在自己的额度内，
// 聚合起来却可以把账号的 API 面刷爆；反过来，一个失控的同步脚本（死循环
// 重试）在自己家里也会以线速打服务端。按 Token 再封一层顶，两种情况都
// 在「这枚凭据」这个维度上收口。只读 / 读写 Token 同口径 —— 限的是调用
// 速率，不是权限。
//
// ── 为什么是内存计数、不查库 ──────────────────────────────────────────
// 判定点在每次 API 鉴权成功之后，是全站最热的路径之一，为限流再加一次
// 数据库往返等于给每个请求都上了税。进程内 Map 的代价是多进程部署时
// 每进程各有一份额度（实际顶 = 进程数 × 配额）—— 这和全站限流用的
// @fastify/rate-limit LocalStore 是同一个取舍，部署形态（pm2 单进程）
// 下两者一致。窗口固定 60 秒：边界处最多放行 2 倍额度的一瞬突发，对
// 600/分钟这种宽松档无关紧要，换滑动窗口的复杂度不值。
//
// 计数只记「鉴权成功」的请求：鉴权失败在 session.ts 里走的是另一条路
// （统一 401 + 采样审计），不进这里；被限流拒绝的请求也不再计数，
// 否则窗口永远滚不出去。

const WINDOW_MS = 60_000;
/** 表的上限：满了先清过期桶，再按最旧淘汰。防 Token 数量异常时的内存增长。 */
const MAX_BUCKETS = 10_000;

type Bucket = { windowStart: number; count: number };
const buckets = new Map<string, Bucket>();

export type ApiTokenRateLimitResult = {
  allowed: boolean;
  /** 被拒时还要等多少秒窗口才滚动（向上取整，最小 1）；放行时为 0。 */
  retryAfterSeconds: number;
};

export function checkApiTokenRateLimit(
  tokenId: string,
  limit: number,
  now: number = Date.now(),
): ApiTokenRateLimitResult {
  const b = buckets.get(tokenId);
  if (!b || now - b.windowStart >= WINDOW_MS) {
    if (buckets.size >= MAX_BUCKETS) sweep(now);
    buckets.set(tokenId, { windowStart: now, count: 1 });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (b.count >= limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((b.windowStart + WINDOW_MS - now) / 1000)),
    };
  }
  b.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

function sweep(now: number): void {
  for (const [k, v] of buckets) {
    if (now - v.windowStart >= WINDOW_MS) buckets.delete(k);
  }
  // 还满就按插入顺序淘汰最旧的（Map 保持插入序）。被淘汰的 Token 下一
  // 次请求会开一个新窗口 —— 相当于提前解限，只在表被打满这种异常情况
  // 下发生，方向是安全的（不会误拒）。
  while (buckets.size >= MAX_BUCKETS) {
    const oldest = buckets.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    buckets.delete(oldest);
  }
}

/** 测试用：清掉全部计数（每个用例从干净状态开始）。 */
export function resetApiTokenRateLimits(): void {
  buckets.clear();
}
