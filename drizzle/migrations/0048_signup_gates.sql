-- 建号闸门:域名白名单 + 每日配额 + 账号来源。
--
-- 背景:全仓库有 5 处 insert(users),只有网页注册那一处查了
-- registration_mode。外部 IdP 那条路在 45 天里悄悄建了 30 个账号,
-- 站点管理员不认识这些人 —— 注册策略开关对它完全无效。这三列是把
-- 判定收口到一个函数之后,那个函数要读/要写的数据。
--
-- 三条 ALTER 都带 IF NOT EXISTS:这个产品的迁移在**每次开机**自动跑
-- (src/lib/auto_migrate.ts),而且历史上出现过迁移器记账和真实 schema
-- 对不上的情况(db:push / 手工 ALTER 之后)。SQL 本身可重入,重跑一次
-- 是 no-op,不会因为记账错乱就炸在启动路径上。
--
-- 默认值的选择是这个迁移最要紧的地方 ——
-- 这是自建产品,客户的服务器 git pull 完重启就把它跑了,没人在旁边看。
-- 两个新开关的默认值必须让**现有行为一个字都不变**:
--   signup_domain_allowlist = ''  空 = 不限制域名
--   signup_daily_quota      = 0   0  = 不限每日建号数
-- 但凡默认值带一点限制性,升级当天注册就全挂,而且没人会把「注册坏了」
-- 跟「我昨天升级了」联系起来。要收紧是管理员进后台自己填的事。
ALTER TABLE site_settings
  ADD COLUMN IF NOT EXISTS signup_domain_allowlist text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE site_settings
  ADD COLUMN IF NOT EXISTS signup_daily_quota integer NOT NULL DEFAULT 0;--> statement-breakpoint

-- 账号来源。可空,**不给存量行回填**:历史上哪个号走的哪条路已经查不出来了,
-- 而后台要拿这一列做批量停用 —— 猜错了就是误杀真实用户,比留空严重得多。
-- 读的地方必须把 NULL 当「未知」,不要当成 self。
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS signup_source text;--> statement-breakpoint

-- 部分索引:后台按来源筛选/批量停用走它。存量行全是 NULL,收进索引没有
-- 任何查询用得上,白占空间,所以 WHERE ... IS NOT NULL。
CREATE INDEX IF NOT EXISTS "users_signup_source_idx"
  ON "users" USING btree ("signup_source") WHERE "users"."signup_source" IS NOT NULL;
