-- 用户管理页默认按注册时间倒序排，而 users.created_at 上一直没有索引。
-- 用户上万之后，每打开一次这一页、每换一个筛选条件、每翻一页，PostgreSQL
-- 都要把整张表排一遍。翻到靠后的页还要排完再把前面几万行扔掉。
--
-- 带 id 是为了让排序完全确定：created_at 相同的行（批量导入、同一秒注册）
-- 在不同次查询里顺序可能不一样，翻页时会出现「同一个人在两页上都看到」
-- 或者「有人一页都没出现过」——而站长不会察觉，他只会觉得人数对不上。
CREATE INDEX IF NOT EXISTS "users_created_at_idx" ON "users" ("created_at" DESC, "id" DESC);
