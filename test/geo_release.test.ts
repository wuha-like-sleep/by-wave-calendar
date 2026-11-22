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
  startGeoPackFetch,
  resumePersistedGeoPackFetch,
  getGeoPackFetchState,
  geoFetchRetryDelayMs,
  isTransientHttpStatus,
  GEO_FETCH_STAGING_SCOPE,
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

  it("没有 shared 字段（v2 发布：许可全文内嵌在包内，不再有独立许可资产）→ 解析通过", () => {
    const raw = manifestWithParts() as Record<string, unknown>;
    delete raw.shared;
    const m = parseGeoReleaseManifest(raw);
    expect(m.shared).toEqual([]);
    expect(releaseFilePlan(m).map((p) => p.file)).toEqual([
      "manifest-au-ot.json",
      "pack-au-ot.sqlite",
    ]);
  });

  it("shared 为空数组 → 解析通过", () => {
    const raw = manifestWithParts();
    raw.shared = [];
    expect(parseGeoReleaseManifest(raw).shared).toEqual([]);
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

describe("重试策略（纯函数）", () => {
  it("退避：5s 起指数翻倍、60s 封顶；可注入基数/上限", () => {
    expect(geoFetchRetryDelayMs(1)).toBe(5_000);
    expect(geoFetchRetryDelayMs(2)).toBe(10_000);
    expect(geoFetchRetryDelayMs(3)).toBe(20_000);
    expect(geoFetchRetryDelayMs(4)).toBe(40_000);
    expect(geoFetchRetryDelayMs(5)).toBe(60_000);
    expect(geoFetchRetryDelayMs(30)).toBe(60_000);
    expect(geoFetchRetryDelayMs(1, 100, 250)).toBe(100);
    expect(geoFetchRetryDelayMs(2, 100, 250)).toBe(200);
    expect(geoFetchRetryDelayMs(3, 100, 250)).toBe(250);
  });

  it("瞬时状态：408/429/5xx 算瞬时，其余 4xx 是硬失败", () => {
    for (const s of [408, 429, 500, 502, 503, 504]) expect(isTransientHttpStatus(s)).toBe(true);
    for (const s of [400, 401, 403, 404, 410, 416]) expect(isTransientHttpStatus(s)).toBe(false);
  });
});

describe("releaseFilePlan 顺序", () => {
  it("共享先行，其余包按体积从小到大；配套紧贴自己的包、在 sqlite 之前", () => {
    const big = Buffer.alloc(4096, 1);
    const small = Buffer.alloc(1024, 2);
    const compBig = Buffer.from("comp-big");
    const compSmall = Buffer.from("comp-small");
    const m = parseGeoReleaseManifest({
      format: 1,
      release: "r-order",
      packs: [
        {
          pack_id: "au-nsw", file: "pack-au-nsw.sqlite", bytes: big.length, sha256: sha(big),
          companions: [{ name: "manifest-au-nsw.json", bytes: compBig.length, sha256: sha(compBig) }],
        },
        {
          pack_id: "au-ot", file: "pack-au-ot.sqlite", bytes: small.length, sha256: sha(small),
          companions: [{ name: "manifest-au-ot.json", bytes: compSmall.length, sha256: sha(compSmall) }],
        },
      ],
      shared: [{ name: "ATTRIBUTION.txt", bytes: 3, sha256: sha("abc") }],
    });
    expect(releaseFilePlan(m).map((p) => p.file)).toEqual([
      "ATTRIBUTION.txt",
      "manifest-au-ot.json",
      "pack-au-ot.sqlite",
      "manifest-au-nsw.json",
      "pack-au-nsw.sqlite",
    ]);
  });
});

// 烂网络下载夹具：数据按尝试切段/掐断/停滞，验证续传语义。
const FLAKY_TUNING = { stallMs: 250, retryBaseMs: 5, retryMaxMs: 10 };

function chunkedResponse(chunks: Buffer[], opts: { status?: number; rangeStart?: number; total?: number; failAtEnd?: boolean } = {}): Response {
  const queue = [...chunks];
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next) {
        controller.enqueue(new Uint8Array(next));
        return;
      }
      if (opts.failAtEnd) {
        // 稍等再报错：让客户端有机会把已收到的块刷进暂存文件，
        // 模拟真实网络里「数据先到、RST 后到」的时序，避免测试抖动。
        setTimeout(() => {
          try { controller.error(new Error("connection reset by peer")); } catch { /* 已关 */ }
        }, 25);
      } else controller.close();
    },
  });
  const headers: Record<string, string> = {};
  if (opts.rangeStart !== undefined && opts.total !== undefined) {
    headers["content-range"] = `bytes ${opts.rangeStart}-${opts.total - 1}/${opts.total}`;
  }
  return new Response(stream, { status: opts.status ?? 200, headers });
}

describe("downloadGeoAsset 烂网络", () => {
  const data = Buffer.from(Array.from({ length: 6000 }, (_, i) => i % 251));

  it("每次尝试都在中途断连 → Range 续传跨尝试累积，最终完整", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bywave-dl-"));
    try {
      const dest = path.join(dir, "a.bin");
      const rangesSeen: Array<string | null> = [];
      let calls = 0;
      const impl = async (_url: string, init: { headers?: Record<string, string> }) => {
        calls += 1;
        const range = init.headers?.range ?? null;
        rangesSeen.push(range);
        const start = range ? Number(/^bytes=(\d+)-$/.exec(range)![1]) : 0;
        const slice = data.subarray(start, start + 2000);
        const isLast = start + slice.length >= data.length;
        return chunkedResponse([slice], {
          status: start > 0 ? 206 : 200,
          rangeStart: start > 0 ? start : undefined,
          total: data.length,
          failAtEnd: !isLast, // 没传完就掐断——模拟中间设备杀长连接
        });
      };
      const retries: string[] = [];
      await downloadGeoAsset({
        url: "http://stub/a.bin", dest, expectedBytes: data.length, fetchImpl: impl,
        tuning: FLAKY_TUNING, hooks: { onRetry: (_a, msg) => retries.push(msg) },
      });
      expect(readFileSync(dest)).toEqual(data);
      expect(calls).toBe(3);
      expect(rangesSeen).toEqual([null, "bytes=2000-", "bytes=4000-"]);
      expect(retries).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("先 500 一次再恢复 → 退避重试后成功，不判死", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bywave-dl-"));
    try {
      const dest = path.join(dir, "a.bin");
      let calls = 0;
      const impl = async () => {
        calls += 1;
        if (calls === 1) return new Response("boom", { status: 500 });
        return chunkedResponse([data]);
      };
      await downloadGeoAsset({
        url: "http://stub/a.bin", dest, expectedBytes: data.length, fetchImpl: impl, tuning: FLAKY_TUNING,
      });
      expect(calls).toBe(2);
      expect(readFileSync(dest)).toEqual(data);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("404 → 硬失败 download_http_404，只尝试一次", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bywave-dl-"));
    try {
      const dest = path.join(dir, "a.bin");
      let calls = 0;
      const impl = async () => {
        calls += 1;
        return new Response("nope", { status: 404 });
      };
      await expect(downloadGeoAsset({
        url: "http://stub/a.bin", dest, expectedBytes: data.length, fetchImpl: impl, tuning: FLAKY_TUNING,
      })).rejects.toMatchObject({ code: "download_http_404" });
      expect(calls).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("连接建起后永不给数据 → 停滞超时中止、续传重试后成功", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bywave-dl-"));
    try {
      const dest = path.join(dir, "a.bin");
      let calls = 0;
      const retryMessages: string[] = [];
      const impl = async (_url: string, init: { signal?: AbortSignal }) => {
        calls += 1;
        if (calls === 1) {
          // 永不 enqueue、永不 close；只听 abort（与真实 undici 行为一致）。
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              init.signal?.addEventListener("abort", () => {
                try { controller.error(new Error("AbortError")); } catch { /* 已关 */ }
              });
            },
          });
          return new Response(stream, { status: 200 });
        }
        return chunkedResponse([data]);
      };
      await downloadGeoAsset({
        url: "http://stub/a.bin", dest, expectedBytes: data.length, fetchImpl: impl,
        tuning: FLAKY_TUNING, hooks: { onRetry: (_a, msg) => retryMessages.push(msg) },
      });
      expect(calls).toBe(2);
      expect(retryMessages).toEqual(["stall_timeout"]);
      expect(readFileSync(dest)).toEqual(data);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("服务端给多了 → 体积溢出是硬失败，不无限重试", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bywave-dl-"));
    try {
      const dest = path.join(dir, "a.bin");
      let calls = 0;
      const impl = async () => {
        calls += 1;
        return chunkedResponse([Buffer.alloc(100, 9)]);
      };
      await expect(downloadGeoAsset({
        url: "http://stub/a.bin", dest, expectedBytes: 10, fetchImpl: impl, tuning: FLAKY_TUNING,
      })).rejects.toMatchObject({ code: "download_size_overflow" });
      expect(calls).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("跨轮 / 跨重启续传", () => {
  function manifestSingleAsset() {
    const m = manifestWithParts();
    delete (m.packs[0] as Record<string, unknown>).parts;
    return m;
  }

  async function waitForJob(pred: (s: NonNullable<ReturnType<typeof getGeoPackFetchState>>) => boolean, timeoutMs = 30_000) {
    const t0 = Date.now();
    for (;;) {
      const s = getGeoPackFetchState();
      if (s && pred(s)) return s;
      if (Date.now() - t0 > timeoutMs) throw new Error("fetch job did not finish in time");
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it("上一轮死在半路的暂存文件，下一轮同名接着续（固定 scope）", async () => {
    const packDir = mkdtempSync(path.join(tmpdir(), "bywave-packdir-"));
    try {
      const stagingDir = path.join(packDir, ".incoming");
      mkdirSync(stagingDir, { recursive: true });
      const tag = sha("pack-au-ot.sqlite").slice(0, 16);
      writeFileSync(path.join(stagingDir, `fetch-${GEO_FETCH_STAGING_SCOPE}-${tag}.part`), part0);
      lastRangeHeader = null;
      const plan = { file: "pack-au-ot.sqlite", bytes: packBuf.length, sha256: packSha, parts: [] };
      const res = await fetchGeoReleaseFile({ baseUrl, plan, packDir, fetchImpl, scope: GEO_FETCH_STAGING_SCOPE });
      expect(res.status).toBe("done");
      expect(lastRangeHeader).toBe(`bytes=${part0.length}-`);
      expect(readFileSync(path.join(packDir, "pack-au-ot.sqlite"))).toEqual(packBuf);
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  });

  it("任务级：包文件先 500 两次——不判死，attempts 记到 3，最终完成且状态文件清掉", async () => {
    writeFileSync(path.join(releaseDir, "geo-pack-release.json"), JSON.stringify(manifestSingleAsset()));
    const packDir = mkdtempSync(path.join(tmpdir(), "bywave-packdir-"));
    try {
      let packCalls = 0;
      const flaky = async (url: string, init: { headers?: Record<string, string>; signal?: AbortSignal }) => {
        if (url.endsWith("/pack-au-ot.sqlite")) {
          packCalls += 1;
          if (packCalls <= 2) return new Response("boom", { status: 500 });
        }
        return fetch(url, init);
      };
      const { started } = startGeoPackFetch({
        actorUserId: null, packDir, baseUrl, fetchImpl: flaky, tuning: FLAKY_TUNING,
      });
      expect(started).toBe(true);
      const job = await waitForJob((s) => s.finishedAt !== null);
      expect(job.status).toBe("done");
      const packState = job.files.find((f) => f.file === "pack-au-ot.sqlite")!;
      expect(packState.status).toBe("done");
      expect(packState.attempts).toBe(3);
      expect(readFileSync(path.join(packDir, "pack-au-ot.sqlite"))).toEqual(packBuf);
      expect(existsSync(path.join(packDir, ".incoming", "fetch-job-state.json"))).toBe(false);
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  });

  it("重启恢复：落盘状态 + 半截暂存 → 自动恢复续传，recovered=true，包落位", async () => {
    writeFileSync(path.join(releaseDir, "geo-pack-release.json"), JSON.stringify(manifestSingleAsset()));
    const packDir = mkdtempSync(path.join(tmpdir(), "bywave-packdir-"));
    try {
      const stagingDir = path.join(packDir, ".incoming");
      mkdirSync(stagingDir, { recursive: true });
      const tag = sha("pack-au-ot.sqlite").slice(0, 16);
      writeFileSync(path.join(stagingDir, `fetch-${GEO_FETCH_STAGING_SCOPE}-${tag}.part`), part0);
      writeFileSync(path.join(stagingDir, "fetch-job-state.json"), JSON.stringify({
        version: 1,
        actorUserId: null,
        job: {
          id: "00000000-0000-4000-8000-000000000001",
          status: "running",
          baseUrl,
          release: "geo-packs-au-vTest",
          startedAt: new Date().toISOString(),
          finishedAt: null,
          recovered: false,
          files: [],
          error: null,
          lastError: null,
        },
      }));
      lastRangeHeader = null;
      const resumed = await resumePersistedGeoPackFetch({ packDir, fetchImpl, tuning: FLAKY_TUNING });
      expect(resumed).toBe(true);
      const job = await waitForJob((s) => s.recovered && s.finishedAt !== null);
      expect(job.status).toBe("done");
      // 半截暂存被 Range 续上（包是计划里最后一个文件，range 记录停在它身上）。
      expect(lastRangeHeader).toBe(`bytes=${part0.length}-`);
      expect(readFileSync(path.join(packDir, "pack-au-ot.sqlite"))).toEqual(packBuf);
      expect(existsSync(path.join(stagingDir, "fetch-job-state.json"))).toBe(false);
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  });

  it("没有落盘状态 / 状态已损坏 → 不恢复", async () => {
    const packDir = mkdtempSync(path.join(tmpdir(), "bywave-packdir-"));
    try {
      expect(await resumePersistedGeoPackFetch({ packDir, fetchImpl })).toBe(false);
      const stagingDir = path.join(packDir, ".incoming");
      mkdirSync(stagingDir, { recursive: true });
      writeFileSync(path.join(stagingDir, "fetch-job-state.json"), "{ not json");
      expect(await resumePersistedGeoPackFetch({ packDir, fetchImpl })).toBe(false);
      expect(existsSync(path.join(stagingDir, "fetch-job-state.json"))).toBe(false);
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  });
});
