// 地址包同步通道（DGX → 本站）的服务端核心：同步令牌 + 分片上传会话。
//
// 这是本站唯一一个「往生产文件系统写大文件」的入口，安全口径按最严一档：
//
//   - 鉴权独立：同步令牌（bwgs_ 前缀）和个人 API Token、管理员会话完全
//     分开，只存 bcrypt 哈希、按 prefix 索引查找后 bcrypt 比对；查无此
//     prefix 时跑一次哑比对烧掉同样的 CPU，响应时间不泄露 prefix 是否
//     存在。吊销写 revoked_at，校验每次都查，立即生效。
//   - 文件名白名单：只接受管线既定命名（pack-<id>.sqlite / manifest-<id>
//     .json / licence-manifest-<id>.json / attribution-<id>.txt / 顶层共享
//     文件 / licences/<name>.txt），和后台下载白名单同一套规则。请求里的
//     文件名永远只做分类查表，落盘路径由服务端拼、拼完再验包含关系。
//   - 先 manifest 后数据：开会话时就把字节数 / SHA-256 / 行数 / 区域 /
//     版本钉死在会话行里；分片逐片验 SHA-256（请求头）+ 精确长度，写进
//     包目录下 .incoming/ 的暂存文件（按偏移定位写）；全部收齐后重算
//     整体 SHA-256 与 manifest 不一致 → 删暂存、记 failed + 审计，绝不
//     落位。一致才 rename 原子落位（同文件系统内 rename 是原子的，
//     provider 按 mtime 重开句柄，读者永远看到完整的旧包或新包）。
//   - sqlite 包多一道：落位前验文件头 + 读 meta.pack_id 与文件名 id 对
//     不上同样拒绝——SHA 对得上但内容不是这个包（管线串包）也进不来。
//   - 会话归属：分片 / 状态 / 完成 / 中止都要求会话属于出示的令牌；
//     同一文件的旧 receiving 会话会被新会话顶替（置 aborted + 删暂存），
//     48 小时没动静的会话在下次开会话时顺手清理。
//   - 审计：令牌的生成 / 吊销在后台路由记；激活成功记 geo_pack.
//     sync_activate，校验失败记 geo_pack.sync_rejected，鉴权失败（带
//     bwgs_ 形状的 Bearer）记 geo_sync.auth_failed。审计只带 prefix，
//     绝不带明文。
//
// 目录解析只有一个入口 resolveGeoPackDir()：ingest 往这里写、provider
// 从这里读、后台从这里列——三方永远同一个目录，不存在「传上去了但
// suggest 读的是另一个目录」的漂移。

import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { hashPassword, verifyPassword, verifyPasswordTimingSafe } from "./password.js";

/** 包目录的唯一解析入口：GEO_PACK_DIR 显式配置优先，没配时落到仓库
 *  既有数据目录惯例（cwd 下 data/）里的 geo-packs 子目录。 */
export function resolveGeoPackDir(): string {
  return env.GEO_PACK_DIR ?? path.join(process.cwd(), "data", "geo-packs");
}

/** 暂存区：包目录内的 .incoming/。和最终文件同一文件系统，rename 才
 *  是原子的；目录扫描（后台清单 / provider）的文件名规则都不会命中它。 */
export function geoSyncStagingDir(packDir: string = resolveGeoPackDir()): string {
  return path.join(packDir, ".incoming");
}

function stagingPathFor(packDir: string, uploadId: string): string {
  const dir = geoSyncStagingDir(packDir);
  const full = path.join(dir, `${uploadId}.part`);
  if (!path.resolve(full).startsWith(path.resolve(dir) + path.sep)) {
    throw new Error("staging path escapes staging dir");
  }
  return full;
}

function finalPathFor(packDir: string, fileName: string): string {
  const full = path.join(packDir, fileName);
  if (!path.resolve(full).startsWith(path.resolve(packDir) + path.sep)) {
    throw new Error("final path escapes pack dir");
  }
  return full;
}

// ---------------------------------------------------------------------------
// 文件名白名单（与 geo_packs.ts 的下载白名单同一套命名规则）
// ---------------------------------------------------------------------------

export type GeoSyncFileKind =
  | "pack"
  | "manifest"
  | "licence-manifest"
  | "attribution"
  | "shared-manifest"
  | "shared-attribution"
  | "licence-text";

export interface GeoSyncFileClass {
  kind: GeoSyncFileKind;
  /** pack-<id> 里的 id（共享文件为 null）。 */
  packId: string | null;
  maxBytes: number;
}

export const MAX_PACK_BYTES = 16 * 1024 * 1024 * 1024; // 16 GiB：全国包 9.47 GiB，留一代增长余量
export const MAX_TEXT_BYTES = 16 * 1024 * 1024; // manifest / attribution
export const MAX_LICENCE_TEXT_BYTES = 4 * 1024 * 1024;

export function classifyGeoSyncFile(name: string): GeoSyncFileClass | null {
  if (!name || name.length > 200) return null;
  if (name.includes("\\") || name.includes("\0") || name.includes("..")) return null;
  let m = /^pack-([a-z0-9][a-z0-9-]*)\.sqlite$/i.exec(name);
  if (m) return { kind: "pack", packId: m[1]!.toLowerCase(), maxBytes: MAX_PACK_BYTES };
  m = /^licence-manifest-([a-z0-9][a-z0-9-]*)\.json$/i.exec(name);
  if (m) return { kind: "licence-manifest", packId: m[1]!.toLowerCase(), maxBytes: MAX_TEXT_BYTES };
  m = /^manifest-([a-z0-9][a-z0-9-]*)\.json$/i.exec(name);
  if (m) return { kind: "manifest", packId: m[1]!.toLowerCase(), maxBytes: MAX_TEXT_BYTES };
  m = /^attribution-([a-z0-9][a-z0-9-]*)\.txt$/i.exec(name);
  if (m) return { kind: "attribution", packId: m[1]!.toLowerCase(), maxBytes: MAX_TEXT_BYTES };
  if (name === "manifest.json" || name === "licence-manifest.json") {
    return { kind: "shared-manifest", packId: null, maxBytes: MAX_TEXT_BYTES };
  }
  if (name === "ATTRIBUTION.txt") {
    return { kind: "shared-attribution", packId: null, maxBytes: MAX_TEXT_BYTES };
  }
  m = /^licences\/([a-z0-9][a-z0-9.-]*\.txt)$/i.exec(name);
  if (m) return { kind: "licence-text", packId: null, maxBytes: MAX_LICENCE_TEXT_BYTES };
  return null;
}

// ---------------------------------------------------------------------------
// 分片规划（纯函数，单测覆盖）
// ---------------------------------------------------------------------------

export const MIN_CHUNK_BYTES = 256 * 1024;
export const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
export const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;

export function planChunkCount(bytes: number, chunkSize: number): number {
  return Math.max(1, Math.ceil(bytes / chunkSize));
}

/** 第 index 片应有的精确字节数（最后一片可以短，其余必须整片）。 */
export function chunkLengthAt(bytes: number, chunkSize: number, index: number): number {
  const remaining = bytes - index * chunkSize;
  return Math.min(chunkSize, Math.max(0, remaining));
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

async function sha256File(full: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(full)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------
// 同步令牌
// ---------------------------------------------------------------------------

const SYNC_PREFIX_LEN = 8;
const SYNC_SECRET_LEN = 32;
const SYNC_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghijkmnpqrstuvwxyz";
const SYNC_TOKEN_RE = /^bwgs_([A-Za-z0-9]{8})_[A-Za-z0-9]{32}$/;

function randomFromAlphabet(alphabet: string, len: number): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

export function looksLikeGeoSyncToken(s: string): boolean {
  return SYNC_TOKEN_RE.test(s);
}

/** 失败日志 / 审计用的 prefix（明文令牌的非秘密部分），形状不对返回 null。 */
export function geoSyncTokenPrefix(token: string): string | null {
  return SYNC_TOKEN_RE.exec(token)?.[1] ?? null;
}

export interface IssuedGeoSyncToken {
  id: string;
  plain: string;
  prefix: string;
}

export async function createGeoSyncToken(input: {
  label: string;
  createdBy: string | null;
}): Promise<IssuedGeoSyncToken> {
  const prefix = randomFromAlphabet(SYNC_ALPHABET, SYNC_PREFIX_LEN);
  const secret = randomFromAlphabet(SYNC_ALPHABET, SYNC_SECRET_LEN);
  const plain = `bwgs_${prefix}_${secret}`;
  const tokenHash = await hashPassword(plain);
  const [row] = await db.insert(schema.geoSyncTokens).values({
    label: input.label.trim() || "未命名",
    prefix,
    tokenHash,
    createdBy: input.createdBy,
  }).returning({ id: schema.geoSyncTokens.id });
  if (!row) throw new Error("geo_sync_token insert failed");
  return { id: row.id, plain, prefix };
}

/** 校验一枚明文同步令牌。命中返回令牌行并顺手记 last_used / use_count；
 *  未命中返回 null（prefix 不存在时跑哑比对，时序上与「secret 不对」
 *  不可区分）。吊销（revoked_at 非空）在查询条件里就排除，立即生效。 */
export async function verifyGeoSyncToken(plain: string, ip?: string): Promise<schema.GeoSyncToken | null> {
  const prefix = geoSyncTokenPrefix(plain);
  if (!prefix) {
    await verifyPasswordTimingSafe(plain);
    return null;
  }
  const [row] = await db
    .select()
    .from(schema.geoSyncTokens)
    .where(and(eq(schema.geoSyncTokens.prefix, prefix), isNull(schema.geoSyncTokens.revokedAt)))
    .limit(1);
  if (!row) {
    await verifyPasswordTimingSafe(plain);
    return null;
  }
  if (!(await verifyPassword(plain, row.tokenHash))) return null;
  await db
    .update(schema.geoSyncTokens)
    .set({
      lastUsedAt: new Date(),
      lastUsedIp: ip ?? null,
      useCount: row.useCount + 1,
    })
    .where(eq(schema.geoSyncTokens.id, row.id));
  return row;
}

export async function listGeoSyncTokens() {
  return db
    .select({
      id: schema.geoSyncTokens.id,
      label: schema.geoSyncTokens.label,
      prefix: schema.geoSyncTokens.prefix,
      lastUsedAt: schema.geoSyncTokens.lastUsedAt,
      lastUsedIp: schema.geoSyncTokens.lastUsedIp,
      useCount: schema.geoSyncTokens.useCount,
      revokedAt: schema.geoSyncTokens.revokedAt,
      createdAt: schema.geoSyncTokens.createdAt,
    })
    .from(schema.geoSyncTokens)
    .orderBy(desc(schema.geoSyncTokens.createdAt));
}

/** 吊销一枚令牌。已吊销的重复吊销返回 false（调用方据此提示）。 */
export async function revokeGeoSyncToken(id: string): Promise<boolean> {
  const rows = await db
    .update(schema.geoSyncTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.geoSyncTokens.id, id), isNull(schema.geoSyncTokens.revokedAt)))
    .returning({ id: schema.geoSyncTokens.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// 上传会话
// ---------------------------------------------------------------------------

export class GeoSyncError extends Error {
  constructor(
    public code: string,
    public httpStatus: number,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export interface GeoSyncManifestInput {
  file: string;
  bytes: number;
  sha256: string;
  rows?: number | null;
  region?: string | null;
  packVersion?: string | null;
  chunkSize?: number | null;
}

export interface GeoSyncSessionView {
  uploadId: string;
  file: string;
  bytes: number;
  sha256: string;
  chunkSize: number;
  chunkCount: number;
  receivedChunks: number[];
  status: string;
}

export function sessionViewOf(row: schema.GeoSyncUpload): GeoSyncSessionView {
  return {
    uploadId: row.id,
    file: row.fileName,
    bytes: row.bytes,
    sha256: row.sha256,
    chunkSize: row.chunkSize,
    chunkCount: row.chunkCount,
    receivedChunks: receivedOf(row),
    status: row.status,
  };
}

function receivedOf(row: schema.GeoSyncUpload): number[] {
  const raw = row.receivedChunks;
  if (!Array.isArray(raw)) return [];
  return raw.filter((n): n is number => typeof n === "number" && Number.isInteger(n)).sort((a, b) => a - b);
}

async function unlinkQuiet(full: string): Promise<void> {
  try {
    await unlink(full);
  } catch {
    /* 不存在就算了 */
  }
}

/** 过期会话清理：receiving 且 48 小时没动静 → aborted + 删暂存。
 *  在开新会话时顺手跑（同步通道的调用天然稀疏，不值得为它单开定时器）。 */
export async function cleanupStaleGeoSyncUploads(packDir: string = resolveGeoPackDir()): Promise<void> {
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const stale = await db
    .select({ id: schema.geoSyncUploads.id })
    .from(schema.geoSyncUploads)
    .where(and(eq(schema.geoSyncUploads.status, "receiving"), lt(schema.geoSyncUploads.updatedAt, cutoff)));
  for (const s of stale) {
    await db
      .update(schema.geoSyncUploads)
      .set({ status: "aborted", error: "stale_session", updatedAt: new Date() })
      .where(eq(schema.geoSyncUploads.id, s.id));
    await unlinkQuiet(stagingPathFor(packDir, s.id));
  }
}

/** 开一个上传会话（或找回可续传的已有会话）。
 *  续传口径：同一令牌、同一 (file, sha256, bytes) 且还在 receiving 的
 *  会话直接返回——分片大小以原会话为准，客户端按返回的 chunkSize 续。
 *  同名文件的其它 receiving 会话（内容已变）被顶替：置 aborted 并删
 *  暂存，避免两个半成品在暂存区互相踩。 */
export async function startGeoSyncUpload(
  token: schema.GeoSyncToken,
  input: GeoSyncManifestInput,
  packDir: string = resolveGeoPackDir(),
): Promise<GeoSyncSessionView> {
  const cls = classifyGeoSyncFile(input.file);
  if (!cls) throw new GeoSyncError("file_not_allowed", 400, `file name not allowed: ${input.file}`);
  if (!Number.isInteger(input.bytes) || input.bytes < 1) {
    throw new GeoSyncError("bad_bytes", 400, "bytes must be a positive integer");
  }
  if (input.bytes > cls.maxBytes) {
    throw new GeoSyncError("file_too_large", 413, `${input.file} exceeds ${cls.maxBytes} bytes`);
  }
  const sha = String(input.sha256 ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new GeoSyncError("bad_sha256", 400, "sha256 must be 64 hex chars");
  const chunkSize = input.chunkSize ?? DEFAULT_CHUNK_BYTES;
  if (!Number.isInteger(chunkSize) || chunkSize < MIN_CHUNK_BYTES || chunkSize > MAX_CHUNK_BYTES) {
    throw new GeoSyncError("bad_chunk_size", 400, `chunkSize must be within ${MIN_CHUNK_BYTES}..${MAX_CHUNK_BYTES}`);
  }

  await cleanupStaleGeoSyncUploads(packDir);

  const [resumable] = await db
    .select()
    .from(schema.geoSyncUploads)
    .where(
      and(
        eq(schema.geoSyncUploads.tokenId, token.id),
        eq(schema.geoSyncUploads.fileName, input.file),
        eq(schema.geoSyncUploads.sha256, sha),
        eq(schema.geoSyncUploads.bytes, input.bytes),
        eq(schema.geoSyncUploads.status, "receiving"),
      ),
    )
    .orderBy(desc(schema.geoSyncUploads.createdAt))
    .limit(1);
  if (resumable) {
    // 暂存文件不在了（被外部清掉）就重建一个空的，已收分片记录作废重来。
    const part = stagingPathFor(packDir, resumable.id);
    try {
      await stat(part);
    } catch {
      await resetStagingFile(packDir, resumable);
      await db
        .update(schema.geoSyncUploads)
        .set({ receivedChunks: [], updatedAt: new Date() })
        .where(eq(schema.geoSyncUploads.id, resumable.id));
      return sessionViewOf({ ...resumable, receivedChunks: [] });
    }
    return sessionViewOf(resumable);
  }

  // 顶替同名文件的其它 receiving 会话。
  const superseded = await db
    .select({ id: schema.geoSyncUploads.id })
    .from(schema.geoSyncUploads)
    .where(and(eq(schema.geoSyncUploads.fileName, input.file), eq(schema.geoSyncUploads.status, "receiving")));
  for (const s of superseded) {
    await db
      .update(schema.geoSyncUploads)
      .set({ status: "aborted", error: "superseded", updatedAt: new Date() })
      .where(eq(schema.geoSyncUploads.id, s.id));
    await unlinkQuiet(stagingPathFor(packDir, s.id));
  }

  const chunkCount = planChunkCount(input.bytes, chunkSize);
  const [row] = await db
    .insert(schema.geoSyncUploads)
    .values({
      tokenId: token.id,
      fileName: input.file,
      kind: cls.kind,
      packId: cls.packId,
      bytes: input.bytes,
      sha256: sha,
      rowsTotal: input.rows ?? null,
      region: input.region ?? null,
      packVersion: input.packVersion ?? null,
      chunkSize,
      chunkCount,
      receivedChunks: [],
      status: "receiving",
    })
    .returning();
  if (!row) throw new Error("geo_sync_upload insert failed");
  await resetStagingFile(packDir, row);
  return sessionViewOf(row);
}

/** 建（或重建）暂存文件：先按目标大小 truncate 成稀疏文件，分片按偏移
 *  定位写。文件大小本身不代表进度，进度只看会话行的 received_chunks。 */
async function resetStagingFile(packDir: string, row: schema.GeoSyncUpload): Promise<void> {
  await mkdir(geoSyncStagingDir(packDir), { recursive: true });
  const fh = await open(stagingPathFor(packDir, row.id), "w");
  try {
    await fh.truncate(row.bytes);
  } finally {
    await fh.close();
  }
}

export async function getGeoSyncUpload(id: string): Promise<schema.GeoSyncUpload | null> {
  const [row] = await db.select().from(schema.geoSyncUploads).where(eq(schema.geoSyncUploads.id, id)).limit(1);
  return row ?? null;
}

/** 收一片。逐片纪律：会话必须 receiving、分片号在范围内、长度必须与
 *  规划精确相等、SHA-256 必须与请求头一致——任一不符整片拒绝且不记
 *  进度。重复收同一片是幂等的（覆盖写 + 集合去重），断线重发安全。 */
export async function recordGeoSyncChunk(
  row: schema.GeoSyncUpload,
  index: number,
  data: Buffer,
  chunkSha256: string,
  packDir: string = resolveGeoPackDir(),
): Promise<GeoSyncSessionView> {
  if (row.status !== "receiving") throw new GeoSyncError("session_not_receiving", 409, `session is ${row.status}`);
  if (!Number.isInteger(index) || index < 0 || index >= row.chunkCount) {
    throw new GeoSyncError("bad_chunk_index", 400, `chunk index out of range: ${index}`);
  }
  const expected = chunkLengthAt(row.bytes, row.chunkSize, index);
  if (data.length !== expected) {
    throw new GeoSyncError("bad_chunk_length", 400, `chunk ${index} must be ${expected} bytes, got ${data.length}`);
  }
  const digest = sha256Hex(data);
  if (digest !== String(chunkSha256 ?? "").toLowerCase()) {
    throw new GeoSyncError("chunk_checksum_mismatch", 422, `chunk ${index} sha256 mismatch`);
  }
  const fh = await open(stagingPathFor(packDir, row.id), "r+");
  try {
    await fh.write(data, 0, data.length, index * row.chunkSize);
  } finally {
    await fh.close();
  }
  const received = new Set(receivedOf(row));
  received.add(index);
  const next = [...received].sort((a, b) => a - b);
  await db
    .update(schema.geoSyncUploads)
    .set({ receivedChunks: next, updatedAt: new Date() })
    .where(eq(schema.geoSyncUploads.id, row.id));
  return sessionViewOf({ ...row, receivedChunks: next });
}

/** sqlite 包的落位前自检：文件头必须是 SQLite 3，且 meta.pack_id 与
 *  文件名 id 一致。node:sqlite 不可用（老 Node）时只做文件头检查——
 *  整体 SHA 已经保证「传过来的就是管线产出的那个文件」，这道是防
 *  管线串包的纵深防御，缺了不至于放行坏数据。 */
async function verifyPackContent(partFile: string, expectedPackId: string): Promise<string | null> {
  const fh = await open(partFile, "r");
  try {
    const head = Buffer.alloc(16);
    await fh.read(head, 0, 16, 0);
    if (head.toString("latin1") !== "SQLite format 3\0") return "not_a_sqlite_file";
  } finally {
    await fh.close();
  }
  try {
    const mod = (await import("node:sqlite")) as unknown as {
      DatabaseSync: new (file: string, opts?: { readOnly?: boolean }) => {
        prepare: (sql: string) => { get: () => unknown };
        close: () => void;
      };
    };
    const sqliteDb = new mod.DatabaseSync(partFile, { readOnly: true });
    try {
      const meta = sqliteDb.prepare("SELECT value FROM meta WHERE key = 'pack_id'").get() as
        | { value?: string }
        | undefined;
      if (meta?.value && meta.value.toLowerCase() !== expectedPackId.toLowerCase()) {
        return "pack_id_mismatch";
      }
    } finally {
      sqliteDb.close();
    }
  } catch {
    /* node:sqlite 不可用或 meta 缺失：文件头 + 整体 SHA 已兜底，跳过 */
  }
  return null;
}

export interface GeoActivateOutcome {
  ok: boolean;
  error?: string;
}

/** 原子落位的唯一实现：暂存文件 → 大小核对 → 整体 SHA-256 复核 →
 *  （包）内容自检 → rename 落位。同步通道的 complete 和后台「获取官方
 *  包」（lib/geo_release.ts）共用这一条路径——任何入口想把包放进包目
 *  录，都必须过同样的校验，不存在第二条宽松的落位通道。校验失败时
 *  暂存文件原样保留，删不删由调用方按自己的台账语义决定。 */
export async function activateStagedGeoFile(args: {
  stagingFile: string;
  fileName: string;
  bytes: number;
  sha256: string;
  packDir?: string;
}): Promise<GeoActivateOutcome> {
  const packDir = args.packDir ?? resolveGeoPackDir();
  const cls = classifyGeoSyncFile(args.fileName);
  if (!cls) return { ok: false, error: "file_not_allowed" };
  const st = await stat(args.stagingFile).catch(() => null);
  if (!st || st.size !== args.bytes) return { ok: false, error: "staging_size_mismatch" };
  const actual = await sha256File(args.stagingFile);
  if (actual !== args.sha256.toLowerCase()) return { ok: false, error: "sha256_mismatch" };
  if (cls.kind === "pack" && cls.packId) {
    const contentError = await verifyPackContent(args.stagingFile, cls.packId);
    if (contentError) return { ok: false, error: contentError };
  }
  const target = finalPathFor(packDir, args.fileName);
  await mkdir(path.dirname(target), { recursive: true });
  await rename(args.stagingFile, target);
  return { ok: true };
}

export interface GeoSyncCompleteResult {
  ok: boolean;
  /** active = 已落位；failed = 已判失败（暂存已删）；receiving = 还缺片，会话原样保留等补传。 */
  status: "active" | "failed" | "receiving";
  error?: string;
  missing?: number[];
}

/** 完成一次上传：收齐 → 整体 SHA-256 复核 → （包）内容自检 → 原子
 *  落位。任何一步失败都删暂存、置 failed 并把原因留在会话行里，调用
 *  方（路由）据此记审计。缺片不是失败：返回 missing 让客户端补传。 */
export async function completeGeoSyncUpload(
  row: schema.GeoSyncUpload,
  packDir: string = resolveGeoPackDir(),
): Promise<GeoSyncCompleteResult> {
  if (row.status !== "receiving") throw new GeoSyncError("session_not_receiving", 409, `session is ${row.status}`);
  const received = new Set(receivedOf(row));
  const missing: number[] = [];
  for (let i = 0; i < row.chunkCount; i++) if (!received.has(i)) missing.push(i);
  if (missing.length > 0) return { ok: false, status: "receiving", error: "chunks_missing", missing };

  const part = stagingPathFor(packDir, row.id);
  const fail = async (error: string): Promise<GeoSyncCompleteResult> => {
    await db
      .update(schema.geoSyncUploads)
      .set({ status: "failed", error, updatedAt: new Date() })
      .where(eq(schema.geoSyncUploads.id, row.id));
    await unlinkQuiet(part);
    return { ok: false, status: "failed", error };
  };

  const outcome = await activateStagedGeoFile({
    stagingFile: part,
    fileName: row.fileName,
    bytes: row.bytes,
    sha256: row.sha256,
    packDir,
  });
  if (!outcome.ok) return fail(outcome.error ?? "activate_failed");

  await db
    .update(schema.geoSyncUploads)
    .set({ status: "active", completedAt: new Date(), updatedAt: new Date(), error: null })
    .where(eq(schema.geoSyncUploads.id, row.id));
  return { ok: true, status: "active" };
}

/** 中止一次上传：置 aborted 并删暂存。已落位（active）的会话不可中止。 */
export async function abortGeoSyncUpload(
  row: schema.GeoSyncUpload,
  packDir: string = resolveGeoPackDir(),
): Promise<void> {
  if (row.status === "receiving") {
    await db
      .update(schema.geoSyncUploads)
      .set({ status: "aborted", error: "aborted_by_client", updatedAt: new Date() })
      .where(eq(schema.geoSyncUploads.id, row.id));
  }
  await unlinkQuiet(stagingPathFor(packDir, row.id));
}

/** 后台用：每个文件名最近一次上传（同步状态徽章的数据源）。 */
export async function latestGeoSyncUploadByFile(limit = 200): Promise<Map<string, schema.GeoSyncUpload>> {
  const rows = await db
    .select()
    .from(schema.geoSyncUploads)
    .orderBy(desc(schema.geoSyncUploads.createdAt))
    .limit(limit);
  const out = new Map<string, schema.GeoSyncUpload>();
  for (const r of rows) if (!out.has(r.fileName)) out.set(r.fileName, r);
  return out;
}

/** 后台用：最近的同步活动流水。 */
export async function listRecentGeoSyncUploads(limit = 20): Promise<schema.GeoSyncUpload[]> {
  return db.select().from(schema.geoSyncUploads).orderBy(desc(schema.geoSyncUploads.createdAt)).limit(limit);
}
