-- 记录「这个账号有没有一把自己设过的密码」。
--
-- 为什么需要单独一列：password_hash 是 NOT NULL，SSO / IdP / Apple 建出来的号
-- 拿到的是一串随机不可用的 bcrypt 哈希（account_provisioning.ts 里故意这么做，
-- 好让任何代码路径拿它去比对都只会安全地失败）。也就是说**光看有没有哈希，
-- 分不出「有密码」和「有一把谁也用不了的假钥匙」**。
--
-- 后台用户管理页原来给每一行都挂一个「密码」徽章，站长看到的是
-- 「这个人可以用密码登录」——而 SSO 建的号根本不行。真要是哪天把 SSO 关了，
-- 他会以为这些人还有退路。
--
-- 存量行按注册来源推断：sso / idp / apple 这三类是服务端替他建的号，判为没有密码；
-- 其余判为有。**推断只用于存量**——迁移之后每一处真正写密码的地方都会把这一列
-- 一起写对（注册、改密码、重置、认领账号、扫码设密码）。
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_set" boolean NOT NULL DEFAULT true;

UPDATE "users"
   SET "password_set" = false
 WHERE "signup_source" LIKE 'sso:%'
    OR "signup_source" LIKE 'idp:%'
    OR "signup_source" = 'apple'
    OR "signup_source" LIKE 'apple:%';
