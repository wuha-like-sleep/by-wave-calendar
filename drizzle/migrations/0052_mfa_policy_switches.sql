-- 两个两步验证的策略开关。

-- 为什么是开关而不是写死
-- --------------------
-- 这两条都不是技术判断,是**部署策略**:
--
-- · passkey 要不要求「用户验证」——取决于站点允许什么样的硬件钥匙。
--   一把插上就能用、不需要指纹/PIN 的钥匙,算不算「第二因素」,不同的站点
--   答案不同。
-- · SSO 算不算已经过了本站的两步验证 —— 取决于站长接的是什么登录源。
--   如果那个源允许用户自己填邮箱,别人注册一个管理员邮箱就能登进来,
--   本站的两步验证被整条绕过;如果是公司自建的 Keycloak 且邮箱由 HR 系统
--   同步,那条风险根本不存在。
--
-- 只有站长知道自己是哪一种,所以交给他。

-- 两个默认值都取「保持现状」那一侧,升级当天不改变任何人的登录行为:
--
-- · require_passkey_uv 默认 true 看上去像是收紧,其实不会把任何人关在门外 ——
--   没做用户验证的 passkey 不是被拒绝,而是降级成「只等于密码」:
--   开了两步验证的账号补一次验证码,没开的照常登录。
-- · sso_satisfies_mfa 默认 true 就是升级前的行为。默认改成 false 的话,
--   所有用 SSO 又开了两步验证的人升级当天都会多一步,而风险的前提
--   (登录源允许自填邮箱)只有站长知道 —— 不该替他假设。
--
-- 默认值必须和 src/db/schema.ts、src/lib/auto_migrate.ts 的兜底补丁一字不差。
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS require_passkey_uv boolean NOT NULL DEFAULT true;--> statement-breakpoint
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS sso_satisfies_mfa boolean NOT NULL DEFAULT true;
