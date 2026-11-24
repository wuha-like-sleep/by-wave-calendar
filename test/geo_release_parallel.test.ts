// 地址包并行分段下载：与单流的基准对比（每连接限速的假源）、段级
// 断点续传（已完成段零请求）、服务端不认 Range 时回退单流、旧单
// 流半截文件的段状态映射，以及任务级落盘状态（新格式带段记录 /
// 旧格式不带）恢复。全程注入假 fetch，不连外网。
process.env.PUBLIC_BASE_URL ||= "http://localhost:3000";
process.env.DATABASE_URL ||= "postgres://localhost:5432/bywave";
process.env.SESSION_SECRET ||= "test-session-secret-at-least-32-chars-long";

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { open as fsOpen } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const {
  downloadGeoAsset,
  downloadGeoAssetParallel,
  geoFetchSegmentPlan,
  resolveGeoFetchParallelism,
  startGeoPackFetch,
  resumePersistedGeoPackFetch,
  getGeoPackFetchState,
  GeoReleaseError,
} = await import("../src/lib/geo_release.js");
const { geoSyncStagingDir, sha256Hex } = await import("../src/lib/geo_sync.js");

const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const tmpDirs: string[] = [];
function tmpDest(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "bywave-parallel-"));
  tmpDirs.push(dir);
  return path.join(dir, name);
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** 确定性伪随机内容（按 1 MiB 块生成后重复拼接，大文件也造得快）。 */
function makeData(bytes: number): Buffer {
  const block = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < block.length; i++) block[i] = (i * 31 + 7) % 251;
  const parts: Buffer[] = [];
  let left = bytes;
  while (left > 0) {
    parts.push(block.subarray(0, Math.min(block.length, left)));
    left -= block.length;
  }
  return Buffer.concat(parts);
}

/** 按 Range 头切数据的响应（支持 bytes=a-b 与 bytes=a- 两种）。 */
function rangeResponse(data: Buffer, rangeHeader: string | null): Response {
  if (rangeHeader) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
    if (m) {
      const start = Number(m[1]);
      if (start >= data.length) return new Response(null, { status: 416 });
      const end = m[2] === "" ? data.length - 1 : Math.min(Number(m[2]), data.length - 1);
      return new Response(new Uint8Array(data.subarray(start, end + 1)), {
        status: 206,
        headers: { "content-range": `bytes ${start}-${end}/${data.length}` },
      });
    }
  }
  return new Response(new Uint8Array(data), { status: 200 });
}

/** 每连接限速的数据流：pull 型，块大小固定，按速率算每块延迟。 */
function throttledStream(data: Buffer, bytesPerSecond: number, onDone: () => void): ReadableStream<Uint8Array> {
  const CHUNK = 512 * 1024;
  let offset = 0;
  let finished = false;
  const finish = () => {
    if (!finished) {
      finished = true;
      onDone();
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset >= data.length) {
        controller.close();
        finish();
        return;
      }
      const n = Math.min(CHUNK, data.length - offset);
      await sleep((n / bytesPerSecond) * 1000);
      controller.enqueue(new Uint8Array(data.subarray(offset, offset + n)));
      offset += n;
    },
    cancel() {
      finish();
    },
  });
}

describe("geoFetchSegmentPlan / resolveGeoFetchParallelism", () => {
  it("不足 2 段的小文件不并行；并发为 1 不并行；并发钳制 1..16", () => {
    const t = { segmentBytes: 4 * 1024 * 1024, parallelism: 4 };
    expect(geoFetchSegmentPlan(4 * 1024 * 1024, t).parallel).toBe(false);
    expect(geoFetchSegmentPlan(8 * 1024 * 1024, t).parallel).toBe(true);
    expect(geoFetchSegmentPlan(64 * 1024 * 1024, { segmentBytes: 4 * 1024 * 1024, parallelism: 1 }).parallel).toBe(false);
    expect(resolveGeoFetchParallelism({ parallelism: 99 })).toBe(16);
    expect(resolveGeoFetchParallelism({ parallelism: 0 })).toBe(1);
    expect(resolveGeoFetchParallelism({ parallelism: 3 })).toBe(3);
  });
});

describe("并行分段基准（每连接限速 12 MiB/s，128 MiB 文件）", () => {
  it("单流 vs 并发 4：并行明显更快，且并发数不超上限、内容一致", async () => {
    const data = makeData(128 * 1024 * 1024);
    const dataSha = sha(data);
    const RATE = 12 * 1024 * 1024;
    let active = 0;
    let maxActive = 0;
    const fetchImpl = async (url: string, init: { headers?: Record<string, string> }) => {
      void url;
      active += 1;
      maxActive = Math.max(maxActive, active);
      const range = init.headers?.range ?? null;
      let body: Buffer;
      let status = 200;
      const headers: Record<string, string> = {};
      const m = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
      if (m) {
        const start = Number(m[1]);
        const end = m[2] === "" ? data.length - 1 : Math.min(Number(m[2]), data.length - 1);
        body = data.subarray(start, end + 1);
        status = 206;
        headers["content-range"] = `bytes ${start}-${end}/${data.length}`;
      } else {
        body = data;
      }
      return new Response(throttledStream(body, RATE, () => { active -= 1; }), { status, headers });
    };

    const singleDest = tmpDest("single.bin");
    const t0 = Date.now();
    await downloadGeoAsset({
      url: "http://stub/big.bin", dest: singleDest, expectedBytes: data.length, fetchImpl,
    });
    const singleMs = Date.now() - t0;
    expect(sha(readFileSync(singleDest))).toBe(dataSha);

    maxActive = 0;
    const parallelDest = tmpDest("parallel.bin");
    const t1 = Date.now();
    await downloadGeoAssetParallel({
      url: "http://stub/big.bin", dest: parallelDest, expectedBytes: data.length, fetchImpl,
      segmentBytes: 8 * 1024 * 1024, concurrency: 4,
    });
    const parallelMs = Date.now() - t1;
    expect(sha(readFileSync(parallelDest))).toBe(dataSha);
    // 4 条连接各 12 MiB/s：理论约 4 倍，断言留足余量取 2 倍。
    expect(parallelMs * 2).toBeLessThan(singleMs);
    expect(maxActive).toBeLessThanOrEqual(4);
    expect(maxActive).toBeGreaterThanOrEqual(3);
  }, 180_000);
});

describe("并行分段断点续传", () => {
  it("中途被杀：恢复时已完成段零请求，只补未完成段，最终内容一致", async () => {
    const SEG = 4 * 1024 * 1024;
    const data = makeData(8 * SEG);
    const dataSha = sha(data);
    const dest = tmpDest("resume.bin");

    // 第一程：只放行前 3 个段请求，其余一律硬失败（模拟进程被杀
    // 后任务判死的盘面：段状态停在半路）。
    let allowed = 3;
    let lastState: { segmentBytes: number; done: number[] } | null = null;
    const killer = async (url: string, init: { headers?: Record<string, string> }) => {
      void url;
      if (allowed <= 0) throw new GeoReleaseError("download_http_404", "killed");
      allowed -= 1;
      return rangeResponse(data, init.headers?.range ?? null);
    };
    await expect(
      downloadGeoAssetParallel({
        url: "http://stub/f.bin", dest, expectedBytes: data.length, fetchImpl: killer,
        segmentBytes: SEG, concurrency: 2,
        tuning: { retryBaseMs: 1, retryMaxMs: 2 },
        onSegmentState: (s) => { if (s) lastState = s; },
      }),
    ).rejects.toBeInstanceOf(GeoReleaseError);
    expect(lastState).not.toBeNull();
    const doneSegs = lastState!.done;
    expect(doneSegs.length).toBeGreaterThanOrEqual(2);
    expect(doneSegs.length).toBeLessThan(8);

    // 第二程：带着段状态恢复，记录全部 Range 请求。
    const requested: { start: number; end: number }[] = [];
    const healthy = async (url: string, init: { headers?: Record<string, string> }) => {
      void url;
      const range = init.headers?.range ?? null;
      const m = range ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
      if (m) requested.push({ start: Number(m[1]), end: Number(m[2]) });
      return rangeResponse(data, range);
    };
    await downloadGeoAssetParallel({
      url: "http://stub/f.bin", dest, expectedBytes: data.length, fetchImpl: healthy,
      segmentBytes: SEG, concurrency: 3,
      initialState: lastState,
      tuning: { retryBaseMs: 1, retryMaxMs: 2 },
    });
    expect(sha(readFileSync(dest))).toBe(dataSha);
    // 已完成段零请求：没有任何请求的字节区间落进完成段的范围。
    for (const r of requested) {
      for (const seg of doneSegs) {
        const segStart = seg * SEG;
        const segEnd = segStart + SEG - 1;
        expect(r.end < segStart || r.start > segEnd).toBe(true);
      }
    }
    // 请求数恰好等于剩余段数。
    expect(requested.length).toBe(8 - doneSegs.length);
  });

  it("旧单流半截文件：整段覆盖的前缀映射成完成段，半截段整段重下", async () => {
    const SEG = 4 * 1024 * 1024;
    const data = makeData(6 * SEG);
    const dest = tmpDest("legacy.bin");
    // 单流时代的半截：顺序前缀 10 MiB = 段 0、1 整段 + 段 2 半截。
    writeFileSync(dest, data.subarray(0, 10 * 1024 * 1024));
    const starts: number[] = [];
    const fetchImpl = async (url: string, init: { headers?: Record<string, string> }) => {
      void url;
      const range = init.headers?.range ?? null;
      const m = range ? /^bytes=(\d+)-/.exec(range) : null;
      if (m) starts.push(Number(m[1]));
      return rangeResponse(data, range);
    };
    await downloadGeoAssetParallel({
      url: "http://stub/f.bin", dest, expectedBytes: data.length, fetchImpl,
      segmentBytes: SEG, concurrency: 3,
      tuning: { retryBaseMs: 1, retryMaxMs: 2 },
    });
    expect(sha(readFileSync(dest))).toBe(sha(data));
    // 段 0、1 零请求；段 2 从段起点整段重下。
    expect(starts.every((s) => s >= 2 * SEG)).toBe(true);
    expect(starts).toContain(2 * SEG);
  });

  it("服务端不认 Range（恒回 200）→ 回退单流完成，段状态被摘除", async () => {
    const data = makeData(4 * 1024 * 1024);
    const dest = tmpDest("fallback.bin");
    const states: ({ segmentBytes: number; done: number[] } | null)[] = [];
    let sawRangeRequest = false;
    const fetchImpl = async (url: string, init: { headers?: Record<string, string> }) => {
      void url;
      if (init.headers?.range) sawRangeRequest = true;
      return new Response(new Uint8Array(data), { status: 200 });
    };
    await downloadGeoAssetParallel({
      url: "http://stub/f.bin", dest, expectedBytes: data.length, fetchImpl,
      segmentBytes: 1024 * 1024, concurrency: 3,
      tuning: { retryBaseMs: 1, retryMaxMs: 2 },
      onSegmentState: (s) => states.push(s),
    });
    expect(sha(readFileSync(dest))).toBe(sha(data));
    expect(sawRangeRequest).toBe(true);
    expect(states).toContain(null);
  });

  it("段状态丢失但标记在场：稀疏半成品一概不信，全部段重下", async () => {
    const SEG = 2 * 1024 * 1024;
    const data = makeData(4 * SEG);
    const dest = tmpDest("marker.bin");
    // 模拟分段半成品：只有段 2 的字节定位写在正确偏移上（文件被
    // 撑到全长，其余是空洞），且没有段状态传进来——只有标记。
    const handle = await fsOpen(dest, "w");
    await handle.write(data.subarray(2 * SEG, 3 * SEG), 0, SEG, 2 * SEG);
    await handle.write(data.subarray(3 * SEG), 0, SEG, 3 * SEG);
    await handle.close();
    writeFileSync(`${dest}.segments.json`, JSON.stringify({ segmentBytes: SEG }));
    const starts: number[] = [];
    const fetchImpl = async (url: string, init: { headers?: Record<string, string> }) => {
      void url;
      const range = init.headers?.range ?? null;
      const m = range ? /^bytes=(\d+)-/.exec(range) : null;
      if (m) starts.push(Number(m[1]));
      return rangeResponse(data, range);
    };
    await downloadGeoAssetParallel({
      url: "http://stub/f.bin", dest, expectedBytes: data.length, fetchImpl,
      segmentBytes: SEG, concurrency: 2,
      tuning: { retryBaseMs: 1, retryMaxMs: 2 },
    });
    expect(sha(readFileSync(dest))).toBe(sha(data));
    // 段 2 明明已在盘上，也照样重下（无状态背书就不信）。
    expect(starts).toContain(2 * SEG);
    expect(starts.length).toBe(4);
  });

  it("某段先 500 再恢复 → 只重试该段，退避后成功", async () => {
    const SEG = 2 * 1024 * 1024;
    const data = makeData(4 * SEG);
    const dest = tmpDest("segretry.bin");
    let failedOnce = false;
    const retries: string[] = [];
    const fetchImpl = async (url: string, init: { headers?: Record<string, string> }) => {
      void url;
      const range = init.headers?.range ?? null;
      // 第二段（起点 = SEG）的第一次请求回 500。
      if (!failedOnce && range === `bytes=${SEG}-${2 * SEG - 1}`) {
        failedOnce = true;
        return new Response("boom", { status: 500 });
      }
      return rangeResponse(data, range);
    };
    await downloadGeoAssetParallel({
      url: "http://stub/f.bin", dest, expectedBytes: data.length, fetchImpl,
      segmentBytes: SEG, concurrency: 2,
      tuning: { retryBaseMs: 1, retryMaxMs: 2 },
      hooks: { onRetry: (_a, msg) => retries.push(msg) },
    });
    expect(sha(readFileSync(dest))).toBe(sha(data));
    expect(retries).toContain("http_500");
  });
});

// ---------------------------------------------------------------------------
// 任务级：落盘状态恢复（新格式带段记录 / 旧格式不带）
// ---------------------------------------------------------------------------

function buildPaddedPack(file: string, targetBytes: number): Buffer {
  const dir = mkdtempSync(path.join(tmpdir(), "bywave-bigpack-"));
  const full = path.join(dir, file);
  const db = new DatabaseSync(full);
  db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)");
  db.exec(`CREATE TABLE addresses(
    cid INTEGER PRIMARY KEY, display TEXT, unit TEXT, number TEXT,
    street_name TEXT, street_type TEXT, suburb TEXT, state TEXT, postcode TEXT,
    poi_name TEXT, category TEXT, weight REAL, lat REAL, lon REAL, sources TEXT)`);
  db.exec('CREATE VIRTUAL TABLE addr_fts USING fts5(search_text, tokenize="unicode61 remove_diacritics 2")');
  db.exec('CREATE VIRTUAL TABLE addr_tri USING fts5(search_text, tokenize="trigram")');
  const insMeta = db.prepare("INSERT INTO meta VALUES (?,?)");
  insMeta.run("pack_id", "au-ot");
  insMeta.run("country", "AU");
  insMeta.run("region", "Other Territories, Australia");
  insMeta.run("schema", "1");
  insMeta.run("built_unix", "1795183104");
  db.exec("CREATE TABLE filler(x BLOB)");
  db.prepare("INSERT INTO filler VALUES (zeroblob(?))").run(targetBytes);
  db.close();
  const buf = readFileSync(full);
  rmSync(dir, { recursive: true, force: true });
  return buf;
}

const JOB_TUNING = { stallMs: 5000, retryBaseMs: 1, retryMaxMs: 2, segmentBytes: 2 * 1024 * 1024, parallelism: 3 };
const JOB_SEG = 2 * 1024 * 1024;

function jobManifest(packBuf: Buffer) {
  return {
    format: 1,
    release: "geo-packs-au-vTest",
    generated_at: "2026-11-21T00:00:00Z",
    packs: [
      {
        pack_id: "au-ot",
        file: "pack-au-ot.sqlite",
        bytes: packBuf.length,
        sha256: sha(packBuf),
        rows_total: 1,
        region: "Other Territories, Australia",
        pack_version: "test",
      },
    ],
    shared: [],
  };
}

function makeJobFetch(packBuf: Buffer, manifest: unknown, record?: { starts: number[] }) {
  return async (url: string, init: { headers?: Record<string, string> }) => {
    if (url.endsWith("geo-pack-release.json")) {
      return new Response(JSON.stringify(manifest), { status: 200 });
    }
    if (url.endsWith("pack-au-ot.sqlite")) {
      const range = init.headers?.range ?? null;
      const m = range ? /^bytes=(\d+)-/.exec(range) : null;
      if (m && record) record.starts.push(Number(m[1]));
      return rangeResponse(packBuf, range);
    }
    return new Response("nope", { status: 404 });
  };
}

async function waitForJob(timeoutMs = 30_000): Promise<{ status: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = getGeoPackFetchState();
    if (state && state.status !== "running") return state;
    if (Date.now() > deadline) throw new Error("job did not finish in time");
    await sleep(25);
  }
}

function seedInterruptedJob(
  packDir: string,
  packBuf: Buffer,
  stagingBytes: (staging: string) => Promise<void>,
  fileStateExtra: Record<string, unknown>,
): Promise<void> {
  return (async () => {
    const stagingDir = geoSyncStagingDir(packDir);
    const staging = path.join(stagingDir, `fetch-release-${sha256Hex("pack-au-ot.sqlite").slice(0, 16)}.part`);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(stagingDir, { recursive: true });
    await stagingBytes(staging);
    const job = {
      id: "00000000-0000-4000-8000-000000000001",
      status: "running",
      baseUrl: "http://stub",
      release: "geo-packs-au-vTest",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      recovered: false,
      files: [
        {
          file: "pack-au-ot.sqlite",
          status: "downloading",
          bytesTotal: packBuf.length,
          bytesDone: 0,
          attempts: 1,
          error: null,
          ...fileStateExtra,
        },
      ],
      error: null,
      lastError: null,
      totalBytes: packBuf.length,
      downloadedBytes: 0,
      speedBps: 0,
      etaSeconds: null,
      currentFile: "pack-au-ot.sqlite",
    };
    writeFileSync(
      path.join(stagingDir, "fetch-job-state.json"),
      JSON.stringify({ version: 1, job, actorUserId: null }),
    );
  })();
}

describe("任务级恢复 × 并行分段", () => {
  it("新格式：段记录在落盘状态里 → 已完成段零请求，恢复完成并落位", async () => {
    const packBuf = buildPaddedPack("pack-au-ot.sqlite", 18 * 1024 * 1024);
    const packDir = mkdtempSync(path.join(tmpdir(), "bywave-jobpack-"));
    tmpDirs.push(packDir);
    // 暂存里已有段 0、1 的字节（定位写在正确偏移上，其余缺失）。
    await seedInterruptedJob(packDir, packBuf, async (staging) => {
      const handle = await fsOpen(staging, "w");
      await handle.write(packBuf.subarray(0, JOB_SEG), 0, JOB_SEG, 0);
      await handle.write(packBuf.subarray(JOB_SEG, 2 * JOB_SEG), 0, JOB_SEG, JOB_SEG);
      await handle.close();
    }, {
      bytesDone: 2 * JOB_SEG,
      segments: { "pack-au-ot.sqlite": { segmentBytes: JOB_SEG, done: [0, 1] } },
    });
    const record = { starts: [] as number[] };
    const resumed = await resumePersistedGeoPackFetch({
      packDir, fetchImpl: makeJobFetch(packBuf, jobManifest(packBuf), record), tuning: JOB_TUNING,
    });
    expect(resumed).toBe(true);
    const state = await waitForJob();
    expect(state.status).toBe("done");
    expect(existsSync(path.join(packDir, "pack-au-ot.sqlite"))).toBe(true);
    expect(sha(readFileSync(path.join(packDir, "pack-au-ot.sqlite")))).toBe(sha(packBuf));
    // 段 0、1 零请求：所有包文件请求起点 ≥ 2 段。
    expect(record.starts.length).toBeGreaterThan(0);
    expect(record.starts.every((s) => s >= 2 * JOB_SEG)).toBe(true);
  });

  it("旧格式：落盘状态没有段记录 → 单流前缀映射，整段覆盖的段零请求", async () => {
    const packBuf = buildPaddedPack("pack-au-ot.sqlite", 18 * 1024 * 1024);
    const packDir = mkdtempSync(path.join(tmpdir(), "bywave-jobpack-"));
    tmpDirs.push(packDir);
    // 单流时代半截：顺序前缀 5 MiB（段 0、1 整段 + 段 2 半截）。
    await seedInterruptedJob(packDir, packBuf, async (staging) => {
      writeFileSync(staging, packBuf.subarray(0, 5 * 1024 * 1024));
    }, { bytesDone: 5 * 1024 * 1024 });
    const record = { starts: [] as number[] };
    const resumed = await resumePersistedGeoPackFetch({
      packDir, fetchImpl: makeJobFetch(packBuf, jobManifest(packBuf), record), tuning: JOB_TUNING,
    });
    expect(resumed).toBe(true);
    const state = await waitForJob();
    expect(state.status).toBe("done");
    expect(sha(readFileSync(path.join(packDir, "pack-au-ot.sqlite")))).toBe(sha(packBuf));
    expect(record.starts.every((s) => s >= 2 * JOB_SEG)).toBe(true);
    expect(record.starts).toContain(2 * JOB_SEG);
  });

  it("全新任务（startGeoPackFetch）大包走并行分段并落位", async () => {
    const packBuf = buildPaddedPack("pack-au-ot.sqlite", 18 * 1024 * 1024);
    const packDir = mkdtempSync(path.join(tmpdir(), "bywave-jobpack-"));
    tmpDirs.push(packDir);
    const record = { starts: [] as number[] };
    const { started } = startGeoPackFetch({
      actorUserId: null, packDir, baseUrl: "http://stub",
      fetchImpl: makeJobFetch(packBuf, jobManifest(packBuf), record), tuning: JOB_TUNING,
    });
    expect(started).toBe(true);
    const state = await waitForJob();
    expect(state.status).toBe("done");
    expect(sha(readFileSync(path.join(packDir, "pack-au-ot.sqlite")))).toBe(sha(packBuf));
    // 并行分段的请求形态：多个不同段起点、且都是带终点的 Range。
    expect(new Set(record.starts).size).toBeGreaterThan(1);
  });
});
