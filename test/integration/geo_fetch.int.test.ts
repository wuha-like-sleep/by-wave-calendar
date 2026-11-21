// 后台「获取官方地址包」全链路（HTTP 口径）：
//   一、非管理员启动不了获取（任务状态纹丝不动）；
//   二、管理员一点，服务端从发布基地址拉清单 → 分卷下载 → 逐卷/整
//       文件 SHA 复核 → 原子落位，包与配套、共享许可都到包目录；
//   三、落位后 /api/geo/suggest 真的从包里答出地址（不是只看文件）；
//   四、再点一次，全部跳过（已是最新）。
// 发布源是本文件起的本地静态服务（带 Range），包是本地造的微型真
// 包（能过服务端 sqlite 自检、能被 provider 真查）。GEO_* 环境变
// 量必须在 import 路由之前就位（env.ts 在模块加载时定死）。
import { vi, beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, schema: h.schema };
});
vi.mock("../../src/lib/mailer.js", () => ({
  sendMail: vi.fn(async () => ({ ok: true })), isMailerEnabled: vi.fn(async () => true),
}));

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import view from "@fastify/view";
import ejs from "ejs";
import path from "node:path";
import { createHash, createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { ensureSchema, resetDb, makeUser, db, schema } from "./harness.js";
import { newSessionId } from "../../src/lib/ids.js";

process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgres://localhost:5432/bywave";
process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789";
const SESSION_SECRET = process.env.SESSION_SECRET;

const sha = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex");

// --- 微型真包（与 test/geo_release.test.ts 同款夹具） -------------------
function buildTinyPack(): Buffer {
  const dir = mkdtempSync(path.join(tmpdir(), "bywave-fetchpack-"));
  const full = path.join(dir, "pack-au-ot.sqlite");
  const pdb = new DatabaseSync(full);
  pdb.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)");
  pdb.exec(`CREATE TABLE addresses(
    cid INTEGER PRIMARY KEY, display TEXT, unit TEXT, number TEXT,
    street_name TEXT, street_type TEXT, suburb TEXT, state TEXT, postcode TEXT,
    poi_name TEXT, category TEXT, weight REAL, lat REAL, lon REAL, sources TEXT)`);
  pdb.exec('CREATE VIRTUAL TABLE addr_fts USING fts5(search_text, tokenize="unicode61 remove_diacritics 2")');
  pdb.exec("CREATE VIRTUAL TABLE addr_tri USING fts5(search_text, tokenize=trigram)");
  const insMeta = pdb.prepare("INSERT INTO meta VALUES (?,?)");
  insMeta.run("pack_id", "au-ot");
  insMeta.run("country", "AU");
  insMeta.run("region", "Other Territories, Australia");
  insMeta.run("schema", "1");
  insMeta.run("built_unix", "1795183104");
  pdb.prepare("INSERT INTO addresses VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    1, "1 Test Harbour Road, Testville TAS 7000", "", "1", "Test Harbour", "Road",
    "Testville", "TAS", "7000", "", "", 10, -42.8, 147.3, "gnaf",
  );
  pdb.prepare("INSERT INTO addr_fts(rowid, search_text) VALUES (?,?)").run(1, "1 test harbour road testville tas 7000");
  pdb.prepare("INSERT INTO addr_tri(rowid, search_text) VALUES (?,?)").run(1, "1 test harbour road testville tas 7000");
  pdb.close();
  const buf = readFileSync(full);
  rmSync(dir, { recursive: true, force: true });
  return buf;
}

const packBuf = buildTinyPack();
const packSha = sha(packBuf);
const half = Math.floor(packBuf.length / 2);
const part0 = packBuf.subarray(0, half);
const part1 = packBuf.subarray(half);
const companion = Buffer.from(JSON.stringify({ pack_id: "au-ot", file: "pack-au-ot.sqlite", sha256: packSha }));
const licenceText = Buffer.from("fake licence text for tests");

const packDir = mkdtempSync(path.join(tmpdir(), "bywave-fetch-packdir-"));
const releaseDir = mkdtempSync(path.join(tmpdir(), "bywave-fetch-release-"));
writeFileSync(path.join(releaseDir, "pack-au-ot.sqlite.part-000"), part0);
writeFileSync(path.join(releaseDir, "pack-au-ot.sqlite.part-001"), part1);
writeFileSync(path.join(releaseDir, "manifest-au-ot.json"), companion);
mkdirSync(path.join(releaseDir, "licences"));
writeFileSync(path.join(releaseDir, "licences", "test-licence.txt"), licenceText);
writeFileSync(path.join(releaseDir, "geo-pack-release.json"), JSON.stringify({
  format: 1,
  release: "geo-packs-au-vTest",
  packs: [{
    pack_id: "au-ot",
    file: "pack-au-ot.sqlite",
    bytes: packBuf.length,
    sha256: packSha,
    rows_total: 1,
    parts: [
      { name: "pack-au-ot.sqlite.part-000", bytes: part0.length, sha256: sha(part0) },
      { name: "pack-au-ot.sqlite.part-001", bytes: part1.length, sha256: sha(part1) },
    ],
    companions: [{ name: "manifest-au-ot.json", bytes: companion.length, sha256: sha(companion) }],
  }],
  shared: [{ name: "licences/test-licence.txt", bytes: licenceText.length, sha256: sha(licenceText) }],
}));

const releaseServer: Server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://stub");
  const rel = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const full = path.join(releaseDir, rel);
  if (!full.startsWith(releaseDir) || !existsSync(full)) {
    res.writeHead(404).end("nope");
    return;
  }
  const data = readFileSync(full);
  const m = req.headers.range ? /^bytes=(\d+)-$/.exec(req.headers.range) : null;
  if (m) {
    const start = Number(m[1]);
    res.writeHead(206, {
      "content-range": `bytes ${start}-${data.length - 1}/${data.length}`,
      "content-length": String(data.length - start),
    });
    res.end(data.subarray(start));
    return;
  }
  res.writeHead(200, { "content-length": String(data.length) });
  res.end(data);
});
await new Promise<void>((r) => releaseServer.listen(0, "127.0.0.1", r));
const releasePort = (releaseServer.address() as { port: number }).port;

process.env.GEO_PACK_DIR = packDir;
process.env.GEO_PACK_RELEASE_BASE_URL = `http://127.0.0.1:${releasePort}`;
process.env.GEO_PACK_RELEASE_ALLOW_PRIVATE_NETWORK = "true";

const { adminRoutes } = await import("../../src/web/admin.js");
const { geoRoutes } = await import("../../src/routes/geo.js");
const { getGeoPackFetchState } = await import("../../src/lib/geo_release.js");

let app: FastifyInstance;

async function buildApp(): Promise<FastifyInstance> {
  const a = Fastify({ logger: false });
  await a.register(cookie, { secret: "integration-test-cookie-secret-32-chars-min" });
  await a.register(formbody);
  await a.register(multipart, { limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 5 } });
  await a.register(view, {
    engine: { ejs }, root: path.resolve("src/views"), propertyName: "view",
    options: { async: false },
    defaultContext: {
      t: (k: string) => k, siteName: "ByWave", siteLogoUrl: null, icpNumber: null,
      icpUrl: "", assetVersion: "t", jsBasePath: "/static/js", cspNonce: "n",
      currentLocale: "zh-CN", locales: [], siteLocaleOptions: [], currentUser: null,
      themePalette: "indigo", themeDensity: "comfortable", currentPath: "/admin/geo-packs",
    },
  });
  await a.register(adminRoutes);
  await a.register(geoRoutes, { prefix: "/api/v1" });
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
    cookie: `bwc_sid=${encodeURIComponent(app.signCookie(sid))}`,
    csrf: createHmac("sha256", SESSION_SECRET).update(sid).digest("hex"),
  };
}

async function waitForJob(timeoutMs = 60_000) {
  const t0 = Date.now();
  for (;;) {
    const s = getGeoPackFetchState();
    if (s && s.finishedAt) return s;
    if (Date.now() - t0 > timeoutMs) throw new Error("fetch job did not finish in time");
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  await ensureSchema();
  app = await buildApp();
});
afterAll(async () => {
  await app.close();
  await new Promise<void>((r) => releaseServer.close(() => r()));
  rmSync(packDir, { recursive: true, force: true });
  rmSync(releaseDir, { recursive: true, force: true });
});
beforeEach(async () => { await resetDb(); });

describe("后台获取官方地址包", () => {
  it("非管理员启动不了获取", async () => {
    const plain = await makeUser("plain@example.com");
    const s = await loginAs(plain.id);
    const res = await app.inject({
      method: "POST", url: "/admin/geo-packs/fetch",
      headers: { cookie: s.cookie, "x-csrf-token": s.csrf, "content-type": "application/x-www-form-urlencoded" },
      payload: `_csrf=${s.csrf}`,
    });
    expect(res.statusCode).not.toBe(200);
    expect(getGeoPackFetchState()).toBeNull();
  });

  it("管理员一键获取：分卷落位 → suggest 命中 → 再获取全跳过", async () => {
    const admin = await makeUser("admin@example.com", { isAdmin: true });
    const s = await loginAs(admin.id);

    const res = await app.inject({
      method: "POST", url: "/admin/geo-packs/fetch",
      headers: { cookie: s.cookie, "x-csrf-token": s.csrf, "content-type": "application/x-www-form-urlencoded" },
      payload: `_csrf=${s.csrf}`,
    });
    expect(res.statusCode).toBe(302);

    const job = await waitForJob();
    expect(job.status).toBe("done");
    expect(job.release).toBe("geo-packs-au-vTest");
    expect(job.files.every((f) => f.status === "done")).toBe(true);

    // 落位结果：包本体逐字一致，配套与共享许可都在。
    expect(readFileSync(path.join(packDir, "pack-au-ot.sqlite"))).toEqual(packBuf);
    expect(existsSync(path.join(packDir, "manifest-au-ot.json"))).toBe(true);
    expect(existsSync(path.join(packDir, "licences", "test-licence.txt"))).toBe(true);

    // suggest 真的从包里答出来（provider=pack 默认，包目录即 GEO_PACK_DIR）。
    const sug = await app.inject({
      method: "GET", url: "/api/v1/geo/suggest?q=test%20harbour",
      headers: { cookie: s.cookie },
    });
    expect(sug.statusCode).toBe(200);
    const body = JSON.parse(sug.body) as { suggestions: Array<{ label: string }> };
    expect(body.suggestions.some((x) => x.label.includes("Test Harbour"))).toBe(true);

    // 再获取一次：包文件应被判为已最新并跳过。
    const res2 = await app.inject({
      method: "POST", url: "/admin/geo-packs/fetch",
      headers: { cookie: s.cookie, "x-csrf-token": s.csrf, "content-type": "application/x-www-form-urlencoded" },
      payload: `_csrf=${s.csrf}`,
    });
    expect(res2.statusCode).toBe(302);
    const job2 = await waitForJob();
    expect(job2.status).toBe("done");
    expect(job2.files.find((f) => f.file === "pack-au-ot.sqlite")!.status).toBe("skipped");
  });
});
