// 官方地址包发布格式（geo-pack-release.json）+ 后台「获取官方包」。
//
// 背景：地址包原本只存在于作者的 DGX 上，别的自托管者没有任何官方
// 途径拿到包。这套发布格式把包变成任何静态托管（GitHub Releases /
// 任意镜像站）都能分发的资产集合：
//
//   <base>/geo-pack-release.json   发布清单（本文件解析与校验）
//   <base>/<资产文件>               清单里列出的每个文件
//
// 发布清单是外部输入，按不可信处理，纪律与同步通道 ingest 同档：
//   - 每个最终文件名必须过 classifyGeoSyncFile 白名单（与 ingest /
//     后台下载同一套规则），落盘路径由服务端拼并断言包含关系；
//   - 分卷只是传输手段：卷名必须是 <文件>.part-NNN 的严格序列，单卷
//     ≤ 2 GiB（GitHub Release 单资产上限），卷字节数之和必须等于整
//     文件字节数；每卷单独验 SHA-256 后才按序拼接，拼完再验整文件
//     SHA-256；
//   - 激活不另起炉灶：拼好的暂存文件走 geo_sync 的 activateStaged
//     GeoFile（大小 / 整体 SHA / sqlite 内容自检 / 原子 rename），
//     与同步通道同一条落位路径；
//   - 已在本地且大小 + SHA 都对得上的文件直接跳过，重复点获取是
//     幂等的；下载支持 HTTP Range 续传，大文件全程流式落盘，不进
//     内存。
//
// 下载的健壮性（2026-11-21 生产实测教训：境外发布源到国内服务器的
// 长连接会被中间设备周期性掐断，几十 MiB 一断、偶尔连接直接建不
// 起来，原先「4 次尝试、亚秒退避、失败即判死」在这种网络下永远下
// 不完一个大包）：
//   - 没有总时长超时：只有「停滞超时」——连续 ~60 s 收不到任何字
//     节才中止本次尝试，每收到一块数据就重置计时；下得慢没关系，
//     断了才重来；
//   - 瞬时错误（超时 / 连接重置 / 5xx / 429 / 短读）无限续传重试，
//     指数退避 5 s 起、60 s 封顶，暂存进度跨尝试累积，直到文件完
//     整为止；只有硬失败才判死：4xx（404 等）、完整下载后 SHA 对
//     不上、体积溢出；
//   - 下载顺序：共享文件先行，然后按包体积从小到大——小包先进服
//     务，大包在烂网络上慢慢磨也不挡别人的路；
//   - 暂存文件名与任务无关（固定 scope），换一轮任务、乃至进程重
//     启，半截文件都还在原地接着续。
//
// 任务状态以内存注册表为实时视图，同时把计划与逐文件进度落盘到
// 暂存区（fetch-job-state.json，临时文件 + rename 原子写）：进程
// 重启后开机自检会自动恢复未完成的任务，后台页能看到「已恢复」
// 的任务在继续跑；恢复任务读清单遇瞬时错误会退避重试（开机头几
// 秒网络常未就绪，一次失败不许把无人值守的恢复任务判死），新点
// 的任务则立即判死让失败立即可见。任务完成或硬失败后状态文件清
// 除。开始由后台路由记审计，完成 / 失败在这里直插审计台账（无
// 请求上下文，沿用系统动作 ip="-" 的既有做法）。
//
// 进度展示（后台页的进度条 / 速度 / ETA）由 GeoFetchProgress
// Tracker 核算：逐文件字节按高水位入账（续传接续、重写不倒
// 退），速度只计新到字节的滚动窗口均值；内存状态是轮询的权威来
// 源，进度落盘节流（≥2 s 或 ≥8 MiB 一次），只为跨重启恢复显示。

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, truncate, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { safeFetch } from "./ssrf_guard.js";
import {
  activateStagedGeoFile,
  classifyGeoSyncFile,
  geoSyncStagingDir,
  resolveGeoPackDir,
  sha256Hex,
} from "./geo_sync.js";

export const GEO_RELEASE_MANIFEST_NAME = "geo-pack-release.json";
/** GitHub Release 单个资产的上限是 2 GiB；分卷一律不得超过它。 */
export const MAX_RELEASE_PART_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_RELEASE_PACKS = 64;
const MAX_RELEASE_PARTS = 1000;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
/** 停滞超时：连续这么久收不到任何字节，才认为连接已死、中止重续。
 *  它是「无进展」超时，不是总时长超时——再慢的连接只要还在滴数据
 *  就不会被掐。 */
export const GEO_FETCH_STALL_MS = 60_000;
/** 瞬时失败后的退避：第一次重试等这么久，之后指数翻倍到上限。 */
export const GEO_FETCH_RETRY_BASE_MS = 5_000;
export const GEO_FETCH_RETRY_MAX_MS = 60_000;

/** 纯函数：第 attempt 次尝试失败后、下一次尝试前等多久（指数退避
 *  + 上限）。attempt 从 1 计（第一次失败 → 等 base）。 */
export function geoFetchRetryDelayMs(
  attempt: number,
  baseMs: number = GEO_FETCH_RETRY_BASE_MS,
  maxMs: number = GEO_FETCH_RETRY_MAX_MS,
): number {
  const a = Math.max(1, Math.floor(attempt));
  return Math.min(maxMs, baseMs * 2 ** (a - 1));
}

/** 纯函数：这个 HTTP 状态是瞬时错误（值得退避后用 Range 续传重试）
 *  还是硬失败。408/429/5xx 瞬时；其余非成功状态（404 等 4xx）硬失败。 */
export function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** 下载调参（生产用默认值；测试注入小数值以便快速跑完）。 */
export interface GeoDownloadTuning {
  stallMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export class GeoReleaseError extends Error {
  constructor(
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export function resolveGeoPackReleaseBaseUrl(): string {
  return env.GEO_PACK_RELEASE_BASE_URL.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// 发布清单（format 1）
// ---------------------------------------------------------------------------

export interface GeoReleaseAsset {
  name: string;
  bytes: number;
  sha256: string;
}

export interface GeoReleasePackEntry {
  packId: string;
  file: string;
  bytes: number;
  sha256: string;
  rows: number | null;
  region: string | null;
  packVersion: string | null;
  /** 分卷列表（按序）；空 = 单资产，资产名就是 file 本身。 */
  parts: GeoReleaseAsset[];
  companions: GeoReleaseAsset[];
}

export interface GeoReleaseManifest {
  release: string;
  generatedAt: string | null;
  packs: GeoReleasePackEntry[];
  shared: GeoReleaseAsset[];
}

/** 下载单元：一个最终文件 + 它的来源（单资产或分卷序列）。 */
export interface GeoReleaseFilePlan {
  file: string;
  bytes: number;
  sha256: string;
  parts: GeoReleaseAsset[];
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function reqSha(v: unknown, what: string): string {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(s)) throw new GeoReleaseError("release_manifest_invalid", `${what}: sha256 must be 64 hex chars`);
  return s;
}

function reqBytes(v: unknown, max: number, what: string): number {
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > max) {
    throw new GeoReleaseError("release_manifest_invalid", `${what}: bytes out of range`);
  }
  return v as number;
}

function optText(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length <= max ? v : null;
}

/** 校验一个资产条目：名字必须过白名单，大小不得超过该类上限。 */
function assetOf(raw: unknown, what: string): { asset: GeoReleaseAsset; packId: string | null; kind: string } {
  const rec = asRecord(raw);
  if (!rec) throw new GeoReleaseError("release_manifest_invalid", `${what}: not an object`);
  const name = typeof rec.name === "string" ? rec.name : "";
  const cls = classifyGeoSyncFile(name);
  if (!cls) throw new GeoReleaseError("release_manifest_invalid", `${what}: file name not allowed: ${name}`);
  return {
    asset: { name, bytes: reqBytes(rec.bytes, cls.maxBytes, what), sha256: reqSha(rec.sha256, what) },
    packId: cls.packId,
    kind: cls.kind,
  };
}

export function parseGeoReleaseManifest(input: unknown): GeoReleaseManifest {
  const rec = asRecord(input);
  if (!rec) throw new GeoReleaseError("release_manifest_invalid", "manifest is not an object");
  if (rec.format !== 1) throw new GeoReleaseError("release_manifest_invalid", "format must be 1");
  const release = optText(rec.release, 120);
  if (!release) throw new GeoReleaseError("release_manifest_invalid", "release name missing");
  if (!Array.isArray(rec.packs) || rec.packs.length < 1 || rec.packs.length > MAX_RELEASE_PACKS) {
    throw new GeoReleaseError("release_manifest_invalid", "packs must be 1..64 entries");
  }

  const seenFiles = new Set<string>();
  const seenAssets = new Set<string>();
  const claimFile = (name: string) => {
    if (seenFiles.has(name)) throw new GeoReleaseError("release_manifest_invalid", `duplicate file: ${name}`);
    seenFiles.add(name);
  };
  const claimAsset = (name: string) => {
    if (seenAssets.has(name)) throw new GeoReleaseError("release_manifest_invalid", `duplicate asset: ${name}`);
    seenAssets.add(name);
  };

  const packs: GeoReleasePackEntry[] = rec.packs.map((rawPack, pi) => {
    const what = `packs[${pi}]`;
    const p = asRecord(rawPack);
    if (!p) throw new GeoReleaseError("release_manifest_invalid", `${what}: not an object`);
    const file = typeof p.file === "string" ? p.file : "";
    const cls = classifyGeoSyncFile(file);
    if (!cls || cls.kind !== "pack" || !cls.packId) {
      throw new GeoReleaseError("release_manifest_invalid", `${what}: file is not a pack file: ${file}`);
    }
    if (p.pack_id !== cls.packId) {
      throw new GeoReleaseError("release_manifest_invalid", `${what}: pack_id does not match file name`);
    }
    const bytes = reqBytes(p.bytes, cls.maxBytes, what);
    const sha256 = reqSha(p.sha256, what);
    claimFile(file);

    let parts: GeoReleaseAsset[] = [];
    if (p.parts !== undefined && p.parts !== null) {
      if (!Array.isArray(p.parts)) throw new GeoReleaseError("release_manifest_invalid", `${what}.parts: not an array`);
      if (p.parts.length > MAX_RELEASE_PARTS) {
        throw new GeoReleaseError("release_manifest_invalid", `${what}.parts: too many parts`);
      }
      parts = p.parts.map((rawPart, i) => {
        const partWhat = `${what}.parts[${i}]`;
        const rp = asRecord(rawPart);
        if (!rp) throw new GeoReleaseError("release_manifest_invalid", `${partWhat}: not an object`);
        const expectedName = `${file}.part-${String(i).padStart(3, "0")}`;
        if (rp.name !== expectedName) {
          throw new GeoReleaseError("release_manifest_invalid", `${partWhat}: name must be ${expectedName}`);
        }
        const asset: GeoReleaseAsset = {
          name: expectedName,
          bytes: reqBytes(rp.bytes, MAX_RELEASE_PART_BYTES, partWhat),
          sha256: reqSha(rp.sha256, partWhat),
        };
        claimAsset(asset.name);
        return asset;
      });
      const sum = parts.reduce((a, x) => a + x.bytes, 0);
      if (parts.length > 0 && sum !== bytes) {
        throw new GeoReleaseError("release_manifest_invalid", `${what}: part bytes do not add up to file bytes`);
      }
      if (parts.length === 0) parts = [];
    }
    if (parts.length === 0) claimAsset(file);

    let companions: GeoReleaseAsset[] = [];
    if (p.companions !== undefined && p.companions !== null) {
      if (!Array.isArray(p.companions)) {
        throw new GeoReleaseError("release_manifest_invalid", `${what}.companions: not an array`);
      }
      companions = p.companions.map((rawC, ci) => {
        const { asset, packId } = assetOf(rawC, `${what}.companions[${ci}]`);
        if (packId !== cls.packId) {
          throw new GeoReleaseError("release_manifest_invalid", `${what}.companions[${ci}]: belongs to another pack`);
        }
        claimFile(asset.name);
        claimAsset(asset.name);
        return asset;
      });
    }

    return {
      packId: cls.packId,
      file,
      bytes,
      sha256,
      rows: Number.isInteger(p.rows_total) && (p.rows_total as number) >= 0 ? (p.rows_total as number) : null,
      region: optText(p.region, 200),
      packVersion: optText(p.pack_version, 100),
      parts,
      companions,
    };
  });

  let shared: GeoReleaseAsset[] = [];
  if (rec.shared !== undefined && rec.shared !== null) {
    if (!Array.isArray(rec.shared)) throw new GeoReleaseError("release_manifest_invalid", "shared: not an array");
    shared = rec.shared.map((rawS, si) => {
      const { asset, packId } = assetOf(rawS, `shared[${si}]`);
      if (packId !== null) {
        throw new GeoReleaseError("release_manifest_invalid", `shared[${si}]: per-pack file listed as shared`);
      }
      claimFile(asset.name);
      claimAsset(asset.name);
      return asset;
    });
  }

  return { release, generatedAt: optText(rec.generated_at, 64), packs, shared };
}

/** 把清单摊平成下载顺序：共享文件先行；然后按包体积从小到大排
 *  （同体积保持清单原序）；每个包先配套、sqlite 最后（与同步发送
 *  端的纪律一致——sqlite 落位即激活，激活时配套必须已经就位）。
 *  小包先行是烂网络下的价值排序：几十 MiB 的小包几分钟就能激活
 *  上线，GiB 级大包排在后面慢慢磨，不挡别人的路。 */
export function releaseFilePlan(manifest: GeoReleaseManifest): GeoReleaseFilePlan[] {
  const plan: GeoReleaseFilePlan[] = [];
  for (const s of manifest.shared) plan.push({ file: s.name, bytes: s.bytes, sha256: s.sha256, parts: [] });
  const packsBySize = [...manifest.packs].sort((a, b) => a.bytes - b.bytes);
  for (const pack of packsBySize) {
    for (const c of pack.companions) plan.push({ file: c.name, bytes: c.bytes, sha256: c.sha256, parts: [] });
    plan.push({ file: pack.file, bytes: pack.bytes, sha256: pack.sha256, parts: pack.parts });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// 下载（流式落盘 + Range 续传 + 重试）
// ---------------------------------------------------------------------------

export type GeoFetchImpl = (
  url: string,
  init: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

const defaultFetchImpl: GeoFetchImpl = (url, init) =>
  safeFetch(url, {
    headers: init.headers,
    signal: init.signal,
    allowPrivate: env.GEO_PACK_RELEASE_ALLOW_PRIVATE_NETWORK,
  });

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function sha256File(full: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(full)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function fileSize(full: string): Promise<number> {
  const st = await stat(full).catch(() => null);
  return st?.isFile() ? st.size : 0;
}

/** 下载过程回调（任务层据此更新逐文件状态与落盘进度）。 */
export interface GeoDownloadHooks {
  /** 每次尝试开始时调（attempt 从 1 计）。 */
  onAttempt?: (attempt: number) => void;
  /** 一次尝试瞬时失败、决定退避续传后调（在等待之前）。 */
  onRetry?: (attempt: number, error: string) => void;
}

/** 把一个资产下载到 dest，直到完整或硬失败：
 *  - 已有部分文件时用 Range 续传；服务端不认 Range（回 200）就整
 *    文件重下；206 的 content-range 起点必须与本地长度严丝合缝，
 *    对不上就截断重来（绝不把错位字节拼进文件）；
 *  - 没有总时长超时：只有停滞超时——连续 stallMs 收不到任何字节
 *    才中止本次尝试，每收到一块数据重置计时。慢连接只要在滴数据
 *    就能一直下；被中间设备掐断的连接最多浪费 stallMs；
 *  - 瞬时失败（停滞 / 连接重置 / 408 / 429 / 5xx / 短读）无限退避
 *    重试（geoFetchRetryDelayMs），暂存字节跨尝试累积，文件终将
 *    下完；硬失败立即抛 GeoReleaseError：其余 4xx
 *    （download_http_<status>）、体积溢出（download_size_overflow）；
 *  - 长度必须精确等于 expectedBytes，多一个字节都判溢出。 */
export async function downloadGeoAsset(args: {
  url: string;
  dest: string;
  expectedBytes: number;
  fetchImpl?: GeoFetchImpl;
  onProgress?: (bytesDone: number) => void;
  /** 每收到一块网络数据调一次（只报块长）：测速专用——续传的起
   *  始偏移与「已在盘上」的字节不经这里，不会被算成下载速度。 */
  onChunk?: (chunkBytes: number) => void;
  hooks?: GeoDownloadHooks;
  tuning?: GeoDownloadTuning;
}): Promise<void> {
  const fetchImpl = args.fetchImpl ?? defaultFetchImpl;
  const stallMs = args.tuning?.stallMs ?? GEO_FETCH_STALL_MS;
  const retryBaseMs = args.tuning?.retryBaseMs ?? GEO_FETCH_RETRY_BASE_MS;
  const retryMaxMs = args.tuning?.retryMaxMs ?? GEO_FETCH_RETRY_MAX_MS;

  for (let attempt = 1; ; attempt++) {
    args.hooks?.onAttempt?.(attempt);
    // 停滞看门狗：arm 一次后，每收到一块数据重新 arm；触发即 abort
    // 本次尝试（请求头阶段同样受管——连接半天不给响应头也是停滞）。
    const controller = new AbortController();
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    let stalled = false;
    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        controller.abort();
      }, stallMs);
    };
    try {
      let existing = await fileSize(args.dest);
      if (existing === args.expectedBytes) {
        args.onProgress?.(args.expectedBytes);
        return;
      }
      if (existing > args.expectedBytes) {
        await truncate(args.dest, 0);
        existing = 0;
      }
      const headers: Record<string, string> = {};
      if (existing > 0) headers["range"] = `bytes=${existing}-`;
      armStall();
      const resp = await fetchImpl(args.url, { headers, signal: controller.signal });
      if (resp.status === 416) {
        // 本地长度已等于期望时上面就返回了；走到这里说明服务端眼里
        // 的文件比本地暂存还短——暂存不可信，截断后从头续。
        await truncate(args.dest, 0);
        throw new Error("range_not_satisfiable");
      }
      let base = 0;
      let flags: "w" | "a" = "w";
      if (resp.status === 206) {
        const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec((resp.headers.get("content-range") ?? "").trim());
        if (!m || Number(m[1]) !== existing) {
          await truncate(args.dest, 0);
          throw new Error("bad_content_range");
        }
        base = existing;
        flags = "a";
      } else if (resp.status === 200) {
        base = 0;
        flags = "w";
      } else if (isTransientHttpStatus(resp.status)) {
        throw new Error(`http_${resp.status}`);
      } else {
        throw new GeoReleaseError(`download_http_${resp.status}`, `download failed: HTTP ${resp.status} for ${args.url}`);
      }
      if (!resp.body) throw new Error("empty_body");
      let written = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          armStall();
          written += chunk.length;
          if (base + written > args.expectedBytes) {
            cb(new GeoReleaseError("download_size_overflow", `download exceeds expected size for ${args.url}`));
            return;
          }
          args.onChunk?.(chunk.length);
          args.onProgress?.(base + written);
          cb(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(resp.body as Parameters<typeof Readable.fromWeb>[0]),
        counter,
        createWriteStream(args.dest, { flags }),
      );
      if (base + written !== args.expectedBytes) throw new Error("short_read");
      args.onProgress?.(args.expectedBytes);
      return;
    } catch (err) {
      if (err instanceof GeoReleaseError) throw err;
      const message = stalled
        ? "stall_timeout"
        : err instanceof Error
          ? err.message
          : String(err);
      args.hooks?.onRetry?.(attempt, message);
      await sleep(geoFetchRetryDelayMs(attempt, retryBaseMs, retryMaxMs));
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
    }
  }
}

function assetUrl(baseUrl: string, name: string): string {
  return `${baseUrl}/${name.split("/").map(encodeURIComponent).join("/")}`;
}

function finalPathIn(packDir: string, fileName: string): string {
  const full = path.join(packDir, fileName);
  if (!path.resolve(full).startsWith(path.resolve(packDir) + path.sep)) {
    throw new GeoReleaseError("file_not_allowed", `final path escapes pack dir: ${fileName}`);
  }
  return full;
}

/** 获取任务专属的暂存命名空间：固定值，不随任务变——换一轮任务
 *  乃至进程重启后，上一轮下了一半的暂存文件还在同一个名字下，新
 *  一轮直接 Range 续上（这正是跨轮续传成立的前提）。同步通道的暂
 *  存是另一套命名（会话 id），互不相撞。 */
export const GEO_FETCH_STAGING_SCOPE = "release";

/** 获取一个文件：跳过已就位的 → 下载（分卷逐卷验 SHA 后拼接）→
 *  走 activateStagedGeoFile 原子落位。scope 用来隔离暂存文件名
 *  （同一包目录可能同时有同步通道的暂存，命名空间互不相撞）。 */
export async function fetchGeoReleaseFile(args: {
  baseUrl: string;
  plan: GeoReleaseFilePlan;
  packDir?: string;
  fetchImpl?: GeoFetchImpl;
  scope?: string;
  onProgress?: (bytesDone: number) => void;
  /** 透传给 downloadGeoAsset 的测速回调（分卷时每卷共用一个：
   *  块长就是网络新字节，与卷在整文件里的偏移无关）。 */
  onChunk?: (chunkBytes: number) => void;
  hooks?: GeoDownloadHooks;
  tuning?: GeoDownloadTuning;
}): Promise<{ status: "done" | "skipped"; bytes: number }> {
  const packDir = args.packDir ?? resolveGeoPackDir();
  const plan = args.plan;
  if (!classifyGeoSyncFile(plan.file)) {
    throw new GeoReleaseError("file_not_allowed", `file name not allowed: ${plan.file}`);
  }
  const finalPath = finalPathIn(packDir, plan.file);
  if ((await fileSize(finalPath)) === plan.bytes && (await sha256File(finalPath)) === plan.sha256) {
    args.onProgress?.(plan.bytes);
    return { status: "skipped", bytes: plan.bytes };
  }

  const stagingDir = geoSyncStagingDir(packDir);
  await mkdir(stagingDir, { recursive: true });
  const scope = (args.scope ?? "manual").replace(/[^a-zA-Z0-9-]/g, "");
  const tag = sha256Hex(plan.file).slice(0, 16);
  const staging = path.join(stagingDir, `fetch-${scope}-${tag}.part`);
  const fetchImpl = args.fetchImpl ?? defaultFetchImpl;

  if (plan.parts.length === 0) {
    await downloadGeoAsset({
      url: assetUrl(args.baseUrl, plan.file),
      dest: staging,
      expectedBytes: plan.bytes,
      fetchImpl,
      onProgress: args.onProgress,
      onChunk: args.onChunk,
      hooks: args.hooks,
      tuning: args.tuning,
    });
  } else {
    // 已拼好的前缀必须正好落在卷边界上，否则截断到上一个卷边界。
    let assembled = await fileSize(staging);
    let boundary = 0;
    for (const part of plan.parts) {
      if (boundary + part.bytes <= assembled) boundary += part.bytes;
      else break;
    }
    if (assembled !== boundary) {
      await truncate(staging, boundary);
      assembled = boundary;
    }
    let doneBytes = assembled;
    for (let i = 0; i < plan.parts.length; i++) {
      const part = plan.parts[i]!;
      const partStart = plan.parts.slice(0, i).reduce((a, x) => a + x.bytes, 0);
      if (partStart + part.bytes <= assembled) continue;
      const partTemp = path.join(stagingDir, `fetch-${scope}-${tag}-p${String(i).padStart(3, "0")}.part`);
      await downloadGeoAsset({
        url: assetUrl(args.baseUrl, part.name),
        dest: partTemp,
        expectedBytes: part.bytes,
        fetchImpl,
        onProgress: (n) => args.onProgress?.(partStart + n),
        onChunk: args.onChunk,
        hooks: args.hooks,
        tuning: args.tuning,
      });
      if ((await sha256File(partTemp)) !== part.sha256) {
        await unlink(partTemp).catch(() => {});
        throw new GeoReleaseError("part_sha256_mismatch", `part ${part.name} sha256 mismatch`);
      }
      // 把这一卷追加到拼装文件尾部（流式拷贝，不进内存）。
      await pipeline(createReadStream(partTemp), createWriteStream(staging, { flags: "a" }));
      await unlink(partTemp).catch(() => {});
      doneBytes = partStart + part.bytes;
      args.onProgress?.(doneBytes);
    }
    if ((await fileSize(staging)) !== plan.bytes) {
      throw new GeoReleaseError("staging_size_mismatch", `assembled size mismatch for ${plan.file}`);
    }
  }

  const outcome = await activateStagedGeoFile({
    stagingFile: staging,
    fileName: plan.file,
    bytes: plan.bytes,
    sha256: plan.sha256,
    packDir,
  });
  if (!outcome.ok) {
    if (outcome.error === "sha256_mismatch" || outcome.error === "staging_size_mismatch") {
      await unlink(staging).catch(() => {});
    }
    throw new GeoReleaseError(outcome.error ?? "activate_failed", `activate ${plan.file} failed: ${outcome.error}`);
  }
  return { status: "done", bytes: plan.bytes };
}

// ---------------------------------------------------------------------------
// 发布预检（只拉清单，不下载任何包文件）
// ---------------------------------------------------------------------------
// 管理员点「获取」之前先看清：这个发布里有哪些包、每个多大、多少
// 行、本地是否已经装了同版本、这一趟总共还要下多少字节。清单本身
// 是小文件，走与正式获取完全相同的拉取与严格解析；「已安装」判定
// 也与获取时的跳过判定同口径（大小 + 整文件 SHA-256 都对得上）。
// 预检失败不抛裸网络错误：源不可达统一归 release_unreachable，
// HTTP 与清单非法保留各自的错误码，页面据此给明确文案。

export interface GeoReleasePreviewPack {
  packId: string;
  file: string;
  region: string | null;
  rows: number | null;
  /** 包本体（sqlite）的精确字节数。 */
  bytes: number;
  /** 分卷数；0 = 单资产发布。 */
  parts: number;
  /** 包本体已在本地且大小 + SHA 都对得上。 */
  installed: boolean;
  /** 这个包（含其配套文件）还需下载的字节数。 */
  downloadBytes: number;
}

export interface GeoReleasePreview {
  release: string;
  generatedAt: string | null;
  baseUrl: string;
  packs: GeoReleasePreviewPack[];
  /** 发布计划里的文件总数（共享 + 配套 + 包本体）。 */
  fileCount: number;
  /** 其中尚未安装、这次要下载的文件数。 */
  pendingFileCount: number;
  /** 全部文件的字节数合计。 */
  totalBytes: number;
  /** 未安装部分的字节数合计——点「获取」真正要传的量。 */
  totalDownloadBytes: number;
}

async function geoFileInstalled(full: string, bytes: number, sha256: string): Promise<boolean> {
  return (await fileSize(full)) === bytes && (await sha256File(full)) === sha256;
}

export async function previewGeoPackRelease(args: {
  baseUrl?: string;
  packDir?: string;
  fetchImpl?: GeoFetchImpl;
} = {}): Promise<GeoReleasePreview> {
  const baseUrl = (args.baseUrl ?? resolveGeoPackReleaseBaseUrl()).replace(/\/+$/, "");
  const packDir = args.packDir ?? resolveGeoPackDir();
  const fetchImpl = args.fetchImpl ?? defaultFetchImpl;
  let manifest: GeoReleaseManifest;
  try {
    manifest = await readManifest(baseUrl, fetchImpl);
  } catch (err) {
    if (err instanceof GeoReleaseError) throw err;
    throw new GeoReleaseError(
      "release_unreachable",
      `release source unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const plan = releaseFilePlan(manifest);
  const installedByFile = new Map<string, boolean>();
  let totalBytes = 0;
  let totalDownloadBytes = 0;
  let pendingFileCount = 0;
  for (const item of plan) {
    totalBytes += item.bytes;
    const installed = await geoFileInstalled(finalPathIn(packDir, item.file), item.bytes, item.sha256);
    installedByFile.set(item.file, installed);
    if (!installed) {
      totalDownloadBytes += item.bytes;
      pendingFileCount += 1;
    }
  }
  const packs: GeoReleasePreviewPack[] = manifest.packs.map((p) => {
    let downloadBytes = 0;
    for (const c of p.companions) if (!installedByFile.get(c.name)) downloadBytes += c.bytes;
    if (!installedByFile.get(p.file)) downloadBytes += p.bytes;
    return {
      packId: p.packId,
      file: p.file,
      region: p.region,
      rows: p.rows,
      bytes: p.bytes,
      parts: p.parts.length,
      installed: installedByFile.get(p.file) ?? false,
      downloadBytes,
    };
  });
  return {
    release: manifest.release,
    generatedAt: manifest.generatedAt,
    baseUrl,
    packs,
    fileCount: plan.length,
    pendingFileCount,
    totalBytes,
    totalDownloadBytes,
  };
}

// ---------------------------------------------------------------------------
// 发布索引（只拉清单，给后台列表页标「有新版」用）
// ---------------------------------------------------------------------------
// 与预检的区别：预检要算「这次还要下多少」，得对本地大文件做整文件
// SHA-256；列表页每次打开都跑一遍那个太重。这里只拉发布清单本身，
// 本地版本取包目录 manifest 里记录的 sha256 比对（包落位时已经全量
// 验过，manifest 就是它的出生证明），页面打开不读包本体。任何失败
// （源不可达 / 超时 / 清单非法）都返回 null：页面退化成只展示本地
// 状态，绝不因为查更新把后台页拖挂。

export interface GeoReleaseIndexPack {
  packId: string;
  file: string;
  bytes: number;
  sha256: string;
  rows: number | null;
  region: string | null;
  packVersion: string | null;
  /** 分卷数；0 = 单资产发布。 */
  parts: number;
}

export interface GeoReleaseIndex {
  release: string;
  generatedAt: string | null;
  packs: GeoReleaseIndexPack[];
}

export async function fetchGeoReleaseIndex(args: {
  baseUrl?: string;
  fetchImpl?: GeoFetchImpl;
  timeoutMs?: number;
} = {}): Promise<GeoReleaseIndex | null> {
  const baseUrl = (args.baseUrl ?? resolveGeoPackReleaseBaseUrl()).replace(/\/+$/, "");
  const base = args.fetchImpl ?? defaultFetchImpl;
  const timeoutMs = args.timeoutMs ?? 4000;
  const impl: GeoFetchImpl = (url, init) =>
    base(url, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
  try {
    const manifest = await readManifest(baseUrl, impl);
    return {
      release: manifest.release,
      generatedAt: manifest.generatedAt,
      packs: manifest.packs.map((p) => ({
        packId: p.packId,
        file: p.file,
        bytes: p.bytes,
        sha256: p.sha256,
        rows: p.rows,
        region: p.region,
        packVersion: p.packVersion,
        parts: p.parts.length,
      })),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 获取任务（内存注册表为实时视图 + 暂存区落盘状态，重启可恢复）
// ---------------------------------------------------------------------------

export type GeoFetchFileStatus =
  | "pending"
  | "downloading"
  | "retrying"
  | "verifying"
  | "activating"
  | "done"
  | "skipped"
  | "failed";

export interface GeoPackFetchFileState {
  file: string;
  status: GeoFetchFileStatus;
  bytesTotal: number;
  bytesDone: number;
  /** 已尝试次数（含正在进行的这次）；瞬时失败会一直涨，直到下完。 */
  attempts: number;
  error: string | null;
}

export interface GeoPackFetchJobState {
  id: string;
  status: "running" | "done" | "failed";
  baseUrl: string;
  release: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** 本任务是进程重启后从落盘状态自动恢复的（不是管理员刚点的）。 */
  recovered: boolean;
  files: GeoPackFetchFileState[];
  error: string | null;
  /** 最近一次瞬时失败的说明（任务级汇总，给后台页一眼看到在卡什么）。 */
  lastError: string | null;
  /** 任务级聚合进度（字节口径，由 GeoFetchProgressTracker 核算；
   *  读取状态时按当前时刻刷新——速度随停滞自然衰减，不冻结）。 */
  totalBytes: number;
  downloadedBytes: number;
  /** 滚动窗口平均下载速度（字节/秒）；停滞或任务已结束为 0。 */
  speedBps: number;
  /** 按当前速度估算的剩余秒数；速度为 0 或已下完时为 null。 */
  etaSeconds: number | null;
  /** 正在处理的文件（下载 / 重试 / 校验 / 激活中），没有为 null。 */
  currentFile: string | null;
}

// ---------------------------------------------------------------------------
// 获取进度核算（逐文件高水位 + 滚动窗口测速）
// ---------------------------------------------------------------------------
// 进度口径：每个文件的进度 = 朝最终文件已就位的字节数，也就是
// downloadGeoAsset 的 onProgress 报的绝对位置（续传从断点接着报，
// 天然不重复计数）。唯一会让绝对位置倒退的情形是服务端不认
// Range、回 200 整文件重写——tracker 按文件记高水位，进度只进不
// 退：重写期间进度停在高水位，直到真实位置追过它。
//
// 速度口径：只计「新到字节」——每块网络数据经 onChunk 进 tracker，
// 在滚动窗口（默认 10 s）内按采样点算平均速率。续传的起始偏移、
// 跳过文件报满的整文件字节都不经 onChunk，不会灌进速度。停滞 /
// 退避等待期间没有新字节进窗口，速度随窗口滑动自然衰减到 0，不
// 会冻结在一个旧值上误导人。now 全程可注入，纯逻辑可测。

/** 测速滚动窗口：最近这么久的平均速度。 */
export const GEO_FETCH_SPEED_WINDOW_MS = 10_000;
/** 采样点最小间隔：块到达频率可以很高，采样点没必要比这更密。 */
const GEO_FETCH_SPEED_SAMPLE_MS = 200;
/** 进度落盘节流：距上次落盘至少这么久，或又下了这么多字节，才
 *  再写一次 fetch-job-state.json（进度写盘只为跨重启恢复显示，
 *  不能让每块数据都触发一次整文件写）。 */
export const GEO_FETCH_PERSIST_MIN_MS = 2_000;
export const GEO_FETCH_PERSIST_MIN_BYTES = 8 * 1024 * 1024;

export class GeoFetchProgressTracker {
  private totals = new Map<string, number>();
  private positions = new Map<string, number>();
  private samples: { at: number; total: number }[] = [];
  private newBytes = 0;

  constructor(files: { file: string; bytesTotal: number }[] = []) {
    for (const f of files) this.totals.set(f.file, f.bytesTotal);
  }

  /** 报告某文件当前已就位的绝对字节数（高水位：只进不退）。 */
  notePosition(file: string, absoluteBytes: number): void {
    const total = this.totals.get(file);
    if (total === undefined) return;
    const clamped = Math.max(0, Math.min(absoluteBytes, total));
    if (clamped > (this.positions.get(file) ?? 0)) this.positions.set(file, clamped);
  }

  /** 恢复接续：把落盘的逐文件进度种回高水位（不计速度——恢复后
   *  速度从零重新测）。 */
  seed(file: string, absoluteBytes: number): void {
    this.notePosition(file, absoluteBytes);
  }

  positionOf(file: string): number {
    return this.positions.get(file) ?? 0;
  }

  /** 报告一块刚从网络收到的数据：只喂速度，不动进度位置。 */
  noteChunk(chunkBytes: number, now: number = Date.now()): void {
    if (chunkBytes <= 0) return;
    this.newBytes += chunkBytes;
    const last = this.samples[this.samples.length - 1];
    if (!last || now - last.at >= GEO_FETCH_SPEED_SAMPLE_MS) {
      this.samples.push({ at: now, total: this.newBytes });
    }
    this.prune(now);
  }

  private prune(now: number): void {
    const floor = now - GEO_FETCH_SPEED_WINDOW_MS;
    let drop = 0;
    while (drop < this.samples.length && this.samples[drop]!.at <= floor) drop++;
    // 窗口起点之前保留最近一个样本作测速基线，其余丢弃（数组有界）。
    if (drop > 1) this.samples.splice(0, drop - 1);
  }

  /** 当前滚动窗口平均速度（字节/秒）；窗口内没有新字节 → 0。 */
  speedBps(now: number = Date.now()): number {
    this.prune(now);
    const first = this.samples[0];
    if (!first) return 0;
    const gained = this.newBytes - first.total;
    const spanMs = now - first.at;
    if (gained <= 0 || spanMs <= 0) return 0;
    return gained / (spanMs / 1000);
  }

  snapshot(now: number = Date.now()): {
    downloadedBytes: number;
    totalBytes: number;
    speedBps: number;
    etaSeconds: number | null;
  } {
    let totalBytes = 0;
    let downloadedBytes = 0;
    for (const [file, total] of this.totals) {
      totalBytes += total;
      downloadedBytes += this.positions.get(file) ?? 0;
    }
    const speedBps = this.speedBps(now);
    const remaining = totalBytes - downloadedBytes;
    return {
      downloadedBytes,
      totalBytes,
      speedBps,
      etaSeconds: remaining > 0 && speedBps > 0 ? Math.ceil(remaining / speedBps) : null,
    };
  }
}

/** 把 tracker 的核算刷进任务状态（聚合字节 / 速度 / ETA / 当前文
 *  件）。运行中的任务每次进度事件与每次被读取时都刷一遍，所以管
 *  理员轮询到的速度永远是「此刻」的衰减值；任务结束后速度归零、
 *  ETA 与当前文件清空，只留最终字节数。 */
export function refreshGeoFetchProgress(
  job: GeoPackFetchJobState,
  tracker: GeoFetchProgressTracker,
  now: number = Date.now(),
): void {
  const snap = tracker.snapshot(now);
  job.totalBytes = snap.totalBytes;
  job.downloadedBytes = snap.downloadedBytes;
  if (job.status === "running") {
    job.speedBps = snap.speedBps;
    job.etaSeconds = snap.etaSeconds;
    const current = job.files.find(
      (f) => f.status === "downloading" || f.status === "retrying" || f.status === "verifying" || f.status === "activating",
    );
    job.currentFile = current ? current.file : null;
  } else {
    job.speedBps = 0;
    job.etaSeconds = null;
    job.currentFile = null;
  }
}

let activeFetchJob: GeoPackFetchJobState | null = null;
let lastFetchJob: GeoPackFetchJobState | null = null;
let activeFetchTracker: GeoFetchProgressTracker | null = null;

export function getGeoPackFetchState(): GeoPackFetchJobState | null {
  // 读取时按当前时刻刷新聚合进度：停滞期间没有进度事件进来，速
  // 度也要随窗口滑动衰减到 0，而不是停在最后一次事件的值上。
  if (activeFetchJob && activeFetchTracker) refreshGeoFetchProgress(activeFetchJob, activeFetchTracker);
  return activeFetchJob ?? lastFetchJob;
}

// --- 任务状态落盘（重启恢复） -------------------------------------------
// 只存恢复所需的最小集：任务本体（含逐文件状态）+ 发起人（收尾审
// 计要用）。原子写：先写 .tmp 再 rename，进程在写的半途被杀也只会
// 留下旧的一份完整状态。落盘失败永远不许拖垮任务本身。

const FETCH_JOB_STATE_NAME = "fetch-job-state.json";

interface PersistedFetchJob {
  version: 1;
  job: GeoPackFetchJobState;
  actorUserId: string | null;
}

function fetchJobStatePath(packDir: string): string {
  return path.join(geoSyncStagingDir(packDir), FETCH_JOB_STATE_NAME);
}

async function persistFetchJob(job: GeoPackFetchJobState, packDir: string, actorUserId: string | null): Promise<void> {
  try {
    const dir = geoSyncStagingDir(packDir);
    await mkdir(dir, { recursive: true });
    const full = fetchJobStatePath(packDir);
    const tmp = `${full}.tmp`;
    const payload: PersistedFetchJob = { version: 1, job, actorUserId };
    await writeFile(tmp, JSON.stringify(payload));
    await rename(tmp, full);
  } catch {
    /* 落盘失败：任务照跑，只是这次重启后恢复不了 */
  }
}

async function clearPersistedFetchJob(packDir: string): Promise<void> {
  await unlink(fetchJobStatePath(packDir)).catch(() => {});
}

async function readManifest(baseUrl: string, fetchImpl: GeoFetchImpl): Promise<GeoReleaseManifest> {
  const resp = await fetchImpl(assetUrl(baseUrl, GEO_RELEASE_MANIFEST_NAME), {});
  if (resp.status !== 200) {
    throw new GeoReleaseError(`release_manifest_http_${resp.status}`, `release manifest HTTP ${resp.status}`);
  }
  if (!resp.body) throw new GeoReleaseError("release_manifest_invalid", "release manifest has no body");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of Readable.fromWeb(resp.body as Parameters<typeof Readable.fromWeb>[0])) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_MANIFEST_BYTES) {
      throw new GeoReleaseError("release_manifest_invalid", "release manifest too large");
    }
    chunks.push(buf);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new GeoReleaseError("release_manifest_invalid", "release manifest is not JSON");
  }
  return parseGeoReleaseManifest(parsed);
}

/** 恢复任务读清单的瞬时重试上限。管理员新点的任务读清单失败立即
 *  判死——人在跟前，失败立即可见、再点一次就行；但进程重启恢复的
 *  任务没有人在跟前：开机头几秒网络 / DNS 往往还没就绪，一次瞬时
 *  失败就把恢复任务判死并清掉落盘状态，等于白恢复，管理员回来只
 *  能重新点。所以恢复任务读清单遇瞬时错误（网络层抛错、408 /
 *  429 / 5xx）按下载同一套退避多试几次（生产退避下 8 次约覆盖
 *  4 分钟的开机动荡期）；硬错误（404、清单非法）仍立即判死。 */
export const GEO_FETCH_RESUME_MANIFEST_ATTEMPTS = 8;

function isTransientManifestError(err: unknown): boolean {
  if (err instanceof GeoReleaseError) {
    const m = /^release_manifest_http_(\d+)$/.exec(err.code);
    return m ? isTransientHttpStatus(Number(m[1])) : false;
  }
  // fetch 本身抛错（连接失败 / DNS 未就绪 / 连接被重置）按瞬时处理。
  return true;
}

async function readManifestForJob(
  job: GeoPackFetchJobState,
  fetchImpl: GeoFetchImpl,
  tuning?: GeoDownloadTuning,
): Promise<GeoReleaseManifest> {
  const maxAttempts = job.recovered ? GEO_FETCH_RESUME_MANIFEST_ATTEMPTS : 1;
  for (let attempt = 1; ; attempt++) {
    try {
      return await readManifest(job.baseUrl, fetchImpl);
    } catch (err) {
      if (attempt >= maxAttempts || !isTransientManifestError(err)) throw err;
      job.lastError = `manifest: ${err instanceof Error ? err.message : String(err)}`;
      await sleep(
        geoFetchRetryDelayMs(
          attempt,
          tuning?.retryBaseMs ?? GEO_FETCH_RETRY_BASE_MS,
          tuning?.retryMaxMs ?? GEO_FETCH_RETRY_MAX_MS,
        ),
      );
    }
  }
}

async function auditFetchFinished(job: GeoPackFetchJobState, actorUserId: string | null): Promise<void> {
  try {
    await db.insert(schema.adminAuditLog).values({
      actorUserId,
      action: job.status === "done" ? "geo_pack.fetch_complete" : "geo_pack.fetch_failed",
      targetType: "geo_pack_release",
      targetId: job.release ?? job.id,
      details: {
        baseUrl: job.baseUrl,
        files: job.files.length,
        failed: job.files.filter((f) => f.status === "failed").map((f) => f.file),
      },
      // 系统动作没有请求 IP，沿用占位串的既有做法。
      ip: "-",
      userAgent: null,
    });
  } catch {
    /* 审计失败不许拖垮任务本身 */
  }
}

async function runFetchJob(
  job: GeoPackFetchJobState,
  args: { packDir: string; fetchImpl: GeoFetchImpl; actorUserId: string | null; tuning?: GeoDownloadTuning },
): Promise<void> {
  const persist = () => persistFetchJob(job, args.packDir, args.actorUserId);
  // 进度落盘节流基线：检查点落盘（计划生成 / 每个文件收尾）更新
  // 基线，进度事件只在距基线 ≥2 s 或又下了 ≥8 MiB 时才补写一次。
  let lastPersistAt = 0;
  let lastPersistDownloaded = 0;
  const persistCheckpoint = async () => {
    lastPersistAt = Date.now();
    lastPersistDownloaded = job.downloadedBytes;
    await persist();
  };
  const persistProgress = () => {
    const now = Date.now();
    if (
      now - lastPersistAt >= GEO_FETCH_PERSIST_MIN_MS ||
      job.downloadedBytes - lastPersistDownloaded >= GEO_FETCH_PERSIST_MIN_BYTES
    ) {
      lastPersistAt = now;
      lastPersistDownloaded = job.downloadedBytes;
      void persist();
    }
  };
  let tracker: GeoFetchProgressTracker | null = null;
  try {
    const manifest = await readManifestForJob(job, args.fetchImpl, args.tuning);
    job.release = manifest.release;
    const plan = releaseFilePlan(manifest);
    // 恢复接续：上一程落盘的逐文件进度按文件名种回高水位，聚合进
    // 度从落盘值起步（暂存文件还在盘上，续传位置与种子基本一致）；
    // 速度不种——新一程的 tracker 从零重新测。
    const previous = new Map(job.files.map((f) => [f.file, f.bytesDone]));
    job.files = plan.map((p) => ({
      file: p.file,
      status: "pending" as GeoFetchFileStatus,
      bytesTotal: p.bytes,
      bytesDone: 0,
      attempts: 0,
      error: null,
    }));
    tracker = new GeoFetchProgressTracker(plan.map((p) => ({ file: p.file, bytesTotal: p.bytes })));
    for (const state of job.files) {
      const before = previous.get(state.file);
      if (before) {
        tracker.seed(state.file, before);
        state.bytesDone = tracker.positionOf(state.file);
      }
    }
    activeFetchTracker = tracker;
    refreshGeoFetchProgress(job, tracker);
    await persistCheckpoint();
    let anyFailed = false;
    for (let i = 0; i < plan.length; i++) {
      const state = job.files[i]!;
      const item = plan[i]!;
      state.status = "downloading";
      const hooks: GeoDownloadHooks = {
        onAttempt: (attempt) => {
          state.attempts = attempt;
          if (attempt > 1) {
            state.status = "retrying";
            void persist();
          }
        },
        onRetry: (_attempt, message) => {
          state.error = message;
          job.lastError = `${item.file}: ${message}`;
          void persist();
        },
      };
      try {
        const res = await fetchGeoReleaseFile({
          baseUrl: job.baseUrl,
          plan: item,
          packDir: args.packDir,
          fetchImpl: args.fetchImpl,
          // 固定 scope：暂存名跨任务 / 跨重启稳定，半截文件能被下一轮续上。
          scope: GEO_FETCH_STAGING_SCOPE,
          hooks,
          tuning: args.tuning,
          onProgress: (n) => {
            // 经 tracker 高水位入账：续传接续、重写不倒退；聚合进
            // 度与速度随手刷新，落盘走节流（不许每块数据写一次盘）。
            tracker?.notePosition(item.file, n);
            state.bytesDone = tracker ? tracker.positionOf(item.file) : n;
            if (state.status === "retrying") state.status = "downloading";
            if (tracker) refreshGeoFetchProgress(job, tracker);
            persistProgress();
          },
          onChunk: (n) => tracker?.noteChunk(n),
        });
        state.status = res.status === "skipped" ? "skipped" : "done";
        tracker?.notePosition(item.file, item.bytes);
        state.bytesDone = item.bytes;
        state.error = null;
        if (tracker) refreshGeoFetchProgress(job, tracker);
      } catch (err) {
        // 走到这里的都是硬失败（瞬时失败在 downloadGeoAsset 里无限
        // 续传，不会上抛）：本文件判死，但不拖累后面的文件。
        state.status = "failed";
        state.error = err instanceof GeoReleaseError ? err.code : err instanceof Error ? err.message : String(err);
        job.lastError = `${item.file}: ${state.error}`;
        anyFailed = true;
      }
      await persistCheckpoint();
    }
    job.status = anyFailed ? "failed" : "done";
  } catch (err) {
    job.status = "failed";
    job.error = err instanceof GeoReleaseError ? err.code : err instanceof Error ? err.message : String(err);
  } finally {
    // 终态刷新一次聚合进度：字节数定格，速度 / ETA / 当前文件清空。
    if (tracker) refreshGeoFetchProgress(job, tracker);
    job.finishedAt = new Date().toISOString();
    activeFetchJob = null;
    activeFetchTracker = null;
    lastFetchJob = job;
    // 终态任务没有恢复价值：清掉落盘状态，下次开机不会「恢复」一个
    // 已经结束的任务。
    await clearPersistedFetchJob(args.packDir);
    await auditFetchFinished(job, args.actorUserId);
  }
}

/** 开始一次获取。已有任务在跑时返回 started=false（调用方提示稍
 *  后再试）——获取是重 IO，同一时刻只允许一个。 */
export function startGeoPackFetch(args: {
  actorUserId: string | null;
  packDir?: string;
  baseUrl?: string;
  fetchImpl?: GeoFetchImpl;
  tuning?: GeoDownloadTuning;
}): { started: boolean; job: GeoPackFetchJobState } {
  if (activeFetchJob) return { started: false, job: activeFetchJob };
  const job: GeoPackFetchJobState = {
    id: randomUUID(),
    status: "running",
    baseUrl: (args.baseUrl ?? resolveGeoPackReleaseBaseUrl()).replace(/\/+$/, ""),
    release: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    recovered: false,
    files: [],
    error: null,
    lastError: null,
    totalBytes: 0,
    downloadedBytes: 0,
    speedBps: 0,
    etaSeconds: null,
    currentFile: null,
  };
  activeFetchJob = job;
  void runFetchJob(job, {
    packDir: args.packDir ?? resolveGeoPackDir(),
    fetchImpl: args.fetchImpl ?? defaultFetchImpl,
    actorUserId: args.actorUserId,
    tuning: args.tuning,
  });
  return { started: true, job };
}

/** 开机自检：暂存区里有未完成任务的落盘状态，就把它恢复成一个继续
 *  跑的任务（标记 recovered，后台页据此显示「重启后已恢复」）。恢
 *  复时按当前清单重建计划——已落位的文件会被跳过判定认出来，半截
 *  文件靠固定 scope 的暂存名 Range 续上，所以重跑的代价只有重新
 *  验一遍已完成文件的 SHA。状态文件缺失 / 损坏 / 已是终态 → 不恢
 *  复（损坏的顺手清掉）。返回是否恢复了一个任务；永不抛错。 */
export async function resumePersistedGeoPackFetch(args: {
  packDir?: string;
  fetchImpl?: GeoFetchImpl;
  tuning?: GeoDownloadTuning;
} = {}): Promise<boolean> {
  if (activeFetchJob) return false;
  const packDir = args.packDir ?? resolveGeoPackDir();
  let raw: string;
  try {
    raw = await readFile(fetchJobStatePath(packDir), "utf8");
  } catch {
    return false;
  }
  let saved: PersistedFetchJob | null = null;
  try {
    saved = JSON.parse(raw) as PersistedFetchJob;
  } catch {
    saved = null;
  }
  if (
    !saved || saved.version !== 1 || !saved.job ||
    saved.job.status !== "running" || typeof saved.job.baseUrl !== "string"
  ) {
    await clearPersistedFetchJob(packDir);
    return false;
  }
  const job: GeoPackFetchJobState = {
    ...saved.job,
    status: "running",
    finishedAt: null,
    recovered: true,
    files: Array.isArray(saved.job.files) ? saved.job.files : [],
    error: null,
    // 聚合字节按落盘值接续（runFetchJob 会按当前清单再校准）；速
    // 度与 ETA 不接续落盘值——恢复后从零重新测。旧版本落盘文件没
    // 有这些字段时给缺省，双向兼容，不升 version。
    totalBytes: typeof saved.job.totalBytes === "number" ? saved.job.totalBytes : 0,
    downloadedBytes: typeof saved.job.downloadedBytes === "number" ? saved.job.downloadedBytes : 0,
    speedBps: 0,
    etaSeconds: null,
    currentFile: null,
  };
  activeFetchJob = job;
  void runFetchJob(job, {
    packDir,
    fetchImpl: args.fetchImpl ?? defaultFetchImpl,
    actorUserId: saved.actorUserId ?? null,
    tuning: args.tuning,
  });
  return true;
}
