// iOS 应用内公告的读取口径。
//
// iOS 没有自更新：新版只在 App Store 里，App 自己不知道。所以「商店里
// 有新版」由服务端喊：管理员在 /admin/client-release 发一条公告
// （存 site_settings，见 schema.ts），iOS 客户端启动时拉
// GET /api/app/ios/announcement，自己比版本、自己记「这个版本关过了」。
//
// 这里只管一件事：settings 里那几列 → 接口该返回什么。返回 null =
// 没有公告（接口回 404）。判空口径集中在这里，别让路由和后台各写一份：
// 「后台说已发布、接口说没有」正是这个仓库在更新清单上付过账的形状。

import type { SettingsView } from "./site_settings.js";

export interface IosAnnouncement {
  /** 目标 App 版本号，如 "1.8.0"。同时是客户端的去重键。 */
  version: string;
  title: string;
  body: string;
  /** App Store 链接。管理员没填时客户端用自己内置的商店地址兜底，
   *  所以这里允许为空串 —— 但公告本身不能因为缺它就不存在。 */
  storeUrl: string;
  publishedAt: string;
}

/** 版本号粗校验：公告的版本要能被客户端拿去和自己的版本比大小，
 *  只收 `x.y` / `x.y.z` 这种数字点分形态。写错一位（"v1.8"、"1.8 "）
 *  在这里就拦下，别等全体 iOS 用户收到一条比不出大小的公告。 */
export function isPlausibleAppVersion(v: string): boolean {
  return /^\d+\.\d+(\.\d+)?$/.test(v);
}

export function announcementFromSettings(s: SettingsView): IosAnnouncement | null {
  if (!s.iosAnnouncementEnabled) return null;
  const version = (s.iosAnnouncementVersion ?? "").trim();
  if (!version || !isPlausibleAppVersion(version)) return null;
  const title = (s.iosAnnouncementTitle ?? "").trim();
  const body = (s.iosAnnouncementBody ?? "").trim();
  if (!title && !body) return null;
  return {
    version,
    title,
    body,
    storeUrl: (s.iosAnnouncementStoreUrl ?? "").trim(),
    publishedAt: s.iosAnnouncementPublishedAt ? s.iosAnnouncementPublishedAt.toISOString() : "",
  };
}
