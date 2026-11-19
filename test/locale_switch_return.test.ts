import { describe, it, expect } from "vitest";
import { sanitizeInternalPath, sanitizeReturnTo } from "../src/lib/return_to.js";

// 语言切换器的回跳判据。
//
// 切换器挂在每一页上，切完要回到刚才那一页。它一度复用登录回跳的
// sanitizeReturnTo —— 那个白名单只许 /app /admin /web-pair
// /desktop-pair /oauth，于是从任何公开页（首页、下载、支持、法律、
// 重置密码……）切语言都会被判不合法、兜底去 /app，未登录用户再被
// /app 甩到登录页：用户只是想换个语言看首页，却被送去登录。
//
// sanitizeInternalPath 是切换器自己的判据：不套登录白名单，但防
// 开放重定向与响应头注入的关卡一条不少。这里守住两边都不许退化：
// 公开路径要放行，攻击形态要挡住，登录白名单本身不许被顺手放宽。

describe("sanitizeInternalPath（语言切换回跳）", () => {
  it("放行公开页与应用内页面（含 query）", () => {
    for (const p of [
      "/",
      "/download",
      "/support",
      "/privacy",
      "/forgot-password",
      "/reset-password/abc123",
      "/login",
      "/register",
      "/app",
      "/app/settings",
      "/app/search?q=%E4%BC%9A%E8%AE%AE&from=2026-01-01",
      "/book/some-link",
    ]) {
      expect(sanitizeInternalPath(p)).toBe(p);
    }
  });

  it("去掉片段（服务端跳转带不过去）", () => {
    expect(sanitizeInternalPath("/support#api-token")).toBe("/support");
  });

  it("挡住开放重定向与协议相对地址", () => {
    for (const p of [
      "//evil.example.com",
      "/\\evil.example.com",
      "https://evil.example.com",
      "http:evil.example.com",
      "javascript:alert(1)",
      "",
      "app",
      null,
      undefined,
      42,
    ]) {
      expect(sanitizeInternalPath(p)).toBeNull();
    }
  });

  it("挡住反斜杠与控制字符（响应头注入）", () => {
    expect(sanitizeInternalPath("/app\\@evil.example.com")).toBeNull();
    expect(sanitizeInternalPath("/app\r\nLocation: https://evil.example.com")).toBeNull();
    expect(sanitizeInternalPath("/app\n")).toBeNull();
  });

  it("长度上限 500", () => {
    expect(sanitizeInternalPath("/" + "a".repeat(499))).not.toBeNull();
    expect(sanitizeInternalPath("/" + "a".repeat(500))).toBeNull();
  });

  it("登录白名单没有被顺手放宽（两套判据分工不变）", () => {
    // 公开页对登录回跳仍然不合法 —— 登录流程只去它那几个入口。
    expect(sanitizeReturnTo("/download")).toBeNull();
    expect(sanitizeReturnTo("/")).toBeNull();
    expect(sanitizeReturnTo("/app")).toBe("/app");
  });
});
