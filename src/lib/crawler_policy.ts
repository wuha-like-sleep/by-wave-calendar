// 哪些页面不许被搜索引擎收录。
//
// ── 为什么单独成一个文件 ────────────────────────────────────────────────
//
// 这份名单原来有两份：server.ts 里给 X-Robots-Tag 用的前缀表，和 /robots.txt
// 里手写的 Disallow 列表。两份一起写错了 —— 都写成 "/booking"，而公开预约页的
// 真实路径是 /book/…、取消预约页是 /book-cancel/…，一个字母都没对上，两者都被
// 收录。取消页的地址里带着令牌，谁拿到谁就能取消那次预约。
//
// 现在只有这一份，robots.txt 从它生成；并且有一条门禁盯着「凡是地址里带令牌的
// 页面，都必须在这份名单里」，而那条门禁是按真实注册的路由去查的，不是按这份
// 名单自己去查自己。

/** 以这些前缀开头的页面不收录。公开的介绍页、下载页、法律页不在里面，照常收录。 */
export const NOINDEX_PREFIXES: readonly string[] = [
  "/app", "/admin", "/api", "/login", "/register", "/forgot-password",
  "/reset-password", "/verify-email", "/locale",
  // 公开预约页和取消预约页（原来误写成 /booking）。
  "/book", "/book-cancel",
  "/embed",
  "/invite", "/event-invite", "/oauth", "/sign-out",
];

export function isNoindexPath(pathname: string): boolean {
  const p = pathname.split("?")[0] || "/";
  return NOINDEX_PREFIXES.some((pre) => p === pre || p.startsWith(pre + "/"));
}

/** /robots.txt 的内容，从同一份名单生成。 */
export function robotsTxt(): string {
  return ["User-agent: *", ...NOINDEX_PREFIXES.map((p) => `Disallow: ${p}`), ""].join("\n");
}
