// 获取进度核算（GeoFetchProgressTracker）：逐文件高水位进度 +
// 滚动窗口测速。口径——进度是「朝最终文件已就位的绝对字节数」
// （续传接续、不重复计数、重写不倒退），速度只计新到字节（续传
// 偏移与已在盘上的字节不灌速度），停滞后速度随窗口滑动衰减到 0。
// tracker 的 now 全程注入假时钟，断言是确定性的；downloadGeoAsset
// 一段验证 onChunk/onProgress 的接线语义（新字节才计 chunk）。
process.env.PUBLIC_BASE_URL ||= "http://localhost:3000";
process.env.DATABASE_URL ||= "postgres://localhost:5432/bywave";
process.env.SESSION_SECRET ||= "test-session-secret-at-least-32-chars-long";

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const {
  GeoFetchProgressTracker,
  refreshGeoFetchProgress,
  downloadGeoAsset,
  GEO_FETCH_SPEED_WINDOW_MS,
} = await import("../src/lib/geo_release.js");
type JobState = import("../src/lib/geo_release.js").GeoPackFetchJobState;

const T0 = 1_700_000_000_000;

describe("GeoFetchProgressTracker 进度核算", () => {
  it("分块写入：逐文件位置累加，聚合总量跨文件求和", () => {
    const tr = new GeoFetchProgressTracker([
      { file: "a.sqlite", bytesTotal: 1000 },
      { file: "b.sqlite", bytesTotal: 2000 },
      { file: "c.txt", bytesTotal: 500 },
    ]);
    tr.notePosition("a.sqlite", 400);
    tr.notePosition("a.sqlite", 1000);
    tr.notePosition("b.sqlite", 250);
    const snap = tr.snapshot(T0);
    expect(snap.totalBytes).toBe(3500);
    expect(snap.downloadedBytes).toBe(1250);
    expect(tr.positionOf("c.txt")).toBe(0);
    // 超出文件总量的报告被钳到总量，未知文件忽略。
    tr.notePosition("b.sqlite", 999_999);
    tr.notePosition("nope.bin", 100);
    expect(tr.snapshot(T0).downloadedBytes).toBe(3000);
  });

  it("续传偏移不重复计数：种子 + 断点接着报，总量只到文件大小", () => {
    const tr = new GeoFetchProgressTracker([{ file: "a.sqlite", bytesTotal: 1000 }]);
    // 上一程已下 400（落盘种子），这一程从 400 续。
    tr.seed("a.sqlite", 400);
    tr.notePosition("a.sqlite", 400);
    tr.notePosition("a.sqlite", 700);
    tr.notePosition("a.sqlite", 1000);
    expect(tr.snapshot(T0).downloadedBytes).toBe(1000);
  });

  it("重试后总进度不倒退：服务端回 200 整文件重写，位置停在高水位", () => {
    const tr = new GeoFetchProgressTracker([{ file: "a.sqlite", bytesTotal: 1000 }]);
    tr.notePosition("a.sqlite", 600);
    // 重写尝试从 0 重新报位置——展示进度不许倒退。
    tr.notePosition("a.sqlite", 120);
    tr.notePosition("a.sqlite", 300);
    expect(tr.positionOf("a.sqlite")).toBe(600);
    expect(tr.snapshot(T0).downloadedBytes).toBe(600);
    // 真实位置追过高水位后继续前进。
    tr.notePosition("a.sqlite", 800);
    expect(tr.positionOf("a.sqlite")).toBe(800);
  });
});

describe("GeoFetchProgressTracker 测速与 ETA", () => {
  it("滚动窗口均速：窗口内新字节 / 跨度；ETA = 剩余 / 速度向上取整", () => {
    const tr = new GeoFetchProgressTracker([{ file: "a.sqlite", bytesTotal: 10_000 }]);
    tr.noteChunk(1000, T0);
    tr.noteChunk(1000, T0 + 1000);
    tr.noteChunk(1000, T0 + 2000);
    // 基线是第一个采样点（已含首块 1000），其后 2000 字节 / 2 s。
    expect(tr.speedBps(T0 + 2000)).toBe(1000);
    tr.notePosition("a.sqlite", 3000);
    const snap = tr.snapshot(T0 + 2000);
    expect(snap.speedBps).toBe(1000);
    expect(snap.etaSeconds).toBe(7); // (10000-3000)/1000
  });

  it("种子字节不计速度：只种位置不开下，速度恒为 0、ETA 为 null", () => {
    const tr = new GeoFetchProgressTracker([{ file: "a.sqlite", bytesTotal: 1000 }]);
    tr.seed("a.sqlite", 900);
    expect(tr.speedBps(T0 + 5000)).toBe(0);
    expect(tr.snapshot(T0 + 5000).etaSeconds).toBeNull();
  });

  it("停滞时速度衰减并最终归零：窗口滑过最后字节后 gained = 0", () => {
    const tr = new GeoFetchProgressTracker([{ file: "a.sqlite", bytesTotal: 10_000 }]);
    tr.noteChunk(500, T0);
    tr.noteChunk(500, T0 + 500);
    expect(tr.speedBps(T0 + 500)).toBe(1000); // 500 字节 / 0.5 s
    // 6 s 无新字节：窗口里还剩基线之后的增量，速度已明显衰减。
    const decayed = tr.speedBps(T0 + 6500);
    expect(decayed).toBeGreaterThan(0);
    expect(decayed).toBeLessThan(1000);
    // 超过整个窗口无新字节：归零，ETA 随之消失。
    expect(tr.speedBps(T0 + 500 + GEO_FETCH_SPEED_WINDOW_MS + 1)).toBe(0);
    expect(tr.snapshot(T0 + 500 + GEO_FETCH_SPEED_WINDOW_MS + 1).etaSeconds).toBeNull();
  });

  it("采样节流：200 ms 内的多块合并成一个采样点，字节不丢", () => {
    const tr = new GeoFetchProgressTracker([{ file: "a.sqlite", bytesTotal: 10_000 }]);
    tr.noteChunk(100, T0);
    tr.noteChunk(100, T0 + 50);
    tr.noteChunk(100, T0 + 100);
    tr.noteChunk(700, T0 + 1000);
    // 首采样 {T0,100}，其后增量 900 字节 / 1 s。
    expect(tr.speedBps(T0 + 1000)).toBe(900);
  });
});

describe("refreshGeoFetchProgress", () => {
  function fakeJob(status: JobState["status"]): JobState {
    return {
      id: "job-1",
      status,
      baseUrl: "http://stub",
      release: null,
      startedAt: new Date(T0).toISOString(),
      finishedAt: null,
      recovered: false,
      files: [
        { file: "a.sqlite", status: "done", bytesTotal: 1000, bytesDone: 1000, attempts: 1, error: null },
        { file: "b.sqlite", status: "retrying", bytesTotal: 2000, bytesDone: 0, attempts: 3, error: "stall_timeout" },
        { file: "c.sqlite", status: "pending", bytesTotal: 500, bytesDone: 0, attempts: 0, error: null },
      ],
      error: null,
      lastError: null,
      totalBytes: 0,
      downloadedBytes: 0,
      speedBps: 0,
      etaSeconds: null,
      currentFile: null,
    };
  }

  it("运行中：聚合字节入账，当前文件取第一个活跃状态的文件", () => {
    const job = fakeJob("running");
    const tr = new GeoFetchProgressTracker(job.files.map((f) => ({ file: f.file, bytesTotal: f.bytesTotal })));
    tr.notePosition("a.sqlite", 1000);
    tr.notePosition("b.sqlite", 500);
    tr.noteChunk(1000, T0);
    tr.noteChunk(1000, T0 + 1000);
    refreshGeoFetchProgress(job, tr, T0 + 1000);
    expect(job.totalBytes).toBe(3500);
    expect(job.downloadedBytes).toBe(1500);
    expect(job.currentFile).toBe("b.sqlite");
    expect(job.speedBps).toBeGreaterThan(0);
    expect(job.etaSeconds).not.toBeNull();
  });

  it("任务结束后：速度归零、ETA 与当前文件清空，字节数定格", () => {
    const job = fakeJob("done");
    const tr = new GeoFetchProgressTracker(job.files.map((f) => ({ file: f.file, bytesTotal: f.bytesTotal })));
    tr.notePosition("a.sqlite", 1000);
    tr.noteChunk(1000, T0);
    refreshGeoFetchProgress(job, tr, T0);
    expect(job.downloadedBytes).toBe(1000);
    expect(job.speedBps).toBe(0);
    expect(job.etaSeconds).toBeNull();
    expect(job.currentFile).toBeNull();
  });
});

// --- downloadGeoAsset 接线：onChunk 只计新到字节，onProgress 报绝对位置 ---
function chunkedResponse(chunks: Buffer[], opts: { status?: number; rangeStart?: number; total?: number } = {}): Response {
  const queue = [...chunks];
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next) controller.enqueue(new Uint8Array(next));
      else controller.close();
    },
  });
  const headers: Record<string, string> = {};
  if (opts.rangeStart !== undefined && opts.total !== undefined) {
    headers["content-range"] = `bytes ${opts.rangeStart}-${opts.total - 1}/${opts.total}`;
  }
  return new Response(stream, { status: opts.status ?? 200, headers });
}

describe("downloadGeoAsset 进度接线", () => {
  const data = Buffer.from(Array.from({ length: 6000 }, (_, i) => i % 251));

  it("全新下载：onChunk 之和 = 全长，onProgress 终值 = 全长", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bywave-prog-"));
    try {
      const dest = path.join(dir, "a.bin");
      let chunkSum = 0;
      let lastProgress = 0;
      await downloadGeoAsset({
        url: "http://stub/a.bin",
        dest,
        expectedBytes: data.length,
        fetchImpl: async () => chunkedResponse([data.subarray(0, 2000), data.subarray(2000, 4500), data.subarray(4500)]),
        onChunk: (n) => { chunkSum += n; },
        onProgress: (n) => { lastProgress = n; },
      });
      expect(readFileSync(dest)).toEqual(data);
      expect(chunkSum).toBe(data.length);
      expect(lastProgress).toBe(data.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("续传：onChunk 只计新下的后半，盘上已有字节不灌进速度", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bywave-prog-"));
    try {
      const dest = path.join(dir, "a.bin");
      writeFileSync(dest, data.subarray(0, 2500)); // 预置前 2500 字节
      let chunkSum = 0;
      let lastProgress = 0;
      await downloadGeoAsset({
        url: "http://stub/a.bin",
        dest,
        expectedBytes: data.length,
        fetchImpl: async (_url, init) => {
          const start = Number(/^bytes=(\d+)-$/.exec(init.headers?.range ?? "")![1]);
          expect(start).toBe(2500);
          return chunkedResponse([data.subarray(start, 4000), data.subarray(4000)], {
            status: 206, rangeStart: start, total: data.length,
          });
        },
        onChunk: (n) => { chunkSum += n; },
        onProgress: (n) => { lastProgress = n; },
      });
      expect(readFileSync(dest)).toEqual(data);
      expect(chunkSum).toBe(data.length - 2500);
      expect(lastProgress).toBe(data.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("文件已完整：onChunk 一次都不调（没有新字节），onProgress 直接报满", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bywave-prog-"));
    try {
      const dest = path.join(dir, "a.bin");
      writeFileSync(dest, data);
      let chunkCalls = 0;
      let lastProgress = 0;
      await downloadGeoAsset({
        url: "http://stub/a.bin",
        dest,
        expectedBytes: data.length,
        fetchImpl: async () => { throw new Error("must not fetch"); },
        onChunk: () => { chunkCalls += 1; },
        onProgress: (n) => { lastProgress = n; },
      });
      expect(chunkCalls).toBe(0);
      expect(lastProgress).toBe(data.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
