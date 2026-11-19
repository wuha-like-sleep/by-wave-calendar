// 更新策略第二轮 —— 灰度分桶、宽限/镜像字段下发、iOS 公告，全部从 HTTP 打。
//
// 分工：分桶与归一化的判定表在 test/rollout.test.ts（纯函数档），公告
// 判空在 test/ios_announcement.test.ts。这一档验的是**路由真的在用
// 那份判定**：查询参数解析、404 的形状、召回豁免在 HTTP 层成立、
// 后台保存公告后公开接口立刻能看到、镜像地址的 https 校验真的拦得住。
//
// 分桶向量与单元测试同一组：android 清单 versionCode=26 时
// device-beta 桶 7、device-alpha 桶 73；desktop versionCode=31 时
// 11111111-… 桶 64。

import { vi, beforeAll, beforeEach, afterEach, afterAll, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import view from "@fastify/view";
import ejs from "ejs";
import path from "node:path";
import { createHmac } from "node:crypto";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { ensureSchema, resetDb, db, schema, makeUser, pg } from "./harness.js";
import { newSessionId } from "../../src/lib/ids.js";
import { redirectFlash } from "./flash_helpers.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://unused:unused@localhost:5432/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const SESSION_SECRET = process.env.SESSION_SECRET;
const TEST_COOKIE_SECRET = "test-cookie-secret";

const { adminRoutes } = await import("../../src/web/admin.js");
const { appDownloadRoutes } = await import("../../src/web/app_downloads.js");
const { updateSettings, getSettings, reloadSettings } = await import("../../src/lib/site_settings.js");

const VIEWS = path.resolve("src/views");
const ANDROID_OVERRIDE = path.resolve("data/app-android-manifest.json");
const DESKTOP_OVERRIDE = path.resolve("data/app-desktop-manifest.json");

let app: FastifyInstance;

async function buildApp(): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  await instance.register(cookie, { secret: TEST_COOKIE_SECRET });
  await instance.register(formbody);
  await instance.register(view, {
    engine: { ejs }, root: VIEWS, propertyName: "view", options: { async: false },
    defaultContext: {
      t: (key: string) => key, siteName: "ByWave Calendar", siteLogoUrl: null,
      icpNumber: null, icpUrl: "", assetVersion: "test", jsBasePath: "/static/js",
      cspNonce: "test-nonce", currentLocale: "zh-CN", locales: [], siteLocaleOptions: [],
      currentUser: null, themePalette: "indigo", themeDensity: "comfortable",
      currentPath: "/admin/client-release",
    },
  });
  await instance.register(adminRoutes);
  await instance.register(appDownloadRoutes);
  await instance.ready();
  return instance;
}

async function loginAs(userId: string): Promise<{ cookie: string; csrf: string }> {
  const sid = newSessionId();
  await db.insert(schema.sessions).values({
    id: sid, userId, mfaSatisfied: true,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  return {
    cookie: `bwc_sid=${encodeURIComponent(app.signCookie(sid))}`,
    csrf: createHmac("sha256", SESSION_SECRET).update(sid).digest("hex"),
  };
}

const FORM_CT = "application/x-www-form-urlencoded";
function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

async function writeAndroidManifest(patch: Record<string, unknown> = {}) {
  await mkdir(path.dirname(ANDROID_OVERRIDE), { recursive: true });
  await writeFile(ANDROID_OVERRIDE, JSON.stringify({
    versionCode: 26, versionName: "1.0.0", releasedAt: "2026-11-20T00:00:00Z",
    notes: "", mandatory: false, minSupportedVersionCode: 20,
    downloadUrl: "https://example.com/app.apk",
    sha256: "a".repeat(64), sizeBytes: 1000,
    ...patch,
  }), "utf8");
}

async function writeDesktopManifest(patch: Record<string, unknown> = {}) {
  await mkdir(path.dirname(DESKTOP_OVERRIDE), { recursive: true });
  await writeFile(DESKTOP_OVERRIDE, JSON.stringify({
    versionCode: 31, versionName: "1.0.0", releasedAt: "2026-11-20T00:00:00Z",
    notes: "", mandatory: false, minSupportedVersionCode: 20,
    assets: {
      mac: {
        filename: "ByWave.dmg", downloadUrl: "https://example.com/ByWave.dmg",
        sha256: "b".repeat(64), sizeBytes: 2000,
      },
    },
    ...patch,
  }), "utf8");
}

async function androidLatest(qs = "") {
  const res = await app.inject({ method: "GET", url: `/api/app/android/latest${qs}` });
  return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
}

async function desktopLatest(qs = "") {
  const res = await app.inject({ method: "GET", url: `/api/app/desktop/latest${qs}` });
  return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
}

async function announcement() {
  const res = await app.inject({ method: "GET", url: "/api/app/ios/announcement" });
  return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
}

beforeAll(async () => { await ensureSchema(); app = await buildApp(); });
afterAll(async () => { await app?.close(); await pg?.close(); });
beforeEach(async () => {
  await resetDb();
  await rm(ANDROID_OVERRIDE, { force: true });
  await rm(DESKTOP_OVERRIDE, { force: true });
  // site_settings 是懒播种的单行表：生产里开机第一次读设置就把行种下了，
  // updateSettings 只做 UPDATE。这里先清缓存再读一次把行种出来，否则
  // 公告那几条的 UPDATE 会打在空表上、静默无行可改（测出来的正是这个
  // 形状）；不清缓存的话 getSettings 直接回上一个用例缓存的那份，行
  // 照样种不出来。
  reloadSettings();
  await getSettings();
});
afterEach(async () => {
  await rm(ANDROID_OVERRIDE, { force: true });
  await rm(DESKTOP_OVERRIDE, { force: true });
});

describe("灰度分桶在 latest 接口上", () => {
  it("清单没写 rolloutPercent → 默认全量，任何设备都拿得到，且字段按默认值下发", async () => {
    await writeAndroidManifest();
    const r = await androidLatest("?deviceId=device-alpha&currentVersionCode=25");
    expect(r.status).toBe(200);
    expect(r.body.rolloutPercent).toBe(100);
    expect(r.body.graceDays).toBe(7);
    expect(r.body.mirrorUrl).toBe("");
  });

  it("10% 灰度：桶 7 的设备可见、桶 73 的不可见，且重复问答案不变", async () => {
    await writeAndroidManifest({ rolloutPercent: 10 });
    expect((await androidLatest("?deviceId=device-beta&currentVersionCode=25")).status).toBe(200);
    const out = await androidLatest("?deviceId=device-alpha&currentVersionCode=25");
    expect(out.status).toBe(404);
    expect(out.body.error).toBe("rollout_not_included");
    // 确定性：同一台设备连问三次都是同一个答案。
    for (let i = 0; i < 3; i++) {
      expect((await androidLatest("?deviceId=device-alpha&currentVersionCode=25")).status).toBe(404);
      expect((await androidLatest("?deviceId=device-beta&currentVersionCode=25")).status).toBe(200);
    }
  });

  it("比例 0 = 暂停放量：桶最小的设备也看不到", async () => {
    await writeAndroidManifest({ rolloutPercent: 0 });
    expect((await androidLatest("?deviceId=device-beta&currentVersionCode=25")).status).toBe(404);
  });

  it("比例从 10 提到 100（关灰度回全量）：原来不可见的设备立刻可见", async () => {
    await writeAndroidManifest({ rolloutPercent: 10 });
    expect((await androidLatest("?deviceId=device-alpha&currentVersionCode=25")).status).toBe(404);
    await writeAndroidManifest({ rolloutPercent: 100 });
    expect((await androidLatest("?deviceId=device-alpha&currentVersionCode=25")).status).toBe(200);
  });

  it("没带 deviceId → 照常下发（接口兼作后台自检，分不了桶不能装作分了）", async () => {
    await writeAndroidManifest({ rolloutPercent: 10 });
    expect((await androidLatest("")).status).toBe(200);
  });

  it("召回豁免：已装版本低于最低支持版本时无视灰度；等于最低版本则照常分桶", async () => {
    await writeAndroidManifest({ rolloutPercent: 10 });
    // device-alpha 桶 73 本来在 10% 之外，但它装的 19 < 最低 20 → 放行。
    expect((await androidLatest("?deviceId=device-alpha&currentVersionCode=19")).status).toBe(200);
    // 恰好等于最低版本不算「低于」→ 仍按桶判。
    expect((await androidLatest("?deviceId=device-alpha&currentVersionCode=20")).status).toBe(404);
  });

  it("后台快捷设置灰度 + 一键全量：只动比例，接口立刻按新比例分桶", async () => {
    await writeAndroidManifest();
    const admin = await makeUser("admin@example.com", { isAdmin: true });
    const s = await loginAs(admin.id);
    const setRollout = (percent: string) => app.inject({
      method: "POST", url: "/admin/client-release/android/rollout",
      headers: { cookie: s.cookie, "content-type": FORM_CT },
      payload: formBody({ _csrf: s.csrf, percent }),
    });
    // 先全量可见 → 设 10% → 桶 73 的设备立刻不可见、桶 7 的仍可见。
    expect((await androidLatest("?deviceId=device-alpha&currentVersionCode=25")).status).toBe(200);
    const set = await setRollout("10");
    expect(redirectFlash(set).success).toBeTruthy();
    expect((await androidLatest("?deviceId=device-alpha&currentVersionCode=25")).status).toBe(404);
    expect((await androidLatest("?deviceId=device-beta&currentVersionCode=25")).status).toBe(200);
    // 一键全量（100）→ 原来不可见的设备立刻回来，且版本字段没被动过。
    const full = await setRollout("100");
    expect(redirectFlash(full).success).toBeTruthy();
    const live = await androidLatest("?deviceId=device-alpha&currentVersionCode=25");
    expect(live.status).toBe(200);
    expect(live.body.versionCode).toBe(26);
    expect(live.body.rolloutPercent).toBe(100);
  });

  it("桌面同一口径：versionCode 31 时 11111111-… 桶 64，10% 下不可见、无标识可见", async () => {
    await writeDesktopManifest({ rolloutPercent: 10 });
    const out = await desktopLatest("?deviceId=11111111-2222-3333-4444-555555555555&currentVersionCode=30");
    expect(out.status).toBe(404);
    expect(out.body.error).toBe("rollout_not_included");
    const open = await desktopLatest("");
    expect(open.status).toBe(200);
    expect(open.body.rolloutPercent).toBe(10);
  });
});

describe("镜像地址与宽限天数下发", () => {
  it("安卓：清单里的 mirrorUrl 与 graceDays 原样下发", async () => {
    await writeAndroidManifest({ mirrorUrl: "https://gitee.com/example/app.apk", graceDays: 3 });
    const r = await androidLatest("");
    expect(r.status).toBe(200);
    expect(r.body.mirrorUrl).toBe("https://gitee.com/example/app.apk");
    expect(r.body.graceDays).toBe(3);
  });

  it("桌面：镜像地址挂在每个资产上，不是一份全局地址", async () => {
    await writeDesktopManifest({
      graceDays: 0,
      assets: {
        mac: {
          filename: "ByWave.dmg", downloadUrl: "https://example.com/ByWave.dmg",
          sha256: "b".repeat(64), sizeBytes: 2000,
          mirrorUrl: "https://gitee.com/example/ByWave.dmg",
        },
      },
    });
    const r = await desktopLatest("");
    expect(r.status).toBe(200);
    expect(r.body.graceDays).toBe(0);
    const assets = r.body.assets as { mac: { mirrorUrl: string } };
    expect(assets.mac.mirrorUrl).toBe("https://gitee.com/example/ByWave.dmg");
  });

  it("后台保存清单时 mirrorUrl 不是 https → 整份拒绝，不落盘", async () => {
    const admin = await makeUser("admin@example.com", { isAdmin: true });
    const s = await loginAs(admin.id);
    const manifest = JSON.stringify({
      versionCode: 99, versionName: "9.9.9",
      downloadUrl: "https://example.com/app.apk",
      mirrorUrl: "http://example.com/app.apk",
      sha256: "a".repeat(64), sizeBytes: 1000,
    });
    const res = await app.inject({
      method: "POST", url: "/admin/client-release/android",
      headers: { cookie: s.cookie, "content-type": FORM_CT },
      payload: formBody({ _csrf: s.csrf, manifest }),
    });
    expect(redirectFlash(res).error, "http 镜像地址被当成保存成功了").toBeTruthy();
    // 没落盘：公开接口报的还是仓库自带清单的版本，不是被拒的这份 99。
    const live = await androidLatest("");
    expect(live.status).toBe(200);
    expect(live.body.versionCode).not.toBe(99);
  });
});

describe("iOS 公告接口", () => {
  it("什么都没发过 → 404 no_announcement", async () => {
    const r = await announcement();
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("no_announcement");
  });

  it("设置里开启并填全 → 200，字段与设置一致", async () => {
    await updateSettings({
      iosAnnouncementEnabled: true,
      iosAnnouncementVersion: "1.8.0",
      iosAnnouncementTitle: "新版本已发布",
      iosAnnouncementBody: "去商店更新吧",
      iosAnnouncementStoreUrl: "https://apps.apple.com/app/id123",
      iosAnnouncementPublishedAt: new Date("2026-11-20T00:00:00.000Z"),
    });
    const r = await announcement();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      version: "1.8.0", title: "新版本已发布", body: "去商店更新吧",
      storeUrl: "https://apps.apple.com/app/id123",
      publishedAt: "2026-11-20T00:00:00.000Z",
    });
  });

  it("管理员从后台发布 → 接口立刻可见；关掉 → 立刻 404", async () => {
    const admin = await makeUser("admin@example.com", { isAdmin: true });
    const s = await loginAs(admin.id);
    const post = (fields: Record<string, string>) => app.inject({
      method: "POST", url: "/admin/client-release/ios-announcement",
      headers: { cookie: s.cookie, "content-type": FORM_CT },
      payload: formBody({ _csrf: s.csrf, ...fields }),
    });
    const on = await post({
      enabled: "on", version: "1.9.0", title: "新版本 1.9.0",
      body: "修了同步问题", storeUrl: "https://apps.apple.com/app/id123",
    });
    expect(redirectFlash(on).success).toBeTruthy();
    const live = await announcement();
    expect(live.status).toBe(200);
    expect(live.body.version).toBe("1.9.0");

    const off = await post({ version: "1.9.0", title: "新版本 1.9.0", body: "修了同步问题" });
    expect(redirectFlash(off).success).toBeTruthy();
    expect((await announcement()).status).toBe(404);
  });

  it("版本号形态不对（v1.9）→ 后台拒绝保存，接口保持 404", async () => {
    const admin = await makeUser("admin@example.com", { isAdmin: true });
    const s = await loginAs(admin.id);
    const res = await app.inject({
      method: "POST", url: "/admin/client-release/ios-announcement",
      headers: { cookie: s.cookie, "content-type": FORM_CT },
      payload: formBody({
        _csrf: s.csrf, enabled: "on", version: "v1.9", title: "新版本", body: "内容",
      }),
    });
    expect(redirectFlash(res).error).toBeTruthy();
    expect((await announcement()).status).toBe(404);
  });

  it("非管理员发不了公告", async () => {
    const u = await makeUser("nobody@example.com");
    const s = await loginAs(u.id);
    const res = await app.inject({
      method: "POST", url: "/admin/client-release/ios-announcement",
      headers: { cookie: s.cookie, "content-type": FORM_CT },
      payload: formBody({
        _csrf: s.csrf, enabled: "on", version: "1.9.0", title: "新版本", body: "内容",
      }),
    });
    expect([302, 303, 403]).toContain(res.statusCode);
    expect((await announcement()).status).toBe(404);
  });

  it("后台客户端更新页带着 iOS 公告区渲染（presence）", async () => {
    const admin = await makeUser("admin@example.com", { isAdmin: true });
    const s = await loginAs(admin.id);
    const res = await app.inject({
      method: "GET", url: "/admin/client-release", headers: { cookie: s.cookie },
    });
    expect(res.statusCode, `页面打不开，下面都无从谈起。响应: ${res.body.slice(0, 200)}`).toBe(200);
    expect(res.body).toContain("iOS 公告");
    expect(res.body).toContain("灰度放量");
  });
});
