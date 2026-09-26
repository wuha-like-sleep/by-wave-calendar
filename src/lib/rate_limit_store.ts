// 限流计数：同一条路由挂在 /api 和 /api/v1 两个前缀下时，**共用一个计数器**。
//
// ── 为什么需要 ──────────────────────────────────────────────────────────
//
// server.ts 把同一批路由注册了两遍（/api 是旧的，/api/v1 是新的）。
// @fastify/rate-limit 给每条带自己限流配置的路由建一个**独立**的计数器
// （store.child() 每次 new 一个新的 LocalStore），于是同一个接口在两个前缀下
// 各有一份额度 —— 换着打，额度直接翻倍。实测：限每分钟 6 次的接口换着前缀打，
// 能过 12 次。
//
// 受影响的恰好是最怕被猜的几条：密码登录、两步验证的 6 位验证码、6 位配对码、
// 改密码、删账号。库自带的 groupId 在这里帮不上忙 —— 它只是往 key 后面拼一段，
// 而两个前缀的计数器本来就是两张不同的表。
//
// ── 做法 ─────────────────────────────────────────────────────────────
//
// 自定义 store：child() 按「方法 + 去掉 /v1 之后的路径」缓存，同一条逻辑路由
// 的两个挂载点拿到**同一个** LocalStore 实例。计数逻辑本身原样用库里那份，
// 不自己重写（过期、continueExceeding、指数退避都在里面）。

import { createRequire } from "node:module";
import type { FastifyRateLimitStoreCtor } from "@fastify/rate-limit";

type IncrCallback = (err: Error | null, res?: { current: number; ttl: number }) => void;
// 库的类型声明里 incr 只有两个参数，而运行时实际传四个（key, cb, timeWindow, max）——
// 见 @fastify/rate-limit/index.js 的 applyRateLimit。后两个写成可选，两边都满足。
interface Store {
  incr(key: string, cb: IncrCallback, timeWindow?: number, max?: number): void;
  child(params: ChildParams): Store;
}
type ChildParams = {
  continueExceeding?: boolean;
  exponentialBackoff?: boolean;
  routeInfo?: { method?: string | string[]; url?: string };
};
type LocalStoreCtor = new (continueExceeding?: boolean, exponentialBackoff?: boolean, cache?: number) => Store;

const require = createRequire(import.meta.url);
const LocalStore = require("@fastify/rate-limit/store/LocalStore") as LocalStoreCtor;

/** 两个挂载点归一成同一个名字：/api/v1/xxx 和 /api/xxx 是同一条路由。 */
export function rateLimitRouteKey(method: string | string[] | undefined, url: string | undefined): string {
  const m = Array.isArray(method) ? [...method].sort().join(",") : (method ?? "");
  const u = (url ?? "").replace(/^\/api\/v1(?=\/|$)/, "/api");
  return `${m} ${u}`;
}

/** 给 @fastify/rate-limit 的 `store` 选项用。 */
export function makeSharedRouteStore(): FastifyRateLimitStoreCtor {
  // 同一个进程里所有 child 共享这一张表。
  const byRoute = new Map<string, Store>();

  return class SharedRouteStore implements Store {
    private readonly base: Store;
    constructor(globalParams: ChildParams) {
      // 全局限流（没配自己限流的路由）照旧：一个计数器，按 IP。
      this.base = new LocalStore(globalParams?.continueExceeding, globalParams?.exponentialBackoff);
    }
    incr(key: string, cb: IncrCallback, timeWindow?: number, max?: number): void {
      this.base.incr(key, cb, timeWindow, max);
    }
    child(params: ChildParams): Store {
      const k = rateLimitRouteKey(params.routeInfo?.method, params.routeInfo?.url);
      let s = byRoute.get(k);
      if (!s) {
        s = new LocalStore(params.continueExceeding, params.exponentialBackoff);
        byRoute.set(k, s);
      }
      return s;
    }
  } as unknown as FastifyRateLimitStoreCtor;
}
