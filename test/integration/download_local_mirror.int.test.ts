// 下载页给的是本站链接还是 GitHub 链接 —— 从 HTTP 打进去看真实 HTML。
//
// ── 为什么这一档必须真的放一个文件进去 ────────────────────────────────
//
// 判据是「这台服务器上到底有没有这个安装包」，**不能靠清单里有没有 filename
// 推断**：清单是上游给的，filename 一定有，而文件在不在这台服务器上完全是
// 另一回事。推断的话国内用户点了会撞 404 —— 比老老实实给 GitHub 链接还糟。
//
// 所以下面每一条都真的往 data/desktop-binaries/ 里落一个文件（或者不落），
// 再看页面上出来的是什么。

import { vi, beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from "vitest";

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
import { writeFile, rm, mkdir } from "node:fs/promises";
import { ensureSchema, resetDb, pg } from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";

const { webRoutes } = await import("../../src/web/index.js");

const VIEWS = path.resolve("src/views");
const DESKTOP_DIR = path.resolve("data/desktop-binaries");
const MANIFEST = path.resolve("data/app-desktop-manifest.json");
const DMG = "ByWaveCalendar-9.9.9-arm64.dmg";
const GITHUB_URL = `https://github.com/example/repo/releases/download/v9.9.9/${DMG}`;

let app: FastifyInstance;

async function buildApp(): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  await instance.register(cookie, { secret: "integration-test-cookie-secret-32-chars-min" });
  await instance.register(formbody);
  await instance.register(view, {
    engine: { ejs }, root: VIEWS, propertyName: "view", options: { async: false },
    defaultContext: {
      t: (key: string) => key, siteName: "ByWave Calendar", siteLogoUrl: null,
      icpNumber: null, icpUrl: "", assetVersion: "test", jsBasePath: "/static/js",
      cspNonce: "test-nonce", currentLocale: "zh-CN", locales: [], siteLocaleOptions: [],
      currentUser: null, themePalette: "indigo", themeDensity: "comfortable",
      currentPath: "/download",
    },
  });
  await instance.register(webRoutes);
  await instance.ready();
  return instance;
}

/** 写一份只有 mac 资产的桌面清单。downloadUrl 指向 GitHub —— 和真实发版一样。 */
async function writeManifest() {
  await mkdir(path.dirname(MANIFEST), { recursive: true });
  await writeFile(MANIFEST, JSON.stringify({
    versionCode: 999, versionName: "9.9.9", releasedAt: "2026-01-01T00:00:00Z",
    notes: "", mandatory: false,
    assets: { mac: { filename: DMG, downloadUrl: GITHUB_URL, sha256: "a".repeat(64), sizeBytes: 123 } },
  }), "utf8");
}

async function downloadHtml(): Promise<string> {
  const res = await app.inject({ method: "GET", url: "/download" });
  expect(res.statusCode, `下载页打不开，这一档什么也测不到。响应: ${res.body.slice(0, 200)}`).toBe(200);
  return res.body;
}

beforeAll(async () => { await ensureSchema(); app = await buildApp(); });
afterAll(async () => { await app?.close(); await pg?.close(); });

beforeEach(async () => {
  await resetDb();
  await rm(path.join(DESKTOP_DIR, DMG), { force: true });
  await writeManifest();
});

afterEach(async () => {
  await rm(path.join(DESKTOP_DIR, DMG), { force: true });
  await rm(MANIFEST, { force: true });
});

describe("下载页：本站有文件就本站优先，GitHub 作备选", () => {
  it("服务器上没有这个文件 → 只给 GitHub 链接，不给本站路径", async () => {
    const html = await downloadHtml();
    expect(html, "清单里有 filename 就给了本站路径 —— 而文件根本不在，用户点了是 404").not.toContain(`/downloads/desktop/${DMG}`);
    expect(html, "GitHub 链接也没给，那就什么都下不了了").toContain(GITHUB_URL);
  });

  it("把文件真的放上去 → 主链接变成本站路径", async () => {
    await mkdir(DESKTOP_DIR, { recursive: true });
    await writeFile(path.join(DESKTOP_DIR, DMG), "not-a-real-dmg-but-a-real-file", "utf8");
    const html = await downloadHtml();
    expect(
      html,
      "文件就在服务器上，页面却还在往 GitHub 送 —— 国内用户白等",
    ).toContain(`/downloads/desktop/${DMG}`);
  });

  it("本站有文件时，GitHub 仍然作为备选出现（下不动本站的人有退路）", async () => {
    await mkdir(DESKTOP_DIR, { recursive: true });
    await writeFile(path.join(DESKTOP_DIR, DMG), "x", "utf8");
    const html = await downloadHtml();
    expect(html).toContain(`/downloads/desktop/${DMG}`);
    expect(html, "本站优先之后就把 GitHub 那条路彻底藏了 —— 本站下不动的人没退路").toContain(GITHUB_URL);
  });

  // 名字只说它实际测的那一件事。第一版叫「半截传上来的文件比没有还糟」,
  // 而写进去的是 0 字节 —— 标题里说的那个场景(50MB 的半截包)一次都没被覆盖,
  // 而它确实能一路通过(判据是 size > 0)。
  //
  // 那个场景现在是**结构上不会发生**的:后台上传走 .part → 校验 → rename,
  // 半截文件永远不会以最终名字存在(见 admin_binary_upload.int.test.ts 的
  // 「同名重传被拒时线上那份一个字节都没变」)。只有人绕过后台直接往目录里
  // 塞半截文件才会出现,那种情况下判据要改成「大小 == 清单里写的」——
  // 还没做,别让这条用例的名字假装已经做了。
  it("0 字节的文件不算数", async () => {
    await mkdir(DESKTOP_DIR, { recursive: true });
    await writeFile(path.join(DESKTOP_DIR, DMG), "", "utf8");
    const html = await downloadHtml();
    expect(
      html,
      "0 字节的文件被当成「本站有」—— 用户下下来一个空文件，比 404 更难判断",
    ).not.toContain(`/downloads/desktop/${DMG}`);
  });
});
