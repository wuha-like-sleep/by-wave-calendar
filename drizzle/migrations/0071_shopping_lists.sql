-- 购买清单（个人功能，第一批：服务器 + Web + API）。
--
-- 一、shopping_lists —— 一张清单一行。owner_id 是唯一权限边界：所有读写
-- 都按 owner 隔离，别人家的清单在接口层一律 404（不泄露存在性）。event_id
-- 可空，指向它服务的那个事件；一个事件可以挂多张清单，一张清单最多挂
-- 一个事件。事件删除走的是 events.deleted_at 软删、行还在，所以外键的
-- ON DELETE SET NULL 只在事件行被物理清除（housekeeping 清理软删
-- 事件）时触发 —— 那一刻清单必须留下来、关联自动解除，而不是跟着没。
-- owner 被删（删号）则清单没有留的意义，跟用户一起 CASCADE 走。
--
-- 二、shopping_list_items —— 条目一行。quantity 存 numeric(12,3)：买菜的
-- 量既有整数个、也有 0.5 斤这种小数，整数列和自由文本都不合适；unit 是
-- 短文本（个 / 斤 / 盒…），不做枚举，各语言习惯不同、枚举维护不起。
-- position 是整数排序位（新条目取当前最大值 +1024，中间留空档，排序时
-- 只改动到的那几行；空档耗尽由服务层重排 1024 步长）。done 是勾选位，
-- 与 position 无关 —— 勾完的不沉底，清单保持用户排的顺序。
CREATE TABLE IF NOT EXISTS "shopping_lists" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "title" text NOT NULL,
  "event_id" uuid REFERENCES "events"("id") ON DELETE set null,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shopping_lists_owner_idx" ON "shopping_lists" ("owner_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shopping_lists_event_idx" ON "shopping_lists" ("event_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shopping_list_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "list_id" uuid NOT NULL REFERENCES "shopping_lists"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "quantity" numeric(12, 3),
  "unit" text,
  "note" text,
  "done" boolean NOT NULL DEFAULT false,
  "position" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shopping_list_items_list_idx" ON "shopping_list_items" ("list_id", "position");
