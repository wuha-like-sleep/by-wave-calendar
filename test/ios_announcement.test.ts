// iOS 公告的判空口径。接口回不回 404 只由这一个函数说了算
// （announcementFromSettings），后台自检区显示的也是它的输出 ——
// 两边要是各写一份判空，迟早出现「后台说在播、接口回 404」。

import { describe, it, expect, vi } from "vitest";

vi.mock("../src/db/client.js", () => ({ db: {}, schema: {} }));

import { announcementFromSettings, isPlausibleAppVersion } from "../src/lib/ios_announcement.js";
import type { SettingsView } from "../src/lib/site_settings.js";

function settings(patch: Partial<SettingsView>): SettingsView {
  return {
    iosAnnouncementEnabled: false,
    iosAnnouncementVersion: null,
    iosAnnouncementTitle: null,
    iosAnnouncementBody: null,
    iosAnnouncementStoreUrl: null,
    iosAnnouncementPublishedAt: null,
    ...patch,
  } as SettingsView;
}

describe("isPlausibleAppVersion", () => {
  it("数字点分形态才算数", () => {
    expect(isPlausibleAppVersion("1.8.0")).toBe(true);
    expect(isPlausibleAppVersion("1.8")).toBe(true);
    expect(isPlausibleAppVersion("v1.8.0")).toBe(false);
    expect(isPlausibleAppVersion("1.8 ")).toBe(false);
    expect(isPlausibleAppVersion("latest")).toBe(false);
    expect(isPlausibleAppVersion("")).toBe(false);
  });
});

describe("announcementFromSettings", () => {
  it("没启用 → 没有公告", () => {
    expect(announcementFromSettings(settings({
      iosAnnouncementEnabled: false, iosAnnouncementVersion: "1.8.0", iosAnnouncementTitle: "新版本",
    }))).toBeNull();
  });

  it("启用但版本没填 / 形态不对 → 没有公告", () => {
    expect(announcementFromSettings(settings({
      iosAnnouncementEnabled: true, iosAnnouncementVersion: null, iosAnnouncementTitle: "新版本",
    }))).toBeNull();
    expect(announcementFromSettings(settings({
      iosAnnouncementEnabled: true, iosAnnouncementVersion: "v1.8", iosAnnouncementTitle: "新版本",
    }))).toBeNull();
  });

  it("标题正文全空 → 没有公告（不能给用户弹一个空框）", () => {
    expect(announcementFromSettings(settings({
      iosAnnouncementEnabled: true, iosAnnouncementVersion: "1.8.0",
    }))).toBeNull();
  });

  it("齐全 → 返回公告，字段去空白，发布时间转 ISO", () => {
    const at = new Date("2026-11-20T00:00:00.000Z");
    const a = announcementFromSettings(settings({
      iosAnnouncementEnabled: true,
      iosAnnouncementVersion: " 1.8.0 ",
      iosAnnouncementTitle: " 新版本已发布 ",
      iosAnnouncementBody: " 修了同步问题 ",
      iosAnnouncementStoreUrl: " https://apps.apple.com/app/id123 ",
      iosAnnouncementPublishedAt: at,
    }));
    expect(a).toEqual({
      version: "1.8.0",
      title: "新版本已发布",
      body: "修了同步问题",
      storeUrl: "https://apps.apple.com/app/id123",
      publishedAt: "2026-11-20T00:00:00.000Z",
    });
  });

  it("商店链接没填也照发（客户端有内置商店地址兜底）", () => {
    const a = announcementFromSettings(settings({
      iosAnnouncementEnabled: true, iosAnnouncementVersion: "1.8.0", iosAnnouncementBody: "有新版本",
    }));
    expect(a?.storeUrl).toBe("");
    expect(a?.publishedAt).toBe("");
  });
});
