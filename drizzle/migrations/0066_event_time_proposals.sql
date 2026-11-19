-- 受邀者「提议新时间」的台账：一行 = 一次提议。
-- 提议人凭 event_invite_tokens 的 token 定位（外部邮箱与站内账号同一条路），
-- proposer_user_id 只在提议人当时是登录状态时回填，纯邮箱提议人留 NULL，
-- 邮箱才是跨身份的稳定键（和 event_invite_tokens.recipient_email 同口径）。
-- status: pending（待组织者处理）/ accepted（已采纳，事件时间已按提议改）
--         / declined（组织者拒绝）/ superseded（被同事件更新的决定或提议顶掉）。
CREATE TABLE IF NOT EXISTS "event_time_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "source_event_id" uuid NOT NULL REFERENCES "events"("id") ON DELETE cascade,
  "invite_token" text NOT NULL,
  "proposer_email" text NOT NULL,
  "proposer_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "proposed_starts_at" timestamp with time zone NOT NULL,
  "proposed_ends_at" timestamp with time zone NOT NULL,
  "note" text,
  "status" text NOT NULL DEFAULT 'pending',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_time_proposals_event_idx" ON "event_time_proposals" ("source_event_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_time_proposals_email_idx" ON "event_time_proposals" ("proposer_email");
