-- 记录「这个账号有没有一把自己设过的密码」。
--
-- 为什么需要单独一列：password_hash 是 NOT NULL，SSO / IdP / Apple 建出来的号
-- 拿到的是一串随机不可用的 bcrypt 哈希（account_provisioning.ts 里故意这么做，
-- 好让任何代码路径拿它去比对都只会安全地失败）。也就是说**光看有没有哈希，
-- 分不出「有密码」和「有一把谁也用不了的假钥匙」**。
--
-- 后台用户管理页原来给每一行都挂一个「密码」徽章，站长看到的是
-- 「这个人可以用密码登录」——而 SSO 建的号根本不行。他要是照着这个判断
-- 「关掉 SSO 之后谁还进得来」，答案是错的。
--
-- ── 为什么这一列可空（三态）─────────────────────────────────────────
--
-- 这一列**不给存量行猜值**。判断注册来源要靠 signup_source，而那一列是
-- 0048 才加的、并且明确不回填（见 schema.ts 上的注释）——0048 之前建的号
-- 这一列全是 NULL。更糟的是，那之前外部 IdP 开通的账号连 sso_provider_slug
-- 和 apple_sub 都没写，在 users 表上和自助注册的号长得一模一样，**数据上
-- 就是分不出来**。
--
-- 所以：
--   true  = 确定设过（自助注册 / 邀请 / 管理员建号，以及迁移之后任何一次
--           设密码、改密码、重置密码、认领账号）
--   false = 确定没设过（服务端在登录时替他建的号）
--   NULL  = 不知道（升级之前建的，当时没记这一项）
--
-- 界面对 NULL 显示「不确定」，不显示成「有密码」——猜错的那两个方向代价不对等：
-- 说成「有」会让站长以为这些人还有退路，说成「不确定」只是让他多查一步。
-- 这也和 signup_source 自己定下的规矩一致：猜出来的东西不要当成事实显示。
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_set" boolean;

-- 服务端替他建的号：确定没有自己设过密码。
UPDATE "users"
   SET "password_set" = false
 WHERE "password_set" IS NULL
   AND ("signup_source" LIKE 'sso:%'
     OR "signup_source" LIKE 'idp:%'
     OR "signup_source" LIKE 'apple%');

-- 自己走注册流程建的号：确定设过。
UPDATE "users"
   SET "password_set" = true
 WHERE "password_set" IS NULL
   AND ("signup_source" LIKE 'self%'
     OR "signup_source" LIKE 'invite%'
     OR "signup_source" LIKE 'admin%');

-- signup_source 为空的存量行故意留 NULL：不知道就是不知道。
