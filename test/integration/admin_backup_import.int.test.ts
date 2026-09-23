// 后台「导入备份」到底能收多大的文件 —— 从 HTTP 打进去。
//
// ── 这条的形状 ────────────────────────────────────────────────────────
//
// 路由里写着 `if (buf.length > 100 * 1024 * 1024) ... "文件过大（>100MB）"`，
// 看上去上限是 100MB。而它用的是 `req.file()` **没带 per-request limits**，
// 于是继承全局的 2MB —— `file.toBuffer()` 在 2MB 处就抛
// RequestFileTooLargeError，那句 100MB 的判断**永远跑不到**。
//
// 后果：任何超过 2MB 的备份都导不进来，而站长看到的是 Fastify 默认的
// 英文 413 JSON，不是那句中文提示。而「导出一份备份」对任何真实站点来说
// 都远不止 2MB —— 也就是说这个功能对它的目标用户是坏的。
//
// 这就是「代码里写着一个上限、实际生效的是另一个」：两个数字都在源码里，
// 各自看都合理，只有把它们放在一起看才会发现前一个是死的。

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
const SESSION_SECRET = process.env.SESSION_SECRET;

const { adminRoutes } = await import("../../src/web/admin.js");

let app: FastifyInstance;

async function buildApp(): Promise<FastifyInstance> {
  const a = Fastify({ logger: false });
  await a.register(cookie, { secret: "integration-test-cookie-secret-32-chars-min" });
  await a.register(formbody);
  // 全局上限设成和生产一样的 2MB —— 这一档要测的正是「路由有没有自己顶掉它」。
  await a.register(multipart, { limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 5 } });
  await a.register(view, {
    engine: { ejs }, root: path.resolve("src/views"), propertyName: "view",
    options: { async: false },
    defaultContext: {
      t: (k: string) => k, siteName: "ByWave", siteLogoUrl: null, icpNumber: null,
      icpUrl: "", assetVersion: "t", jsBasePath: "/static/js", cspNonce: "n",
      currentLocale: "zh-CN", locales: [], siteLocaleOptions: [], currentUser: null,
      themePalette: "indigo", themeDensity: "comfortable", currentPath: "/admin/backup",
    },
  });
  await a.register(adminRoutes);
  await a.ready();
  return a;
}

async function loginAs(userId: string) {
  const sid = newSessionId();
  await db.insert(schema.sessions).values({
    id: sid, userId, mfaSatisfied: true, expiresAt: new Date(Date.now() + 86400_000),
  });
  return {
    cookie: `bwc_sid=${encodeURIComponent(app.signCookie(sid))}`,
    csrf: createHmac("sha256", SESSION_SECRET).update(sid).digest("hex"),
  };
}

/** 造一份合法但很大的备份 JSON。内容本身无所谓 —— 这一档测的是「收不收得下」。
 *
 *  **按实际字节数生成,不按估算。** 第一版用 `n += 1020` 估每行长度,
 *  结果要 67,633,152 字节却只生成了 67,103,735 —— 比上限还小 5KB,
 *  于是「超过上限」那条用例测的是一个没超限的文件,而它「正确地」没被拒。
 *  夹具说谎的时候,断言再严也没用。 */
function bigBackup(atLeastBytes: number): Buffer {
  const row = JSON.stringify({ note: "x".repeat(1000) });
  const head = '{"exportedAt":"2026-01-01T00:00:00Z","tables":{"notes":[';
  const tail = "]}}";
  const need = Math.max(1, Math.ceil((atLeastBytes - head.length - tail.length) / (row.length + 1)));
  const buf = Buffer.from(head + Array(need).fill(row).join(",") + tail);
  // 自检:生成出来的必须真的 >= 要求,否则这条用例什么也没测到。
  if (buf.length < atLeastBytes) {
    throw new Error(`夹具生成不足:要 ${atLeastBytes}，只生成了 ${buf.length}`);
  }
  return buf;
}

function multipartBody(filename: string, content: Buffer) {
  const b = "----bwc" + Math.random().toString(36).slice(2);
  const head = Buffer.from(
    `--${b}\r\nContent-Disposition: form-data; name="backup"; filename="${filename}"\r\n` +
    `Content-Type: application/json\r\n\r\n`,
  );
  return { payload: Buffer.concat([head, content, Buffer.from(`\r\n--${b}--\r\n`)]),
           contentType: `multipart/form-data; boundary=${b}` };
}

async function importBackup(s: { cookie: string }, content: Buffer) {
  const { payload, contentType } = multipartBody("backup.json", content);
  return app.inject({
    method: "POST", url: "/admin/backup/import",
    headers: { cookie: s.cookie, "content-type": contentType },
    payload,
  });
}

beforeAll(async () => { await ensureSchema(); app = await buildApp(); });
afterAll(async () => { await app?.close(); });
beforeEach(async () => { await resetDb(); });

describe("导入备份", () => {
  it("小文件能进（presence —— 没有这条，下面那条可能只是「这条路本来就不通」）", async () => {
    const admin = await makeUser("a@example.com", { isAdmin: true });
    const s = await loginAs(admin.id);
    const res = await importBackup(s, bigBackup(1000));
    // 内容不是真的备份格式，所以会在解析/导入那一步失败 —— 但**必须是
    // 跳回后台带提示**，而不是 413。
    expect([302, 303]).toContain(res.statusCode);
  });

  it("3MB 的备份能被收下 —— 而不是撞上全局那 2MB", async () => {
    // 这才是这一档的重点。真实站点导出来的备份远不止 2MB，
    // 而路由里写着的上限是 100MB。
    const admin = await makeUser("a@example.com", { isAdmin: true });
    const s = await loginAs(admin.id);
    const res = await importBackup(s, bigBackup(3 * 1024 * 1024));
    expect([302, 303], `回的是 ${res.statusCode}，不是跳回后台`).toContain(res.statusCode);
    // **断言必须落在「越过了大小那一关」上，不能只写「不是 413」。**
    // 第一版就是只写了 not.toBe(413) + 是跳转 —— 而把 limits 去掉之后，
    // 请求会走进「文件过大」那条 catch，同样回 302，断言照样绿。
    // A/B 当场抓到了这个洞：变异之后 4 条全过。
    const where = decodeURIComponent(String(res.headers.location));
    expect(
      where,
      "3MB 的备份被当成「过大」拒了 —— 路由没有自己的 limits，继承了全局的 2MB，" +
        "而它自己写的上限是另一个数字。真实站点导出来的备份一个都导不进来。",
    ).not.toMatch(/过大|上限/);
  });

  it("真超过上限时，给的是自己那句中文提示，不是 Fastify 的英文 413", async () => {
    const admin = await makeUser("a@example.com", { isAdmin: true });
    const s = await loginAs(admin.id);
    const { MAX_BACKUP_IMPORT_BYTES } = await import("../../src/web/admin.js");
    const res = await importBackup(s, bigBackup(MAX_BACKUP_IMPORT_BYTES + 512 * 1024));
    expect([302, 303], `超限时回的是 ${res.statusCode}，不是跳回后台`).toContain(res.statusCode);
    expect(
      decodeURIComponent(String(res.headers.location)),
      "超限时没有给出能看懂的中文提示",
    ).toMatch(/过大|上限/);
  });

  it("非管理员导不了", async () => {
    const u = await makeUser("n@example.com");
    const s = await loginAs(u.id);
    const res = await importBackup(s, bigBackup(1000));
    expect([302, 303, 403]).toContain(res.statusCode);
    expect(String(res.headers.location ?? "")).not.toContain("/admin/backup?success");
  });
});
