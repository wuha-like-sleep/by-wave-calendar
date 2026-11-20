// 每 Token 限流的纯逻辑口径（lib/api_token_rate_limit.ts）：
// 固定 60 秒窗口、窗口内计数、超限给 Retry-After、窗口滚动后恢复、
// 不同 Token 互不影响、被拒的请求不消耗也不延长窗口。
// 时间靠注入的 now 控制，不等真的一分钟。
import { describe, it, expect, beforeEach } from "vitest";
import { checkApiTokenRateLimit, resetApiTokenRateLimits } from "../src/lib/api_token_rate_limit.js";

const T0 = 1_800_000_000_000;

beforeEach(() => { resetApiTokenRateLimits(); });

describe("api token rate limit", () => {
  it("配额内放行，retryAfter 为 0", () => {
    for (let i = 0; i < 3; i++) {
      const r = checkApiTokenRateLimit("tok-a", 3, T0 + i * 1000);
      expect(r.allowed).toBe(true);
      expect(r.retryAfterSeconds).toBe(0);
    }
  });

  it("超限拒绝，Retry-After 指向窗口结束", () => {
    for (let i = 0; i < 3; i++) checkApiTokenRateLimit("tok-a", 3, T0);
    const r = checkApiTokenRateLimit("tok-a", 3, T0 + 10_000);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSeconds).toBe(50);
  });

  it("窗口滚动后恢复放行（新窗口重新计数）", () => {
    for (let i = 0; i < 3; i++) checkApiTokenRateLimit("tok-a", 3, T0);
    expect(checkApiTokenRateLimit("tok-a", 3, T0 + 59_999).allowed).toBe(false);
    expect(checkApiTokenRateLimit("tok-a", 3, T0 + 60_000).allowed).toBe(true);
    expect(checkApiTokenRateLimit("tok-a", 3, T0 + 60_001).allowed).toBe(true);
  });

  it("不同 Token 互不影响", () => {
    for (let i = 0; i < 2; i++) checkApiTokenRateLimit("tok-a", 2, T0);
    expect(checkApiTokenRateLimit("tok-a", 2, T0).allowed).toBe(false);
    expect(checkApiTokenRateLimit("tok-b", 2, T0).allowed).toBe(true);
  });

  it("被拒的请求不延长窗口：窗口仍按首次请求的时间滚动", () => {
    checkApiTokenRateLimit("tok-a", 1, T0);
    // 窗口内反复被拒，不该把窗口往后推。
    for (let i = 1; i <= 5; i++) {
      expect(checkApiTokenRateLimit("tok-a", 1, T0 + i * 10_000).allowed).toBe(false);
    }
    expect(checkApiTokenRateLimit("tok-a", 1, T0 + 60_000).allowed).toBe(true);
  });

  it("reset 后计数清零", () => {
    checkApiTokenRateLimit("tok-a", 1, T0);
    expect(checkApiTokenRateLimit("tok-a", 1, T0).allowed).toBe(false);
    resetApiTokenRateLimits();
    expect(checkApiTokenRateLimit("tok-a", 1, T0).allowed).toBe(true);
  });
});
