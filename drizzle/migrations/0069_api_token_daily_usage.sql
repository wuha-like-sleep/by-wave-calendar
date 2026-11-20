-- 个人 API 第二轮的两块数据基础：
-- 一、api_token_daily_usage —— 每 Token 每日调用量汇总，设置页「近 30 天
-- 用量」视图的数据源。use_count 只有终身总量，答不了「这个 Token 最近
-- 还在不在用」；按天落一行，touch 时一条 upsert 递增（主键冲突即 +1，
-- 并发下靠单语句原子性保正确）。day 是 UTC 日历日，桶边界与服务器部署地
-- 无关。保留期 90 天由 housekeeping 清理（与软删事件/已读通知同口径）。
-- 二、api_tokens.rotated_at —— 轮换时在旧 Token 上打的戳。宽限窗口本身靠
-- 压缩 expiresAt 表达（见 rotateApiToken），这一列只回答「它为什么会
-- 到期」：设置页据此把「轮换宽限中」和普通带到期的 Token 区分开。
CREATE TABLE IF NOT EXISTS "api_token_daily_usage" (
  "token_id" uuid NOT NULL REFERENCES "api_tokens"("id") ON DELETE cascade,
  "day" date NOT NULL,
  "count" integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("token_id", "day")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_token_daily_usage_day_idx" ON "api_token_daily_usage" ("day");
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN IF NOT EXISTS "rotated_at" timestamp with time zone;
