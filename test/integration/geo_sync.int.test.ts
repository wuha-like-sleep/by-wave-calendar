// 地址包同步通道（/api/geo-sync/*）的协议级验证，走真实 DB（PGlite）
// 与真实文件落盘（临时 GEO_PACK_DIR）：
//   一、鉴权：无令牌 / 形状不对 / secret 不对 / 个人 API Token 形状
//       一律 401 invalid_token；吊销后立即 401；
//   二、白名单：穿越与未登记文件名在开会话时就被拒；
//   三、全流程：manifest 开会话 → 逐片（乱序可）→ complete → 文件原子
//       落位且内容逐字节一致；sqlite 包验 meta.pack_id；
//   四、断点续传：同 manifest 重开会话拿回同一 uploadId 与已收分片，
//       补齐后可完成；
//   五、校验纪律：片 SHA 不符整片拒且不记进度；整体 SHA 不符 complete
//       被拒、暂存删除、目标文件不落位、会话置 failed；pack_id 串包
//       同样被拒；
//   六、会话归属：别人的会话按不存在处理（404）。
import { vi, beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});

import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const packDir = mkdtempSync(path.join(tmpdir(), "bywave-geosync-int-"));
const srcDir = mkdtempSync(path.join(tmpdir(), "bywave-geosync-src-"));
process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://localhost:5432/bywave";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
process.env.GEO_PACK_DIR = packDir;

import Fastify, { type FastifyInstance } from "fastify";
import { ensureSchema, resetDb } from "./harness.js";

const { geoSyncRoutes } = await import("../../src/routes/geo_sync.js");
const {
  createGeoSyncToken, revokeGeoSyncToken, getGeoSyncUpload,
} = await import("../../src/lib/geo_sync.js");
const sqliteMod = (await import("node:sqlite")) as unknown as {
  DatabaseSync: new (file: string) => {
    exec: (sql: string) => void;
    prepare: (sql: string) => { run: (...args: unknown[]) => unknown };
    close: () => void;
  };
};

const CHUNK = 256 * 1024;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function pseudoRandom(bytes: number, seed: number): Buffer {
  const out = Buffer.alloc(bytes);
  let x = seed;
  for (let i = 0; i < bytes; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  return out;
}

function makePackSqlite(packId: string): Buffer {
  const file = path.join(srcDir, `src-${packId}.sqlite`);
  const db = new sqliteMod.DatabaseSync(file);
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
  db.prepare("INSERT INTO meta (key, value) VALUES ('pack_id', ?)").run(packId);
  db.prepare("INSERT INTO meta (key, value) VALUES ('country', 'AU')").run();
  db.close();
  return readFileSync(file);
}

let app: FastifyInstance;
let tokenA: string;
let tokenB: string;
let tokenAId: string;

beforeAll(async () => {
  await ensureSchema();
  app = Fastify();
  await app.register(geoSyncRoutes, { prefix: "/api" });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  rmSync(packDir, { recursive: true, force: true });
  rmSync(srcDir, { recursive: true, force: true });
});
beforeEach(async () => {
  await resetDb();
  const a = await createGeoSyncToken({ label: "DGX A", createdBy: null });
  const b = await createGeoSyncToken({ label: "DGX B", createdBy: null });
  tokenA = a.plain; tokenAId = a.id; tokenB = b.plain;
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function openSession(t: string, manifest: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/api/geo-sync/uploads", headers: auth(t), payload: manifest });
}
async function putChunk(t: string, id: string, index: number, data: Buffer, chunkSha?: string) {
  return app.inject({
    method: "PUT",
    url: `/api/geo-sync/uploads/${id}/chunks/${index}`,
    headers: { ...auth(t), "content-type": "application/octet-stream", "x-chunk-sha256": chunkSha ?? sha(data) },
    payload: data,
  });
}
async function complete(t: string, id: string) {
  return app.inject({ method: "POST", url: `/api/geo-sync/uploads/${id}/complete`, headers: auth(t) });
}

/** 把一整份内容按会话规划传完（可指定只传部分片）。 */
async function uploadAll(t: string, view: { uploadId: string; chunkSize: number; chunkCount: number }, content: Buffer, only?: number[]) {
  for (let i = 0; i < view.chunkCount; i++) {
    if (only && !only.includes(i)) continue;
    const part = content.subarray(i * view.chunkSize, Math.min(content.length, (i + 1) * view.chunkSize));
    const res = await putChunk(t, view.uploadId, i, Buffer.from(part));
    expect(res.statusCode, `chunk ${i}`).toBe(200);
  }
}

describe("鉴权", () => {
  it("无令牌 / 垃圾令牌 / 个人 Token 形状 → 401 invalid_token", async () => {
    for (const headers of [
      {},
      { authorization: "Bearer nonsense" },
      { authorization: `Bearer bwc_${"Ab3dEf7H"}_${"x".repeat(24)}` },
      { authorization: `Bearer bwgs_${"Ab3dEf7H"}_${"x".repeat(32)}` }, // 形状对、secret 不存在
    ]) {
      const res = await app.inject({ method: "GET", url: "/api/geo-sync/packs", headers });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "invalid_token" });
    }
  });

  it("吊销后立即失效", async () => {
    const ok = await app.inject({ method: "GET", url: "/api/geo-sync/packs", headers: auth(tokenA) });
    expect(ok.statusCode).toBe(200);
    expect(await revokeGeoSyncToken(tokenAId)).toBe(true);
    const after = await app.inject({ method: "GET", url: "/api/geo-sync/packs", headers: auth(tokenA) });
    expect(after.statusCode).toBe(401);
  });
});

describe("文件名白名单", () => {
  it("穿越与未登记文件名开会话即拒", async () => {
    for (const file of ["../pack-au.sqlite", "evil.exe", "pack-au.sqlite.exe", "licences/../../etc/passwd", "random.txt"]) {
      const res = await openSession(tokenA, { file, bytes: 10, sha256: "a".repeat(64) });
      expect(res.statusCode, file).toBe(400);
      expect(res.json().error).toBe("file_not_allowed");
    }
  });

  it("manifest 本身不合法（sha 形状 / 字节数）被拒", async () => {
    const badSha = await openSession(tokenA, { file: "pack-au-ot.sqlite", bytes: 10, sha256: "xyz" });
    expect(badSha.statusCode).toBe(400);
    const badBytes = await openSession(tokenA, { file: "pack-au-ot.sqlite", bytes: -1, sha256: "a".repeat(64) });
    expect(badBytes.statusCode).toBe(400);
  });
});

describe("全流程与落位", () => {
  it("文本配套文件：开会话 → 传片 → complete → 落位且逐字节一致", async () => {
    const content = Buffer.from(JSON.stringify({ pack_id: "au-ot", rows_total: 5174 }) + "\n");
    const res = await openSession(tokenA, { file: "manifest-au-ot.json", bytes: content.length, sha256: sha(content) });
    expect(res.statusCode).toBe(201);
    const view = res.json();
    expect(view.chunkCount).toBe(1);
    await uploadAll(tokenA, view, content);
    const done = await complete(tokenA, view.uploadId);
    expect(done.statusCode).toBe(200);
    expect(done.json().status).toBe("active");
    expect(readFileSync(path.join(packDir, "manifest-au-ot.json")).equals(content)).toBe(true);
  });

  it("sqlite 包：meta.pack_id 对得上才落位，packs 清单能看到", async () => {
    const content = makePackSqlite("au-ot");
    const res = await openSession(tokenA, {
      file: "pack-au-ot.sqlite", bytes: content.length, sha256: sha(content),
      rows: 5174, region: "Other Territories, Australia", packVersion: "2026.11.2",
    });
    expect(res.statusCode).toBe(201);
    const view = res.json();
    await uploadAll(tokenA, view, content);
    const done = await complete(tokenA, view.uploadId);
    expect(done.statusCode).toBe(200);
    expect(readFileSync(path.join(packDir, "pack-au-ot.sqlite")).equals(content)).toBe(true);
    const packs = await app.inject({ method: "GET", url: "/api/geo-sync/packs", headers: auth(tokenA) });
    expect(packs.statusCode).toBe(200);
    expect(packs.json().packs.map((p: { file: string }) => p.file)).toContain("pack-au-ot.sqlite");
  });

  it("pack_id 串包：文件名与 meta 不一致 → 422 且不落位", async () => {
    const content = makePackSqlite("au-xxx");
    const res = await openSession(tokenA, { file: "pack-au-yyy.sqlite", bytes: content.length, sha256: sha(content) });
    const view = res.json();
    await uploadAll(tokenA, view, content);
    const done = await complete(tokenA, view.uploadId);
    expect(done.statusCode).toBe(422);
    expect(done.json().error).toBe("pack_id_mismatch");
    expect(existsSync(path.join(packDir, "pack-au-yyy.sqlite"))).toBe(false);
  });
});

describe("断点续传与校验纪律", () => {
  const content = pseudoRandom(600_000, 42);
  const manifest = () => ({
    file: "pack-au-nt.sqlite", bytes: content.length, sha256: sha(content), chunkSize: CHUNK,
  });

  it("中断后重开会话：同一 uploadId、已收分片还在，补齐可完成", async () => {
    const first = (await openSession(tokenA, manifest())).json();
    expect(first.chunkCount).toBe(3);
    await uploadAll(tokenA, first, content, [0, 2]);
    // 模拟中断后重开：同 manifest 应找回同一会话
    const resumed = (await openSession(tokenA, manifest())).json();
    expect(resumed.uploadId).toBe(first.uploadId);
    expect(resumed.receivedChunks).toEqual([0, 2]);
    await uploadAll(tokenA, resumed, content, [1]);
    const done = await complete(tokenA, first.uploadId);
    // 内容是伪随机字节不是 sqlite → 内容自检会拒；用状态查询确认「收齐」这一步走通了：
    // 这里验的是续传语义本身，落位成功由上一组 sqlite 用例覆盖。
    expect(done.statusCode).toBe(422);
    expect(done.json().error).toBe("not_a_sqlite_file");
  });

  it("片 SHA 不符：整片拒绝且不记进度", async () => {
    const view = (await openSession(tokenA, manifest())).json();
    const part = Buffer.from(content.subarray(0, CHUNK));
    const res = await putChunk(tokenA, view.uploadId, 0, part, "0".repeat(64));
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("chunk_checksum_mismatch");
    const status = await app.inject({ method: "GET", url: `/api/geo-sync/uploads/${view.uploadId}`, headers: auth(tokenA) });
    expect(status.json().receivedChunks).toEqual([]);
  });

  it("整体 SHA 不符：complete 被拒、暂存删除、不落位、会话 failed", async () => {
    const wrongSha = sha(Buffer.from("some other content"));
    const view = (await openSession(tokenA, { ...manifest(), sha256: wrongSha })).json();
    await uploadAll(tokenA, view, content);
    const done = await complete(tokenA, view.uploadId);
    expect(done.statusCode).toBe(422);
    expect(done.json().error).toBe("sha256_mismatch");
    expect(existsSync(path.join(packDir, "pack-au-nt.sqlite"))).toBe(false);
    const row = await getGeoSyncUpload(view.uploadId);
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("sha256_mismatch");
  });

  it("缺片 complete → 409 并列出缺片，会话保持 receiving", async () => {
    const view = (await openSession(tokenA, manifest())).json();
    await uploadAll(tokenA, view, content, [0]);
    const done = await complete(tokenA, view.uploadId);
    expect(done.statusCode).toBe(409);
    expect(done.json().missing).toEqual([1, 2]);
    const row = await getGeoSyncUpload(view.uploadId);
    expect(row?.status).toBe("receiving");
  });
});

describe("会话归属", () => {
  it("别人的会话按不存在处理", async () => {
    const view = (await openSession(tokenA, {
      file: "manifest-au-nt.json", bytes: 4, sha256: sha(Buffer.from("test")),
    })).json();
    const peek = await app.inject({ method: "GET", url: `/api/geo-sync/uploads/${view.uploadId}`, headers: auth(tokenB) });
    expect(peek.statusCode).toBe(404);
    const done = await complete(tokenB, view.uploadId);
    expect(done.statusCode).toBe(404);
    // 本人则一切正常
    const own = await app.inject({ method: "GET", url: `/api/geo-sync/uploads/${view.uploadId}`, headers: auth(tokenA) });
    expect(own.statusCode).toBe(200);
  });
});
