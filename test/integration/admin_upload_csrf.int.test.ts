// 三条上传路由的 CSRF：更新包、站点 Logo、BIMI Logo —— 从 HTTP 打进去。
//
// 这三条原来都不校验令牌（「multipart 读不到，靠 SameSite 兜底」），而本站和同一个
// 上级域名下的几十个站点在浏览器眼里算「同站」，那道兜底拦不住它们。
//
// **两个方向都要测**：
//   · 伪造的（没令牌）必须被拒 —— 这是要修的洞；
//   · 正常的（带令牌）必须照常通过 —— 服务端加了校验而表单没带令牌的话，功能就
//     整个坏了。站点 Logo 那张表单一开始就没放令牌，加上校验的那一刻，每一次正常
//     上传都会被拒 —— 是门禁拦下来的，这三条路由原来一条测试都没有。
//
// 正常方向的请求故意在「过了令牌之后」停在一个无害的地方（文件类型不对 / 缺签名），
// 既证明令牌那一关过了，又不真的写文件、不真的应用更新。

import { vi, beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";

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
import { createHmac } from "node:crypto";
import { ensureSchema, resetDb, db, schema, makeUser } from "./harness.js";
import { newSessionId } from "../../src/lib/ids.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://integration-test/unused";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";

const { adminRoutes } = await import("../../src/web/admin.js");
let app: FastifyInstance;

beforeAll(async () => {
  await ensureSchema();
  app = Fastify({ logger: false });
  await app.register(cookie, { secret: "integration-test-cookie-secret-32-chars-min" });
  await app.register(formbody);
  await app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024 } });
  await app.register(view, {
    engine: { ejs }, root: path.resolve("src/views"), propertyName: "view", options: { async: false },
    defaultContext: {
      t: (k: string) => k, siteName: "ByWave", siteLogoUrl: null, icpNumber: null, icpUrl: "",
      assetVersion: "t", jsBasePath: "/static/js", cspNonce: "n", currentLocale: "zh-CN",
      locales: [], siteLocaleOptions: [], currentUser: null, themePalette: "indigo",
      themeDensity: "comfortable", currentPath: "/admin",
    },
  });
  await app.register(adminRoutes);
  await app.ready();
});
afterAll(async () => { await app?.close(); });

let sess: { cookie: string; csrf: string };
beforeEach(async () => {
  await resetDb();
  const admin = await makeUser("admin@example.com", { isAdmin: true });
  const sid = newSessionId();
  await db.insert(schema.sessions).values({ id: sid, userId: admin.id, mfaSatisfied: true, expiresAt: new Date(Date.now() + 86400_000) });
  sess = {
    cookie: `bwc_sid=${encodeURIComponent(app.signCookie(sid))}`,
    csrf: createHmac("sha256", process.env.SESSION_SECRET!).update(sid).digest("hex"),
  };
});

type Part = { name: string; value?: string; filename?: string; type?: string; body?: Buffer };
function multipartReq(url: string, parts: Part[]) {
  const b = "----bwc" + Math.random().toString(36).slice(2);
  const chunks: Buffer[] = [];
  for (const p of parts) {
    if (p.filename !== undefined) {
      chunks.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\nContent-Type: ${p.type ?? "application/octet-stream"}\r\n\r\n`));
      chunks.push(p.body ?? Buffer.from("x"));
      chunks.push(Buffer.from("\r\n"));
    } else {
      chunks.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value ?? ""}\r\n`));
    }
  }
  chunks.push(Buffer.from(`--${b}--\r\n`));
  return app.inject({
    method: "POST", url,
    headers: { cookie: sess.cookie, "content-type": `multipart/form-data; boundary=${b}` },
    payload: Buffer.concat(chunks),
  });
}
const csrfPart = (): Part => ({ name: "_csrf", value: sess.csrf });
const where = (res: { headers: Record<string, unknown> }) => decodeURIComponent(String(res.headers.location ?? ""));

describe("站点 Logo", () => {
  const file = (): Part => ({ name: "logo", filename: "a.txt", type: "text/plain", body: Buffer.from("not an image") });

  it("没令牌 → 403", async () => {
    const res = await multipartReq("/admin/logo", [file()]);
    expect(res.statusCode, "伪造的 Logo 上传没被拒绝").toBe(403);
  });

  it("**带令牌 → 过了令牌这一关**（停在「文件类型不对」，不真的写）", async () => {
    const res = await multipartReq("/admin/logo", [csrfPart(), file()]);
    expect(res.statusCode, "带着正确令牌的正常上传被拒了 —— 站点 Logo 上传整个坏了").not.toBe(403);
    expect(where(res), "没走到文件类型那一步").toMatch(/仅支持/);
  });
});

describe("BIMI Logo", () => {
  const file = (): Part => ({ name: "file", filename: "a.png", type: "image/png", body: Buffer.from("png") });

  it("没令牌 → 403", async () => {
    expect((await multipartReq("/admin/bimi/logo", [file()])).statusCode).toBe(403);
  });

  it("**带令牌 → 过了令牌这一关**（停在「必须是 SVG」）", async () => {
    const res = await multipartReq("/admin/bimi/logo", [csrfPart(), file()]);
    expect(res.statusCode, "正常的 BIMI 上传被拒了").not.toBe(403);
    expect(where(res)).toMatch(/SVG/);
  });
});

describe("更新包", () => {
  const tarball = (): Part => ({ name: "tarball", filename: "u.tar.gz", type: "application/gzip", body: Buffer.from("fake") });

  it("**没令牌 → 403，而且在其它任何判断之前**", async () => {
    // 签名挡得住伪造的包，挡不住签名完好的旧版本（降级）—— 令牌是那道闸。
    const res = await multipartReq("/admin/update/upload", [tarball()]);
    expect(res.statusCode, "伪造的更新上传没被拒绝").toBe(403);
    expect(res.body).toMatch(/csrf/i);
  });

  it("**带令牌 → 过了令牌这一关**（停在「缺少签名」，不会真的去应用）", async () => {
    const res = await multipartReq("/admin/update/upload", [csrfPart(), tarball()]);
    expect(res.statusCode, `正常的更新上传被拒了：${res.body.slice(0, 200)}`).not.toBe(403);
    expect(res.body, "没走到签名检查那一步").toMatch(/签名/);
  });

  it("令牌排在文件后面也认（页面 JS 拼表单时顺序可能不一样）", async () => {
    const res = await multipartReq("/admin/update/upload", [tarball(), csrfPart()]);
    expect(res.statusCode).not.toBe(403);
  });
});
