-- 地址包同步通道（DGX → 本站）的两张台账表。
--
-- 一、geo_sync_tokens —— 同步通道的机器令牌，和个人 API Token、管理员
-- 会话完全分开：个人 Token 是给最终用户调 /api 用的，会话是给人登录
-- 用的；这枚令牌只允许一件事——往地址包目录推包。只存 bcrypt 哈希，
-- 明文只在后台生成时展示一次；吊销写 revoked_at，校验路径每次都查，
-- 所以吊销立即生效。created_by 只记「哪位管理员签发的」，令牌本身不
-- 绑任何用户身份，校验也不看用户状态。
--
-- 二、geo_sync_uploads —— 一次分片上传一行的会话台账。文件先以 manifest
-- （文件名 / 字节数 / SHA-256 / 行数 / 区域 / 版本）开会话，再逐片落到
-- 包目录下的 .incoming/ 暂存区；received_chunks 记已确认的分片号，中断
-- 后凭 (file_name, sha256, bytes) 找回同一会话续传。全部收齐后服务端
-- 重算整体 SHA-256 与 manifest 对上，才把暂存文件原子 rename 进包目录
-- 并把 status 置 active；对不上置 failed 并删暂存文件。后台「地址包」页
-- 的同步状态就读这张表（每个文件名取最近一行）。
-- status: receiving（收片中）/ active（已校验并落位）/ failed（校验或
--         落位失败，error 记原因）/ aborted（被新会话顶替或过期清理）。
CREATE TABLE IF NOT EXISTS "geo_sync_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "label" text NOT NULL,
  "prefix" text NOT NULL,
  "token_hash" text NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "last_used_at" timestamp with time zone,
  "last_used_ip" text,
  "use_count" integer NOT NULL DEFAULT 0,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "geo_sync_tokens_prefix_idx" ON "geo_sync_tokens" ("prefix");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "geo_sync_uploads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "token_id" uuid NOT NULL REFERENCES "geo_sync_tokens"("id") ON DELETE cascade,
  "file_name" text NOT NULL,
  "kind" text NOT NULL,
  "pack_id" text,
  "bytes" bigint NOT NULL,
  "sha256" text NOT NULL,
  "rows_total" bigint,
  "region" text,
  "pack_version" text,
  "chunk_size" integer NOT NULL,
  "chunk_count" integer NOT NULL,
  "received_chunks" jsonb NOT NULL DEFAULT '[]',
  "status" text NOT NULL DEFAULT 'receiving',
  "error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "geo_sync_uploads_file_idx" ON "geo_sync_uploads" ("file_name", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "geo_sync_uploads_status_idx" ON "geo_sync_uploads" ("status", "updated_at");
