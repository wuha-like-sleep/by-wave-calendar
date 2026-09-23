// 后台上传安装包 —— 从 HTTP 打进去，断言落在「传完之后外面看到什么」上。
//
// ── 这一档要守的两件事 ────────────────────────────────────────────────
//
// 1. **sha256 对不上就不许落盘。** 这是整个功能最值钱的一步：
//    桌面端 UpdateDownloader / 安卓 ApkDownloader 下载完都会校验 sha256，
//    不匹配就删掉重下 —— 用户陷入无限重试，而站长完全不知道为什么。
//    上传时就拦掉，把两个值并排摆给他。
// 2. **传完之后 /api/app/*/latest 真的改指本站。** 断言不能只落在
//    「文件写进去了」—— 本仓库刚为这个形状付过账：「本站优先」只做在了
//    /download 网页上，而 App 的自动更新仍然去 GitHub。
//
// 还有一条容易被忽略的：**同名重传不许把线上那份打坏**。
// createWriteStream 默认 flags 'w'，打开的瞬间就 truncate —— 站长发现包
// 传错了重传的那三分钟里，正在下载的人会拿到逐渐增长的垃圾。

import { vi, beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import view from "@fastify/view";
import ejs from "ejs";
import path from "node:path";
import { createHash, createHmac } from "node:crypto";
import { readFile, writeFile, rm, mkdir, readdir } from "node:fs/promises";
import { ensureSchema, resetDb, db, schema, makeUser } from "./harness.js";
import { newSessionId } from "../../src/lib/ids.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const SESSION_SECRET = process.env.SESSION_SECRET;

const { adminRoutes } = await import("../../src/web/admin.js");
const { appDownloadRoutes } = await import("../../src/web/app_downloads.js");

const DIR = path.resolve("data/desktop-binaries");
const MANIFEST = path.resolve("data/app-desktop-manifest.json");
const DMG = "ByWaveCalendar-9.9.9-arm64.dmg";
const BODY = Buffer.from("pretend-this-is-a-dmg-".repeat(200));
const SHA = createHash("sha256").update(BODY).digest("hex");
const GITHUB_URL = `https://github.com/example/repo/releases/download/v9.9.9/${DMG}`;

let app: FastifyInstance;

async function buildApp(): Promise<FastifyInstance> {
  const a = Fastify({ logger: false });
  await a.register(cookie, { secret: "integration-test-cookie-secret-32-chars-min" });
  await a.register(formbody);
  // 全局上限故意设得很小（和生产一样是 2MB）—— 路由必须靠 per-request
  // 的 req.parts({limits}) 顶掉它。不这么布置的话，「per-request 覆盖生效了吗」
  // 这件事根本没被测到。
  await a.register(multipart, { limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 5 } });
  await a.register(view, {
    engine: { ejs }, root: path.resolve("src/views"), propertyName: "view",
    options: { async: false },
    defaultContext: {
      t: (k: string) => k, siteName: "ByWave", siteLogoUrl: null, icpNumber: null,
      icpUrl: "", assetVersion: "t", jsBasePath: "/static/js", cspNonce: "n",
      currentLocale: "zh-CN", locales: [], siteLocaleOptions: [], currentUser: null,
      themePalette: "indigo", themeDensity: "comfortable", currentPath: "/admin/client-release",
    },
  });
  await a.register(adminRoutes);
  await a.register(appDownloadRoutes);
  await a.ready();
  return a;
}

async function loginAs(userId: string) {
  const sid = newSessionId();
  await db.insert(schema.sessions).values({
    id: sid, userId, mfaSatisfied: true,
    expiresAt: new Date(Date.now() + 86400_000),
  });
  return {
    raw: sid,
    cookie: `bwc_sid=${encodeURIComponent(app.signCookie(sid))}`,
    csrf: createHmac("sha256", SESSION_SECRET).update(sid).digest("hex"),
  };
}

/** 手搓一个 multipart body —— inject 不帮忙组装。 */
function multipartBody(filename: string, content: Buffer) {
  const b = "----bwctest" + Math.random().toString(36).slice(2);
  const head = Buffer.from(
    `--${b}\r\nContent-Disposition: form-data; name="binary"; filename="${filename}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${b}--\r\n`);
  return { payload: Buffer.concat([head, content, tail]), contentType: `multipart/form-data; boundary=${b}` };
}

async function upload(s: { cookie: string; csrf: string }, filename: string, content: Buffer) {
  const { payload, contentType } = multipartBody(filename, content);
  return app.inject({
    method: "POST", url: "/admin/client-release/desktop/binary",
    headers: { cookie: s.cookie, "x-csrf-token": s.csrf, "content-type": contentType },
    payload,
  });
}

/** 清单里写 sha256 为 declaredSha（空串 = 清单没写哈希）。 */
async function writeManifest(declaredSha: string) {
  await mkdir(path.dirname(MANIFEST), { recursive: true });
  await writeFile(MANIFEST, JSON.stringify({
    versionCode: 999, versionName: "9.9.9", releasedAt: "2026-01-01T00:00:00Z",
    notes: "", mandatory: false,
    assets: { mac: { filename: DMG, downloadUrl: GITHUB_URL, sha256: declaredSha, sizeBytes: BODY.length } },
  }), "utf8");
}

async function macUrl(): Promise<string> {
  const res = await app.inject({ method: "GET", url: "/api/app/desktop/latest" });
  const b = JSON.parse(res.body) as { assets: { mac?: { url: string } } };
  return b.assets.mac?.url ?? "";
}

async function dirNames(): Promise<string[]> {
  return readdir(DIR).catch(() => [] as string[]);
}

beforeAll(async () => { await ensureSchema(); app = await buildApp(); });
afterAll(async () => { await app?.close(); });

beforeEach(async () => {
  await resetDb();
  await mkdir(DIR, { recursive: true });
  for (const n of await dirNames()) {
    if (n.startsWith("ByWaveCalendar-9.9.9") || n.endsWith(".part")) {
      await rm(path.join(DIR, n), { force: true });
    }
  }
  await writeManifest(SHA);
});
afterEach(async () => {
  for (const n of await dirNames()) {
    if (n.startsWith("ByWaveCalendar-9.9.9") || n.endsWith(".part")) {
      await rm(path.join(DIR, n), { force: true });
    }
  }
  await rm(MANIFEST, { force: true });
});

describe("上传安装包", () => {
  it("传一个和清单对得上的包 → 落盘，而且 **App 的更新接口改指本站**", async () => {
    const admin = await makeUser("a@example.com", { isAdmin: true });
    const s = await loginAs(admin.id);
    expect(await macUrl(), "布置阶段就该是 GitHub").toBe(GITHUB_URL);

    const res = await upload(s, DMG, BODY);
    expect(res.statusCode, `上传没成功。响应: ${res.body.slice(0, 300)}`).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; sha256: string; referenced: boolean };
    expect(body.ok).toBe(true);
    expect(body.sha256).toBe(SHA);
    expect(body.referenced, "清单明明引用了这个文件名").toBe(true);

    expect(await readFile(path.join(DIR, DMG))).toEqual(BODY);
    expect(
      await macUrl(),
      "文件传上去了，而 App 的自动更新还在往 GitHub 送 —— 这个功能只兑现了一半",
    ).toContain("/downloads/desktop/");
  });

  it("sha256 和清单对不上 → 不落盘，并且把两个值都摆出来", async () => {
    await writeManifest("b".repeat(64));   // 清单里写的是另一个哈希
    const admin = await makeUser("a@example.com", { isAdmin: true });
    const s = await loginAs(admin.id);

    const res = await upload(s, DMG, BODY);
    expect(res.statusCode, "对不上的包被保存了 —— 用户会陷入「下载校验失败」的无限重试").toBe(409);
    expect(res.body, "只说了「不匹配」而没告诉他两个值分别是什么").toContain(SHA);
    expect(res.body).toContain("b".repeat(64));
    expect(await dirNames(), "拒绝了却把文件留在盘上").not.toContain(DMG);
  });

  it("拒绝之后不留 .part 残留", async () => {
    await writeManifest("c".repeat(64));
    const admin = await makeUser("a@example.com", { isAdmin: true });
    const s = await loginAs(admin.id);
    await upload(s, DMG, BODY);
    expect(
      (await dirNames()).filter((n) => n.endsWith(".part")),
      "临时文件没清掉 —— 传几次就把盘塞满了",
    ).toEqual([]);
  });

  it("清单没写 sha256 → 放行，但**明确告诉他没有校验**", async () => {
    await writeManifest("");
    const admin = await makeUser("a@example.com", { isAdmin: true });
    const s = await loginAs(admin.id);
    const res = await upload(s, DMG, BODY);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { unverified: boolean };
    expect(
      body.unverified,
      "清单没写哈希却默默通过了 —— 站长不会知道这一版发出去没有任何客户端校验",
    ).toBe(true);
  });

  it("文件名不合规 → 拒绝，且不落盘", async () => {
    const admin = await makeUser("a@example.com", { isAdmin: true });
    const s = await loginAs(admin.id);
    // 带空格的名字：能上传、能落盘，但发文件那条路会 400 ——
    // 「传成功了、点下去 400」正是判据分两份时的典型表现。
    const res = await upload(s, "ByWave Calendar.dmg", BODY);
    expect(res.statusCode).toBe(400);
    expect(await dirNames()).not.toContain("ByWave Calendar.dmg");
  });

  it("超过上限 → 413（而且用 per-request 的 limits 顶掉了全局的 2MB）", async () => {
    const admin = await makeUser("a@example.com", { isAdmin: true });
    const s = await loginAs(admin.id);
    // 3MB —— 比全局上限(2MB)大。它必须**通过**大小这一关(证明 per-request
    // 覆盖生效了)，然后死在 sha256 比对上。
    const big = Buffer.alloc(3 * 1024 * 1024, 0x41);
    const res = await upload(s, DMG, big);
    expect(
      res.statusCode,
      "3MB 的包被当成超限拒了 —— 说明 per-request 的 limits 没顶掉全局那 2MB，" +
        "真实的 109MB 安装包一个都传不上来",
    ).toBe(409);   // 409 = 走到了 sha256 比对那一步
    expect(res.body).toContain("对不上");
  });

  it("没有 CSRF 令牌 → 403，且不落盘", async () => {
    const admin = await makeUser("a@example.com", { isAdmin: true });
    const s = await loginAs(admin.id);
    const { payload, contentType } = multipartBody(DMG, BODY);
    const res = await app.inject({
      method: "POST", url: "/admin/client-release/desktop/binary",
      headers: { cookie: s.cookie, "content-type": contentType },
      payload,
    });
    expect(res.statusCode).toBe(403);
    expect(await dirNames()).not.toContain(DMG);
  });

  it("非管理员传不了", async () => {
    const u = await makeUser("n@example.com");
    const s = await loginAs(u.id);
    const res = await upload(s, DMG, BODY);
    expect([302, 303, 403]).toContain(res.statusCode);
    expect(await dirNames()).not.toContain(DMG);
  });

  it("同名重传被拒时，线上那份一个字节都没变", async () => {
    const admin = await makeUser("a@example.com", { isAdmin: true });
    const s = await loginAs(admin.id);
    // 先放一份好的
    expect((await upload(s, DMG, BODY)).statusCode).toBe(200);
    // 再传一个内容不同的（sha 对不上，会被拒）
    const other = Buffer.from("a-different-build-".repeat(200));
    const res = await upload(s, DMG, other);
    expect(res.statusCode).toBe(409);
    expect(
      await readFile(path.join(DIR, DMG)),
      "被拒的那次把线上那份覆盖了 —— 正在下载的人会拿到残包",
    ).toEqual(BODY);
  });

  it("能删掉，删完 App 的更新接口回去走上游", async () => {
    const admin = await makeUser("a@example.com", { isAdmin: true });
    const s = await loginAs(admin.id);
    await upload(s, DMG, BODY);
    expect(await macUrl()).toContain("/downloads/desktop/");

    const res = await app.inject({
      method: "POST",
      url: `/admin/client-release/desktop/binary/${encodeURIComponent(DMG)}/delete`,
      headers: { cookie: s.cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ _csrf: s.csrf }).toString(),
    });
    expect(String(res.headers.location)).toContain("success=");
    expect(await dirNames()).not.toContain(DMG);
    expect(await macUrl(), "删掉了还在发本站地址 —— 用户会撞 404").toBe(GITHUB_URL);
  });

  it("上传中途断线：锁要放掉、临时文件要清掉（这条 inject 测不出来，必须起真服务器）", async () => {
    // **这是这个功能最常见的失败方式**：109MB 传好几分钟，用户关标签页或者网断。
    //
    // 第一版在这条路上既不 resolve 也不 reject：@fastify/multipart 在 request
    // 'close' 时 destroy 源流**不带错误**，源只发 'close' 不发 'error'，
    // 而 Node 的 pipe() 不监听源的 'close' —— 写流既不 end 也不 finish，
    // 那个 await 永远挂着，于是 finally 到不了、锁永远删不掉。
    // 后果是那个文件名从此每次重传都撞 409，只能重启服务。
    //
    // 之前 11 条用例一条都抓不到它：全部用 app.inject 发**完整**请求，
    // 结构上就没有「中途断开」这件事。这一条必须真的起 HTTP 服务器、
    // 真的把 socket 掐掉。
    //
    // 用**自己的实例**：在共享的 app 上 listen/close 会把后面的用例一起弄挂。
    const admin = await makeUser("a@example.com", { isAdmin: true });
    const s2 = await loginAs(admin.id);
    const server = await buildApp();
    await server.listen({ port: 0, host: "127.0.0.1" });
    const port = (server.server.address() as { port: number }).port;

    try {
      const http = await import("node:http");
      const { payload, contentType } = multipartBody(DMG, Buffer.alloc(4 * 1024 * 1024, 0x41));
      await new Promise<void>((resolve) => {
        const req = http.request({
          host: "127.0.0.1", port, method: "POST",
          path: "/admin/client-release/desktop/binary",
          headers: {
            cookie: `bwc_sid=${encodeURIComponent(server.signCookie(s2.raw))}`,
            "x-csrf-token": s2.csrf,
            "content-type": contentType,
            "content-length": String(payload.length),
          },
        });
        req.on("error", () => resolve());
        // 先写一小段，让服务端进到「已拿锁、正在写盘」的状态，再掐断。
        req.write(payload.subarray(0, 64 * 1024));
        setTimeout(() => { req.destroy(); resolve(); }, 200);
      });
      // 给服务端一点时间跑完它的清理路径。
      await new Promise((r) => setTimeout(r, 500));

      // 断言一：锁放掉了 —— 用「同名还能不能再传」来验，不去读那个 Set。
      // 读内部状态的话，把锁换成别的实现这条就瞎了。
      const again = await server.inject({
        method: "POST", url: "/admin/client-release/desktop/binary",
        headers: {
          cookie: `bwc_sid=${encodeURIComponent(server.signCookie(s2.raw))}`,
          "x-csrf-token": s2.csrf,
          "content-type": multipartBody(DMG, BODY).contentType,
        },
        payload: multipartBody(DMG, BODY).payload,
      });
      expect(
        again.statusCode,
        `断线之后同名再传撞 409 —— 锁没放掉，那个文件名在重启前永远传不了，` +
          `而页面上看不到锁，站长没有任何线索。响应: ${again.body.slice(0, 200)}`,
      ).not.toBe(409);

      // 断言二：临时文件清掉了 —— 否则传几次断几次就把盘塞满。
      expect(
        (await dirNames()).filter((n) => n.endsWith(".part")),
        "断线留下了 .part 残留",
      ).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("每次上传和删除都留审计", async () => {
    const admin = await makeUser("a@example.com", { isAdmin: true });
    const s = await loginAs(admin.id);
    await upload(s, DMG, BODY);
    await app.inject({
      method: "POST",
      url: `/admin/client-release/desktop/binary/${encodeURIComponent(DMG)}/delete`,
      headers: { cookie: s.cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ _csrf: s.csrf }).toString(),
    });
    const rows = await db.select({ a: schema.adminAuditLog.action }).from(schema.adminAuditLog);
    const actions = rows.map((r) => r.a);
    expect(actions).toContain("app_binary.upload");
    expect(actions).toContain("app_binary.delete");
  });
});
