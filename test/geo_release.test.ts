// 官方地址包发布格式与获取：清单校验（外部输入按不可信处理，穿越 /
// 串包 / 分卷对不上账一律拒）、分卷拼接 + 逐卷与整文件 SHA 复核、
// 下载断点续传。DB 与后台 HTTP 入口在 test/integration/geo_fetch
// .int.test.ts 里走真实路径验。
process.env.PUBLIC_BASE_URL ||= "http://localhost:3000";
process.env.DATABASE_URL ||= "postgres://localhost:5432/bywave";
process.env.SESSION_SECRET ||= "test-session-secret-at-least-32-chars-long";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const {
  parseGeoReleaseManifest,
  releaseFilePlan,
  fetchGeoReleaseFile,
  downloadGeoAsset,
  previewGeoPackRelease,
  GeoReleaseError,
  MAX_RELEASE_PART_BYTES,
} = await import("../src/lib/geo_release.js");

const sha = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex");

// ---------------------------------------------------------------------------
// 夹具：一个能过服务端自检（文件头 + meta.pack_id）的微型真包
// ---------------------------------------------------------------------------

function buildTinyPack(file: string): Buffer {
  const dir = mkdtempSync(path.join(tmpdir(), "bywave-tinypack-"));
  const full = path.join(dir, file);
  const db = new DatabaseSync(full);
  db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)");
  db.exec(`CREATE TABLE addresses(
    cid INTEGER PRIMARY KEY, display TEXT, unit TEXT, number TEXT,
    street_name TEXT, street_type TEXT, suburb TEXT, state TEXT, postcode TEXT,
    poi_name TEXT, category TEXT, weight REAL, lat REAL, lon REAL, sources TEXT)`);
  db.exec('CREATE VIRTUAL TABLE addr_fts USING fts5(search_text, tokenize="unicode61 remove_diacritics 2")');
  db.exec("CREATE VIRTUAL TABLE addr_tri USING fts5(search_text, tokenize=trigram)");
  const insMeta = db.prepare("INSERT INTO meta VALUES (?,?)");
  insMeta.run("pack_id", "au-ot");
  insMeta.run("country", "AU");
  insMeta.run("region", "Other Territories, Australia");
  insMeta.run("schema", "1");
  insMeta.run("built_unix", "1795183104");
  db.prepare("INSERT INTO addresses VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    1, "1 Test Harbour Road, Testville TAS 7000", "", "1", "Test Harbour", "Road",
    "Testville", "TAS", "7000", "", "", 10, -42.8, 147.3, "gnaf",
  );
  db.prepare("INSERT INTO addr_fts(rowid, search_text) VALUES (?,?)").run(1, "1 test harbour road testville tas 7000");
  db.prepare("INSERT INTO addr_tri(rowid, search_text) VALUES (?,?)").run(1, "1 test harbour road testville tas 7000");
  db.close();
  const buf = readFileSync(full);
  rmSync(dir, { recursive: true, force: true });
  return buf;
}

const packBuf = buildTinyPack("pack-au-ot.sqlite");
const packSha = sha(packBuf);
const half = Math.floor(packBuf.length / 2);
const part0 = packBuf.subarray(0, half);
const part1 = packBuf.subarray(half);
const companion = Buffer.from(JSON.stringify({ pack_id: "au-ot", file: "pack-au-ot.sqlite", sha256: packSha }));
const licenceText = Buffer.from("fake licence text for tests");

function manifestWithParts() {
  return {
    format: 1,
    release: "geo-packs-au-vTest",
    generated_at: "2026-11-21T00:00:00Z",
    packs: [
      {
        pack_id: "au-ot",
        file: "pack-au-ot.sqlite",
        bytes: packBuf.length,
        sha256: packSha,
        rows_total: 1,
        region: "Other Territories, Australia",
        pack_version: "test",
        parts: [
          { name: "pack-au-ot.sqlite.part-000", bytes: part0.length, sha256: sha(part0) },
          { name: "pack-au-ot.sqlite.part-001", bytes: part1.length, sha256: sha(part1) },
        ],
        companions: [
          { name: "manifest-au-ot.json", bytes: companion.length, sha256: sha(companion) },
        ],
      },
    ],
    shared: [{ name: "licences/test-licence.txt", bytes: licenceText.length, sha256: sha(licenceText) }],
  };
}

// 带 Range 支持的静态文件服务（模拟 GitHub Releases 的行为）。
let server: Server;
let baseUrl = "";
let releaseDir = "";
let lastRangeHeader: string | null = null;

beforeAll(async () => {
  releaseDir = mkdtempSync(path.join(tmpdir(), "bywave-release-"));
  writeFileSync(path.join(releaseDir, "pack-au-ot.sqlite.part-000"), part0);
  writeFileSync(path.join(releaseDir, "pack-au-ot.sqlite.part-001"), part1);
  writeFileSync(path.join(releaseDir, "pack-au-ot.sqlite"), packBuf);
  writeFileSync(path.join(releaseDir, "manifest-au-ot.json"), companion);
  mkdirSync(path.join(releaseDir, "licences"));
  writeFileSync(path.join(releaseDir, "licences", "test-licence.txt"), licenceText);
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const rel = decodeURIComponent(url.pathname.replace(/^\//, ""));
    const full = path.join(releaseDir, rel);
    if (!full.startsWith(releaseDir) || !existsSync(full)) {
      res.writeHead(404).end("nope");
      return;
    }
    const data = readFileSync(full);
    const range = req.headers.range;
    lastRangeHeader = range ?? null;
    const m = range ? /^bytes=(\d+)-$/.exec(range) : null;
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
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(releaseDir, { recursive: true, force: true });
});

const fetchImpl = (url: string, init: { headers?: Record<string, string> }) => fetch(url, init);

describe("parseGeoReleaseManifest", () => {
  it("合法清单（分卷 + 配套 + 共享）解析通过，摊平顺序是共享→配套→包本体", () => {
    const m = parseGeoReleaseManifest(manifestWithParts());
    expect(m.release).toBe("geo-packs-au-vTest");
    expect(m.packs[0]!.parts).toHaveLength(2);
    const plan = releaseFilePlan(m);
    expect(plan.map((p) => p.file)).toEqual([
      "licences/test-licence.txt",
      "manifest-au-ot.json",
      "pack-au-ot.sqlite",
    ]);
    expect(plan[2]!.parts).toHaveLength(2);
  });

  it("format 不是 1、pack_id 与文件名对不上 → 拒", () => {
    const bad1 = manifestWithParts() as Record<string, unknown>;
    bad1.format = 2;
    expect(() => parseGeoReleaseManifest(bad1)).toThrow(GeoReleaseError);
    const bad2 = manifestWithParts();
    (bad2.packs[0] as Record<string, unknown>).pack_id = "au-nsw";
    expect(() => parseGeoReleaseManifest(bad2)).toThrow(/pack_id/);
  });

  it("配套文件名带穿越、属于别的包 → 拒（下载路径同样过白名单）", () => {
    const bad1 = manifestWithParts();
    (bad1.packs[0]!.companions as Array<Record<string, unknown>>)[0]!.name = "../evil.txt";
    expect(() => parseGeoReleaseManifest(bad1)).toThrow(GeoReleaseError);
    const bad2 = manifestWithParts();
    (bad2.packs[0]!.companions as Array<Record<string, unknown>>)[0]!.name = "manifest-au-nsw.json";
    expect(() => parseGeoReleaseManifest(bad2)).toThrow(GeoReleaseError);
  });

  it("分卷：卷名不合序列、卷和与整文件对不上、单卷超 2 GiB → 拒", () => {
    const bad1 = manifestWithParts();
    (bad1.packs[0]!.parts as Array<Record<string, unknown>>)[1]!.name = "pack-au-ot.sqlite.part-777";
    expect(() => parseGeoReleaseManifest(bad1)).toThrow(GeoReleaseError);
    const bad2 = manifestWithParts();
    (bad2.packs[0]!.parts as Array<Record<string, unknown>>)[0]!.bytes = part0.length + 1;
    expect(() => parseGeoReleaseManifest(bad2)).toThrow(GeoReleaseError);
    const bad3 = manifestWithParts();
    (bad3.packs[0]!.parts as Array<Record<string, unknown>>)[0]!.bytes = MAX_RELEASE_PART_BYTES + 1;
    (bad3.packs[0] as Record<string, unknown>).bytes = MAX_RELEASE_PART_BYTES + 1 + part1.length;
    expect(() => parseGeoReleaseManifest(bad3)).toThrow(GeoReleaseError);
  });

  it("同名文件重复出现、共享区混入单包文件 → 拒", () => {
    const bad1 = manifestWithParts();
    bad1.shared.push({ name: "manifest-au-ot.json", bytes: 1, sha256: sha("x") });
    expect(() => parseGeoReleaseManifest(bad1)).toThrow(GeoReleaseError);
    const bad2 = manifestWithParts();
    bad2.shared = [{ name: "manifest-au-ot.json", bytes: companion.length, sha256: sha(companion) }];
    (bad2.packs[0] as Record<string, unknown>).companions = [];
    expect(() => parseGeoReleaseManifest(bad2)).toThrow(GeoReleaseError);
  });
});

describe("fetchGeoReleaseFile", () => {
  it("分卷逐卷验 SHA 后拼接落位，字节与原包逐字一致；重跑跳过", async () => {
    const packDir = mkdtempSync(path.join(tmpdir(), "bywave-packdir-"));
    try {
      const plan = releaseFilePlan(parseGeoReleaseManifest(manifestWithParts()));
      const packPlan = plan.find((p) => p.file === "pack-au-ot.sqlite")!;
      const res1 = await fetchGeoReleaseFile({ baseUrl, plan: packPlan, packDir, fetchImpl });
      expect(res1.status).toBe("done");
      expect(readFileSync(path.join(packDir, "pack-au-ot.sqlite"))).toEqual(packBuf);
      const res2 = await fetchGeoReleaseFile({ baseUrl, plan: packPlan, packDir, fetchImpl });
      expect(res2.status).toBe("skipped");
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  });

  it("单资产文件（配套）直接落位到子目录规则的位置", async () => {
    const packDir = mkdtempSync(path.join(tmpdir(), "bywave-packdir-"));
    try {
      const plan = releaseFilePlan(parseGeoReleaseManifest(manifestWithParts()));
      const licencePlan = plan.find((p) => p.file === "licences/test-licence.txt")!;
      const res = await fetchGeoReleaseFile({ baseUrl, plan: licencePlan, packDir, fetchImpl });
      expect(res.status).toBe("done");
      expect(readFileSync(path.join(packDir, "licences", "test-licence.txt"))).toEqual(licenceText);
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  });

  it("某一卷的 SHA 被篡改 → part_sha256_mismatch，包不落位", async () => {
    const packDir = mkdtempSync(path.join(tmpdir(), "bywave-packdir-"));
    try {
      const m = manifestWithParts();
      (m.packs[0]!.parts as Array<Record<string, unknown>>)[1]!.sha256 = sha("tampered");
      const plan = releaseFilePlan(parseGeoReleaseManifest(m)).find((p) => p.file === "pack-au-ot.sqlite")!;
      await expect(fetchGeoReleaseFile({ baseUrl, plan, packDir, fetchImpl })).rejects.toMatchObject({
        code: "part_sha256_mismatch",
      });
      expect(existsSync(path.join(packDir, "pack-au-ot.sqlite"))).toBe(false);
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  });

  it("整文件 SHA 与清单对不上（单资产）→ sha256_mismatch，包不落位", async () => {
    const packDir = mkdtempSync(path.join(tmpdir(), "bywave-packdir-"));
    try {
      const plan = { file: "pack-au-ot.sqlite", bytes: packBuf.length, sha256: sha("other-content"), parts: [] };
      await expect(fetchGeoReleaseFile({ baseUrl, plan, packDir, fetchImpl })).rejects.toMatchObject({
        code: "sha256_mismatch",
      });
      expect(existsSync(path.join(packDir, "pack-au-ot.sqlite"))).toBe(false);
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  });

  it("计划里的文件名不合白名单 → file_not_allowed（下载路径同样生效）", async () => {
    const packDir = mkdtempSync(path.join(tmpdir(), "bywave-packdir-"));
    try {
      const plan = { file: "../pack-au-ot.sqlite", bytes: 1, sha256: sha("x"), parts: [] };
      await expect(fetchGeoReleaseFile({ baseUrl, plan, packDir, fetchImpl })).rejects.toMatchObject({
        code: "file_not_allowed",
      });
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  });
});

describe("previewGeoPackRelease", () => {
  it("只拉清单：每包大小/行数/分卷数与清单一致，未装时总下载量 = 全部字节", async () => {
    writeFileSync(path.join(releaseDir, "geo-pack-release.json"), JSON.stringify(manifestWithParts()));
    const packDir = mkdtempSync(path.join(tmpdir(), "bywave-packdir-"));
    try {
      const pv = await previewGeoPackRelease({ baseUrl, packDir, fetchImpl });
      const total = packBuf.length + companion.length + licenceText.length;
      expect(pv.release).toBe("geo-packs-au-vTest");
      expect(pv.fileCount).toBe(3);
      expect(pv.pendingFileCount).toBe(3);
      expect(pv.totalBytes).toBe(total);
      expect(pv.totalDownloadBytes).toBe(total);
      expect(pv.packs).toHaveLength(1);
      const p = pv.packs[0]!;
      expect(p.file).toBe("pack-au-ot.sqlite");
      expect(p.bytes).toBe(packBuf.length);
      expect(p.rows).toBe(1);
      expect(p.region).toBe("Other Territories, Australia");
      expect(p.parts).toBe(2);
      expect(p.installed).toBe(false);
      // 包的待下载量含它自己的配套文件，不含共享文件。
      expect(p.downloadBytes).toBe(packBuf.length + companion.length);
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  });

  it("全部落位后：已安装判定与获取跳过同口径，总下载量归零", async () => {
    writeFileSync(path.join(releaseDir, "geo-pack-release.json"), JSON.stringify(manifestWithParts()));
    const packDir = mkdtempSync(path.join(tmpdir(), "bywave-packdir-"));
    try {
      const plan = releaseFilePlan(parseGeoReleaseManifest(manifestWithParts()));
      for (const item of plan) {
        await fetchGeoReleaseFile({ baseUrl, plan: item, packDir, fetchImpl });
      }
      const pv = await previewGeoPackRelease({ baseUrl, packDir, fetchImpl });
      expect(pv.packs[0]!.installed).toBe(true);
      expect(pv.packs[0]!.downloadBytes).toBe(0);
      expect(pv.pendingFileCount).toBe(0);
      expect(pv.totalDownloadBytes).toBe(0);
      expect(pv.totalBytes).toBe(packBuf.length + companion.length + licenceText.length);
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  });

  it("本地文件大小对但内容被换 → 不算已安装（SHA 同口径）", async () => {
    writeFileSync(path.join(releaseDir, "geo-pack-release.json"), JSON.stringify(manifestWithParts()));
    const packDir = mkdtempSync(path.join(tmpdir(), "bywave-packdir-"));
    try {
      writeFileSync(path.join(packDir, "pack-au-ot.sqlite"), Buffer.alloc(packBuf.length, 7));
      const pv = await previewGeoPackRelease({ baseUrl, packDir, fetchImpl });
      expect(pv.packs[0]!.installed).toBe(false);
      expect(pv.totalDownloadBytes).toBe(pv.totalBytes);
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  });

  it("清单非法 → release_manifest_invalid；源返回 404 → release_manifest_http_404", async () => {
    const packDir = mkdtempSync(path.join(tmpdir(), "bywave-packdir-"));
    try {
      const notJson = async () => new Response("<html>nope</html>", { status: 200 });
      await expect(previewGeoPackRelease({ baseUrl, packDir, fetchImpl: notJson })).rejects.toMatchObject({
        code: "release_manifest_invalid",
      });
      const wrongFormat = async () =>
        new Response(JSON.stringify({ format: 99, release: "x", packs: [] }), { status: 200 });
      await expect(previewGeoPackRelease({ baseUrl, packDir, fetchImpl: wrongFormat })).rejects.toMatchObject({
        code: "release_manifest_invalid",
      });
      const notFound = async () => new Response("nope", { status: 404 });
      await expect(previewGeoPackRelease({ baseUrl, packDir, fetchImpl: notFound })).rejects.toMatchObject({
        code: "release_manifest_http_404",
      });
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  });

  it("源不可达（fetch 直接抛错）→ release_unreachable，不漏裸网络错误", async () => {
    const packDir = mkdtempSync(path.join(tmpdir(), "bywave-packdir-"));
    try {
      const boom = async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:9");
      };
      await expect(previewGeoPackRelease({ baseUrl, packDir, fetchImpl: boom })).rejects.toMatchObject({
        code: "release_unreachable",
      });
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  });
});

describe("downloadGeoAsset", () => {
  it("已有半截文件时带 Range 续传并拼成完整内容", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bywave-dl-"));
    try {
      const dest = path.join(dir, "asset.bin");
      writeFileSync(dest, part0); // 预置前半截（= part-000 的全部）
      lastRangeHeader = null;
      await downloadGeoAsset({
        url: `${baseUrl}/pack-au-ot.sqlite`,
        dest,
        expectedBytes: packBuf.length,
        fetchImpl,
      });
      expect(lastRangeHeader).toBe(`bytes=${part0.length}-`);
      expect(readFileSync(dest)).toEqual(packBuf);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
