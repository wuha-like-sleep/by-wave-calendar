-- 事件增量同步（Google Calendar API 的 syncToken 模型）：变更日志。
--
-- 一、为什么要有这张表。原来的 GET /api/events 只有窗口级 ETag：窗口里
-- 变了一个事件，下一次就要把整个窗口重传一遍；客户端想知道「自上次同步
-- 以来变了什么」无从下手。syncToken 模型的前提是服务端有一条按序的变更
-- 流：客户端存一个序号，增量同步只回序号之后的变化（upsert 给完整事件、
-- delete 只给 id），序号太旧（日志已裁掉）就回 410 让客户端全量重建。
--
-- 二、为什么用触发器写日志，而不是在每个写路径里手写一行。全仓会写
-- events 表的地方有三十来处、散在十一个文件：JSON API、CalDAV PUT/DELETE、
-- 网页表单流、外部日历同步引擎、.ics 导入、预约、时间提议裁决、邀请回应、
-- housekeeping 的物理清除、删日历/删账号的级联删除。逐处手写只要漏一处，
-- 同步就是「静默地错」—— 客户端永远不知道自己少了一条，比没有增量同步
-- 还糟。触发器是唯一绕不过去的点：同一事务内追加，写路径现在和将来都
-- 自动覆盖，级联删除和物理清除也不例外。
--
-- 三、表的形状。change_seq 是全表统一的水位：用独立序列发号，任何用户
-- 的令牌都只是「这个序号之前的变化我都见过了」。同步端点按当前登录用户
-- 的可见日历（自己的 + 共享给自己的）过滤，序号本身不带用户信息。
-- event_id / calendar_id / user_id 都**不设外键**：日志的职责就是在
-- 事件、日历乃至账号被删掉之后，还能把「它没了」这件事告诉客户端；
-- 挂上 CASCADE 会让删除把自己的墓碑一起带走。user_id 存的是写入那一刻
-- 日历的所有者（成员看共享日历的变化靠 calendar_id 那一路过滤）。
-- kind 只分 upsert / delete 两种：软删（deleted_at 置位）在客户端眼里
-- 就是 delete，恢复删除是 upsert；同步端点在解析增量时还会按事件的
-- **当前**状态复核一遍，所以短时间内的「改了又删」只会收敛成一条 delete。
--
-- 四、保留期 30 天（裁剪函数 pruneEventChanges 在 lib/event_sync.ts，
-- 挂在 housekeeping 的每日 tick 上）。令牌的序号若落在已裁掉的区间，
-- 端点回 410 Gone，客户端全量重同步 —— 和 Google 的口径一致。
CREATE SEQUENCE IF NOT EXISTS "event_changes_seq";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "event_changes" (
  "change_seq" bigint NOT NULL DEFAULT nextval('event_changes_seq'),
  "event_id" uuid NOT NULL,
  "calendar_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "event_changes_pkey" PRIMARY KEY ("change_seq")
);
--> statement-breakpoint
ALTER SEQUENCE "event_changes_seq" OWNED BY "event_changes"."change_seq";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_changes_user_seq_idx" ON "event_changes" ("user_id", "change_seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_changes_calendar_seq_idx" ON "event_changes" ("calendar_id", "change_seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_changes_at_idx" ON "event_changes" ("at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "record_event_change"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- 物理删除（housekeeping 清除 / 级联）：日历行可能已经先一步被删掉，
    -- 那时这一行查不到所有者、记不下来 —— 由同步响应里「日历列表变短」
    -- 那一路兜底（客户端会清掉已消失日历的本地行），见 event_sync 的说明。
    INSERT INTO "event_changes" ("event_id", "calendar_id", "user_id", "kind")
    SELECT OLD."id", OLD."calendar_id", c."owner_id", 'delete'
      FROM "calendars" c WHERE c."id" = OLD."calendar_id";
    RETURN OLD;
  END IF;
  INSERT INTO "event_changes" ("event_id", "calendar_id", "user_id", "kind")
  SELECT NEW."id", NEW."calendar_id", c."owner_id",
         CASE WHEN NEW."deleted_at" IS NULL THEN 'upsert' ELSE 'delete' END
    FROM "calendars" c WHERE c."id" = NEW."calendar_id";
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "events_record_change" ON "events";
--> statement-breakpoint
CREATE TRIGGER "events_record_change"
  AFTER INSERT OR UPDATE OR DELETE ON "events"
  FOR EACH ROW EXECUTE FUNCTION "record_event_change"();
