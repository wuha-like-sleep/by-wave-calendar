// 地址包同步通道的 HTTP 入口（DGX → 本站），挂在 /api 与 /api/v1 下：
//   POST   /geo-sync/uploads                  开会话（先传 manifest）
//   GET    /geo-sync/uploads/:id              查会话（断点续传凭它）
//   PUT    /geo-sync/uploads/:id/chunks/:idx  传一片（原始字节 + 片 SHA）
//   POST   /geo-sync/uploads/:id/complete     收齐 → 校验 → 原子落位
//   DELETE /geo-sync/uploads/:id              中止并清暂存
//   GET    /geo-sync/packs                    已激活包清单（客户端比对用）
//
// 鉴权只认同步令牌（Authorization: Bearer bwgs_…），不认会话、不认个人
// API Token——三套凭据互不通用，任何一套泄漏都不会放大到其它面。失败
// 一律 401 { error: "invalid_token" }，与个人 API 的失败口径一致，不给
// 探测者多余信息。核心纪律（白名单 / 逐片校验 / 整体复核 / 原子落位）
// 都在 lib/geo_sync.ts，这里只做协议适配、限流与审计。

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { listGeoPacks } from "../lib/geo_packs.js";
import {
  GeoSyncError,
  abortGeoSyncUpload,
  completeGeoSyncUpload,
  geoSyncTokenPrefix,
  getGeoSyncUpload,
  looksLikeGeoSyncToken,
  recordGeoSyncChunk,
  resolveGeoPackDir,
  sessionViewOf,
  startGeoSyncUpload,
  verifyGeoSyncToken,
  MAX_CHUNK_BYTES,
} from "../lib/geo_sync.js";
import type { GeoSyncToken, GeoSyncUpload } from "../db/schema.js";

const manifestSchema = z.object({
  file: z.string().min(1).max(200),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
  rows: z.number().int().nonnegative().nullable().optional(),
  region: z.string().max(200).nullable().optional(),
  packVersion: z.string().max(100).nullable().optional(),
  chunkSize: z.number().int().positive().nullable().optional(),
});

function bearerOf(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1]!.trim() : null;
}

export async function geoSyncRoutes(app: FastifyInstance) {
  // 分片是原始字节流。这个解析器只注册在本插件的封装上下文里，不影响
  // 站内其它接口；大小上限由解析器和 lib 的精确长度校验双重兜住。
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: MAX_CHUNK_BYTES },
    (_req, body, done) => done(null, body),
  );

  async function requireSyncToken(req: FastifyRequest, reply: FastifyReply): Promise<GeoSyncToken | null> {
    const plain = bearerOf(req);
    const token = plain ? await verifyGeoSyncToken(plain, req.ip) : null;
    if (!token) {
      // 只审计「形状像同步令牌」的失败：随机扫描拿别的凭据撞这个口子
      // 不值一条审计行，真正的令牌被盗刷/写错才需要留痕。
      if (plain && looksLikeGeoSyncToken(plain)) {
        await audit(req, null, "geo_sync.auth_failed", {
          targetType: "geo_sync_token",
          details: { prefix: geoSyncTokenPrefix(plain) },
        });
      }
      reply.code(401).send({ error: "invalid_token" });
      return null;
    }
    return token;
  }

  /** 取会话并验归属：会话不属于出示的令牌时按不存在处理（404），
   *  不给「这个 id 存在但不是你的」这种可探测的区分。 */
  async function ownSession(req: FastifyRequest, reply: FastifyReply, token: GeoSyncToken): Promise<GeoSyncUpload | null> {
    const parsed = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!parsed.success) {
      reply.code(404).send({ error: "upload_not_found" });
      return null;
    }
    const row = await getGeoSyncUpload(parsed.data.id);
    if (!row || row.tokenId !== token.id) {
      reply.code(404).send({ error: "upload_not_found" });
      return null;
    }
    return row;
  }

  function sendSyncError(reply: FastifyReply, err: unknown) {
    if (err instanceof GeoSyncError) {
      return reply.code(err.httpStatus).send({ error: err.code });
    }
    throw err;
  }

  app.post(
    "/geo-sync/uploads",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const token = await requireSyncToken(req, reply);
      if (!token) return reply;
      const parsed = manifestSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "bad_manifest" });
      try {
        const view = await startGeoSyncUpload(token, parsed.data);
        return reply.code(201).send(view);
      } catch (err) {
        return sendSyncError(reply, err);
      }
    },
  );

  app.get(
    "/geo-sync/uploads/:id",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const token = await requireSyncToken(req, reply);
      if (!token) return reply;
      const row = await ownSession(req, reply, token);
      if (!row) return reply;
      return reply.send(sessionViewOf(row));
    },
  );

  app.put(
    "/geo-sync/uploads/:id/chunks/:index",
    { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const token = await requireSyncToken(req, reply);
      if (!token) return reply;
      const row = await ownSession(req, reply, token);
      if (!row) return reply;
      const params = z.object({ index: z.coerce.number().int().nonnegative() }).safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: "bad_chunk_index" });
      const chunkSha = req.headers["x-chunk-sha256"];
      if (typeof chunkSha !== "string" || !/^[0-9a-fA-F]{64}$/.test(chunkSha)) {
        return reply.code(400).send({ error: "missing_chunk_sha256" });
      }
      const data = req.body;
      if (!Buffer.isBuffer(data)) return reply.code(400).send({ error: "chunk_must_be_binary" });
      try {
        const view = await recordGeoSyncChunk(row, params.data.index, data, chunkSha);
        return reply.send(view);
      } catch (err) {
        return sendSyncError(reply, err);
      }
    },
  );

  app.post(
    "/geo-sync/uploads/:id/complete",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const token = await requireSyncToken(req, reply);
      if (!token) return reply;
      const row = await ownSession(req, reply, token);
      if (!row) return reply;
      try {
        const result = await completeGeoSyncUpload(row);
        if (result.ok) {
          await audit(req, null, "geo_pack.sync_activate", {
            targetType: "geo_pack",
            targetId: row.fileName,
            details: {
              bytes: row.bytes,
              sha256: row.sha256,
              rows: row.rowsTotal,
              region: row.region,
              packVersion: row.packVersion,
              tokenPrefix: token.prefix,
              uploadId: row.id,
            },
          });
          return reply.send({ uploadId: row.id, file: row.fileName, status: "active" });
        }
        if (result.status === "receiving") {
          return reply.code(409).send({ error: "chunks_missing", missing: result.missing ?? [] });
        }
        await audit(req, null, "geo_pack.sync_rejected", {
          targetType: "geo_pack",
          targetId: row.fileName,
          details: {
            reason: result.error ?? "verification_failed",
            expectedSha256: row.sha256,
            bytes: row.bytes,
            tokenPrefix: token.prefix,
            uploadId: row.id,
          },
        });
        return reply.code(422).send({ error: result.error ?? "verification_failed" });
      } catch (err) {
        return sendSyncError(reply, err);
      }
    },
  );

  app.delete(
    "/geo-sync/uploads/:id",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const token = await requireSyncToken(req, reply);
      if (!token) return reply;
      const row = await ownSession(req, reply, token);
      if (!row) return reply;
      await abortGeoSyncUpload(row);
      await audit(req, null, "geo_pack.sync_abort", {
        targetType: "geo_pack",
        targetId: row.fileName,
        details: { tokenPrefix: token.prefix, uploadId: row.id },
      });
      return reply.send({ uploadId: row.id, status: "aborted" });
    },
  );

  app.get(
    "/geo-sync/packs",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const token = await requireSyncToken(req, reply);
      if (!token) return reply;
      const listing = await listGeoPacks(resolveGeoPackDir());
      return reply.send({
        packs: listing.packs.map((p) => ({
          id: p.id,
          file: p.file,
          bytes: p.bytes,
          sha256: p.sha256,
          rows: p.rows,
          region: p.region,
          packVersion: p.packVersion,
          buildDate: p.buildDate,
        })),
      });
    },
  );
}
