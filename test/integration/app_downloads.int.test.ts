// 三端 App 的更新接口 + 从本站发安装包 —— 从 HTTP 打进去。
//
// ── 这四条路由以前一次都没被测过 ──────────────────────────────────────
//
// 它们原来写在 src/server.ts 顶层、不属于任何 plugin，集成测试注册不了。
// 后果很具体：「站长把安装包传到自己服务器上，而 App 的自动更新仍然去
// GitHub 拉 109MB」这条 bug 活了很久，期间门禁全绿 —— 因为断言全落在
// /download 那个 HTML 页面上，而真正决定 App 去哪下的是这两条 latest 接口。
//
// 所以这一档最要紧的一条是：**放一个文件进去，然后看 /api/app/*/latest
// 返回的 url 变没变**。不是看 lib 函数的返回值。

import { vi, beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

import Fastify, { type FastifyInstance } from "fastify";
import path from "node:path";
import { writeFile, rm, mkdir } from "node:fs/promises";
import { ensureSchema, resetDb, pg } from "./harness.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";

const { appDownloadRoutes } = await import("../../src/web/app_downloads.js");

const DESKTOP_DIR = path.resolve("data/desktop-binaries");
const MANIFEST = path.resolve("data/app-desktop-manifest.json");
const DMG = "ByWaveCalendar-9.9.9-arm64.dmg";
const GITHUB_URL = `https://github.com/example/repo/releases/download/v9.9.9/${DMG}`;
/** 造一个够大的假包 —— Range 用例要能切出有意义的区间。 */
const CONTENT = Buffer.from("A".repeat(10_000));

let app: FastifyInstance;

async function buildApp(): Promise<FastifyInstance> {
  const a = Fastify({ logger: false });
  await a.register(appDownloadRoutes);
  await a.ready();
  return a;
}

async function writeManifest() {
  await mkdir(path.dirname(MANIFEST), { recursive: true });
  await writeFile(MANIFEST, JSON.stringify({
    versionCode: 999, versionName: "9.9.9", releasedAt: "2026-01-01T00:00:00Z",
    notes: "", mandatory: false,
    assets: { mac: { filename: DMG, downloadUrl: GITHUB_URL, sha256: "a".repeat(64), sizeBytes: CONTENT.length } },
  }), "utf8");
}

async function putBinary(body: Buffer = CONTENT) {
  await mkdir(DESKTOP_DIR, { recursive: true });
  await writeFile(path.join(DESKTOP_DIR, DMG), body);
}

async function macUrl(): Promise<string> {
  const res = await app.inject({ method: "GET", url: "/api/app/desktop/latest" });
  expect(res.statusCode, `更新接口没回 200。响应: ${res.body.slice(0, 200)}`).toBe(200);
  const b = JSON.parse(res.body) as { assets: { mac?: { url: string } } };
  return b.assets.mac?.url ?? "";
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

describe("App 的更新接口要认本站的包", () => {
  it("本站没有这个文件 → 给 GitHub 地址（presence）", async () => {
    expect(await macUrl(), "本来就该给 GitHub").toBe(GITHUB_URL);
  });

  it("把文件放上去 → **更新接口返回本站地址**（这条是这个文件的核心）", async () => {
    await putBinary();
    const url = await macUrl();
    expect(
      url,
      "文件就在服务器上，而 App 的自动更新仍然被送去 GitHub —— " +
        "「从本站发包」只兑现了网页那一半，已装机的老用户一个都没受益",
    ).toContain("/downloads/desktop/");
    expect(url).not.toContain("github.com");
  });

  it("0 字节的文件不算数（上传半途留下的壳）", async () => {
    await putBinary(Buffer.alloc(0));
    expect(await macUrl(), "空文件被当成「本站有」，用户会下到一个空包").toBe(GITHUB_URL);
  });
});

describe("发文件这条路要能被 100MB 级别的下载真的用上", () => {
  beforeEach(async () => { await putBinary(); });

  it("整个文件下得下来（presence）", async () => {
    const res = await app.inject({ method: "GET", url: `/downloads/desktop/${DMG}` });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length, "发出去的字节数和文件大小对不上").toBe(CONTENT.length);
    expect(res.headers["content-length"]).toBe(String(CONTENT.length));
  });

  it("无条件发 Accept-Ranges —— 不发这个头，客户端根本不会尝试续传", async () => {
    const res = await app.inject({ method: "GET", url: `/downloads/desktop/${DMG}` });
    expect(
      res.headers["accept-ranges"],
      "没有 Accept-Ranges：109MB 的包网断一次就得从 0 重下，" +
        "而「从本站发包」存在的全部理由就是给从 GitHub 下不动的人一条路",
    ).toBe("bytes");
  });

  it("带 Range 的请求回 206 和正确的那一段", async () => {
    const res = await app.inject({
      method: "GET", url: `/downloads/desktop/${DMG}`,
      headers: { range: "bytes=100-199" },
    });
    expect(res.statusCode, "带了 Range 还回 200 —— 客户端会判定不可续传，从头重下").toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 100-199/${CONTENT.length}`);
    expect(res.headers["content-length"]).toBe("100");
    expect(res.rawPayload.length).toBe(100);
    expect(res.rawPayload.toString()).toBe(CONTENT.subarray(100, 200).toString());
  });

  it("bytes=N- （断点续传最常见的形状）从 N 一直发到结尾", async () => {
    const res = await app.inject({
      method: "GET", url: `/downloads/desktop/${DMG}`,
      headers: { range: "bytes=9000-" },
    });
    expect(res.statusCode).toBe(206);
    expect(res.rawPayload.length).toBe(CONTENT.length - 9000);
    expect(res.headers["content-range"]).toBe(`bytes 9000-${CONTENT.length - 1}/${CONTENT.length}`);
  });

  it("起点超出文件尾 → 416，并带 Content-Range 告诉客户端真实大小", async () => {
    const res = await app.inject({
      method: "GET", url: `/downloads/desktop/${DMG}`,
      headers: { range: `bytes=${CONTENT.length + 10}-` },
    });
    expect(res.statusCode).toBe(416);
    expect(res.headers["content-range"]).toBe(`bytes */${CONTENT.length}`);
  });

  it("HEAD 只发头、不发体（自动生成的那个会把整个文件读完丢掉）", async () => {
    const res = await app.inject({ method: "HEAD", url: `/downloads/desktop/${DMG}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-length"]).toBe(String(CONTENT.length));
    expect(
      res.rawPayload.length,
      "HEAD 把文件内容也发出来了 —— 那就不是 HEAD 了",
    ).toBe(0);
  });

  it("不压缩 —— 压了会删掉 Content-Length 并破坏 Range", async () => {
    const res = await app.inject({
      method: "GET", url: `/downloads/desktop/${DMG}`,
      headers: { "accept-encoding": "gzip, deflate, br" },
    });
    expect(res.headers["content-encoding"]).toBe("identity");
  });

  it("文件名不合规 → 400，而且判据和上传共用一份", async () => {
    const res = await app.inject({ method: "GET", url: "/downloads/desktop/not%20an%20installer.dmg" });
    expect(res.statusCode).toBe(400);
  });

  it("目录穿越进不来", async () => {
    const res = await app.inject({ method: "GET", url: "/downloads/desktop/..%2F..%2Fpackage.json" });
    expect([400, 404]).toContain(res.statusCode);
  });
});
