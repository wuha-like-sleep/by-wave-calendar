-- 嵌入组件的父页面白名单。
--
-- 背景:站点全局 CSP 是 frame-ancestors 'none' + X-Frame-Options
-- SAMEORIGIN(防点击劫持,这是对的)。但 /embed/<token> 这个功能本身
-- 就是给别人 iframe 用的 —— 于是「可嵌入日历」被自家安全策略挡死,
-- 嵌到任何外部站点都是空白。
--
-- 解法不是无脑放开:这里存一份管理员显式配置的来源白名单(每行一个
-- origin,如 https://example.com)。为空 = 不允许任何外部站点嵌入
-- (保持现状,安全默认);填了才对这些 origin 放行,且只作用于
-- /embed/* 这一条路径,站点其余部分依旧 frame-ancestors 'none'。
ALTER TABLE site_settings
  ADD COLUMN IF NOT EXISTS embed_frame_ancestors text NOT NULL DEFAULT '';
