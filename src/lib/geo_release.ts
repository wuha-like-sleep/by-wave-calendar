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
//     幂等的；下载支持 HTTP Range 续传 + 失败重试，大文件全程流式
//     落盘，不进内存。
//
// 任务状态只在进程内存里（与 suggest 缓存同性质）：重启后状态丢
// 失，但每个文件落位都是原子的、重跑可续，不会留下半成品。开始由
// 后台路由记审计，完成 / 失败在这里直插审计台账（无请求上下文，
// 沿用系统动作 ip="-" 的既有做法）。

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, truncate, unlink } from "node:fs/promises";
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
const DOWNLOAD_ATTEMPTS = 4;

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

/** 把清单摊平成下载顺序：共享文件先行；每个包先配套、sqlite 最后
 *  （与同步发送端的纪律一致——sqlite 落位即激活，激活时配套必须
 *  已经就位）。 */
export function releaseFilePlan(manifest: GeoReleaseManifest): GeoReleaseFilePlan[] {
  const plan: GeoReleaseFilePlan[] = [];
  for (const s of manifest.shared) plan.push({ file: s.name, bytes: s.bytes, sha256: s.sha256, parts: [] });
  for (const pack of manifest.packs) {
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

/** 把一个资产下载到 dest：已有部分文件时用 Range 续，服务端不认
 *  Range（回 200）就整文件重下；长度必须精确等于 expectedBytes，
 *  多一个字节都判失败。网络错误 / 5xx / 短读自动重试（续传语义让
 *  重试便宜），4xx 直接失败。 */
export async function downloadGeoAsset(args: {
  url: string;
  dest: string;
  expectedBytes: number;
  fetchImpl?: GeoFetchImpl;
  onProgress?: (bytesDone: number) => void;
}): Promise<void> {
  const fetchImpl = args.fetchImpl ?? defaultFetchImpl;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt++) {
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
      const resp = await fetchImpl(args.url, { headers });
      if (resp.status === 416) {
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
      } else if (resp.status === 408 || resp.status === 429 || resp.status >= 500) {
        throw new Error(`http_${resp.status}`);
      } else {
        throw new GeoReleaseError(`download_http_${resp.status}`, `download failed: HTTP ${resp.status} for ${args.url}`);
      }
      if (!resp.body) throw new Error("empty_body");
      let written = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          written += chunk.length;
          if (base + written > args.expectedBytes) {
            cb(new Error("download_size_overflow"));
            return;
          }
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
      lastError = err;
      if (attempt < DOWNLOAD_ATTEMPTS - 1) await sleep(400 * 2 ** attempt);
    }
  }
  throw new GeoReleaseError(
    "download_failed",
    `download failed after ${DOWNLOAD_ATTEMPTS} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
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
// 获取任务（进程内存状态，后台页轮询/刷新可见）
// ---------------------------------------------------------------------------

export type GeoFetchFileStatus =
  | "pending"
  | "downloading"
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
  error: string | null;
}

export interface GeoPackFetchJobState {
  id: string;
  status: "running" | "done" | "failed";
  baseUrl: string;
  release: string | null;
  startedAt: string;
  finishedAt: string | null;
  files: GeoPackFetchFileState[];
  error: string | null;
}

let activeFetchJob: GeoPackFetchJobState | null = null;
let lastFetchJob: GeoPackFetchJobState | null = null;

export function getGeoPackFetchState(): GeoPackFetchJobState | null {
  return activeFetchJob ?? lastFetchJob;
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
  args: { packDir: string; fetchImpl: GeoFetchImpl; actorUserId: string | null },
): Promise<void> {
  try {
    const manifest = await readManifest(job.baseUrl, args.fetchImpl);
    job.release = manifest.release;
    const plan = releaseFilePlan(manifest);
    job.files = plan.map((p) => ({
      file: p.file,
      status: "pending" as GeoFetchFileStatus,
      bytesTotal: p.bytes,
      bytesDone: 0,
      error: null,
    }));
    let anyFailed = false;
    for (let i = 0; i < plan.length; i++) {
      const state = job.files[i]!;
      const item = plan[i]!;
      state.status = "downloading";
      try {
        const res = await fetchGeoReleaseFile({
          baseUrl: job.baseUrl,
          plan: item,
          packDir: args.packDir,
          fetchImpl: args.fetchImpl,
          scope: job.id,
          onProgress: (n) => {
            state.bytesDone = n;
          },
        });
        state.status = res.status === "skipped" ? "skipped" : "done";
        state.bytesDone = item.bytes;
      } catch (err) {
        state.status = "failed";
        state.error = err instanceof GeoReleaseError ? err.code : err instanceof Error ? err.message : String(err);
        anyFailed = true;
      }
    }
    job.status = anyFailed ? "failed" : "done";
  } catch (err) {
    job.status = "failed";
    job.error = err instanceof GeoReleaseError ? err.code : err instanceof Error ? err.message : String(err);
  } finally {
    job.finishedAt = new Date().toISOString();
    activeFetchJob = null;
    lastFetchJob = job;
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
}): { started: boolean; job: GeoPackFetchJobState } {
  if (activeFetchJob) return { started: false, job: activeFetchJob };
  const job: GeoPackFetchJobState = {
    id: randomUUID(),
    status: "running",
    baseUrl: (args.baseUrl ?? resolveGeoPackReleaseBaseUrl()).replace(/\/+$/, ""),
    release: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    files: [],
    error: null,
  };
  activeFetchJob = job;
  void runFetchJob(job, {
    packDir: args.packDir ?? resolveGeoPackDir(),
    fetchImpl: args.fetchImpl ?? defaultFetchImpl,
    actorUserId: args.actorUserId,
  });
  return { started: true, job };
}
