-- 搜索加速 + 参与人纳入搜索：给 events 的文本列加 pg_trgm GIN 索引。
--
-- 背景
-- ----
-- /api/v1/search 对每个词在 summary / description / location 上做 ILIKE '%词%'
-- 子串匹配。前导 % 让普通 B-tree 用不上，库里又没有任何 trigram 索引 —— 数据量
-- 小时靠「只搜本人可见日历 + 最多取 200 行」兜得住，事件涨到万级以后每次搜索
-- 都是对可见事件逐行扫。pg_trgm 的 GIN 索引能加速 ILIKE：词里抽得出 trigram
-- 时（大致 ≥3 个字符）规划器可以走 Bitmap Index Scan；中文 1–2 字短词抽不出
-- trigram，自动回落原来的顺序扫，语义一点不变。这里特意不改用 % 相似度算子：
-- 那会把「子串命中」变成「相似度够高」，结果集会变，不是这次要的。
--
-- 参与人（extra.attendees，邮箱字符串数组）这次一起纳入搜索范围：索引建在
-- (extra ->> 'attendees') 的文本上（形如 ["a@x.com","b@y.com"]），查询侧用同一
-- 条 ILIKE 命中。搜索结果仍然不返回 extra 本身（里面有入会密码，见
-- src/routes/search.ts 文件头），参与人只参与 WHERE。
--
-- 为什么每条都套 DO + EXCEPTION
-- ------------------------------
-- pg_trgm 是 contrib 扩展：官方 Postgres 镜像都带，但个别发行版 / 权限配置下
-- CREATE EXTENSION 可能失败；集成测试用的 PGlite 默认也没装这个扩展。索引只是
-- 加速手段，不是正确性前提 —— 建不上时记一条 NOTICE 跳过，搜索靠 ILIKE 照常
-- 工作，绝不能因为一个加速索引让迁移（和服务启动）失败。每条索引各套一个 DO
-- 块，一条失败不连累其它条；全部 IF NOT EXISTS，auto_migrate 每次启动重跑安全。
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm 装不上，跳过搜索 trigram 索引: %', SQLERRM;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS events_summary_trgm_idx ON events USING gin (summary gin_trgm_ops);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'events_summary_trgm_idx 建不上，搜索回落顺序扫: %', SQLERRM;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS events_location_trgm_idx ON events USING gin (location gin_trgm_ops);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'events_location_trgm_idx 建不上，搜索回落顺序扫: %', SQLERRM;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS events_description_trgm_idx ON events USING gin (description gin_trgm_ops);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'events_description_trgm_idx 建不上，搜索回落顺序扫: %', SQLERRM;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS events_attendees_trgm_idx ON events USING gin ((extra ->> 'attendees') gin_trgm_ops);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'events_attendees_trgm_idx 建不上，参与人搜索回落顺序扫: %', SQLERRM;
END $$;
