-- 让手机重新下载一遍「网页 / App 建的全天事件」。
--
-- 背景
-- ----
-- 4c0668b 改了全天事件导出的 DTEND（src/lib/ical.ts formatAllDayEnd）：网页和三端
-- App 存的是「当天 23:59:59.999」，以前直接导出成和 DTSTART 同一天，按 RFC 5545 是
-- 零长度事件，iPhone 自带日历 / DAVx⁵ 要么不显示、要么画到前一天。
--
-- 代码修好了，但**已经同步到手机上的那份不会自己变**：CalDAV 的单条 etag 只喂
-- updated_at（src/web/caldav.ts etagOf），这一版一行数据都没动，etag 一个字节不变，
-- 客户端认为自己手上那份就是最新的，永远不会重下。新建的、改过的会对，存量的一直错。
--
-- 圈定范围（和 0050 同一个口径）
-- ----------------------------
--   · all_day                 —— 只有全天事件的序列化结果变了
--   · deleted_at IS NULL      —— 软删的事件不出现在 CalDAV 响应里
--   · raw_ics 里没有 VEVENT   —— 有原文的行 GET 时原样回放（rowToVCalendar →
--                                mergeExdatesIntoVevent），这一版一个字节都没改；
--                                手机 / DAVx⁵ 自己写上来的、.ics 导入和订阅进来的
--                                都在这一类，bump 了只是让每台手机白下一遍。
-- 合成路径里有极少数行本来就是「次日零点」的写法，输出没变，也会被 bump 到 ——
-- 多下一次正文，换来不用在 SQL 里重写一遍 formatAllDayEnd 的日期算术。
-- 升级前想先看看有多少行：
--   SELECT count(*) FROM events
--    WHERE all_day AND deleted_at IS NULL
--      AND (raw_ics IS NULL OR strpos(raw_ics, 'BEGIN:VEVENT') = 0);
--
-- 为什么还要 bump 一次同步纪元
-- --------------------------
-- 只改 updated_at 不够。苹果日历先看集合的 ctag 决定「要不要重新列一遍」，
-- ctag = md5(纪元 | 日历 | max(updated_at) | 活行数)。这里写的是一个固定的时刻，
-- 一个日历里只要有别的行比它新，max(updated_at) 就不变，ctag 不变，客户端根本
-- 不来列，单条 etag 变了也没人看见 —— 0051 里实测过一模一样的形状。
-- 纪元只进 ctag、不进单条 etag：它让客户端来列一遍（每个日历一次 PROPFIND），
-- 列的时候只有这批 etag 变了的会被重下，别的事件一条正文都不下。
--
-- 为什么写死时间戳 / 字面量，而不是 now()
-- --------------------------------------
-- 同 0050 / 0051：这条必须能重跑（src/lib/auto_migrate.ts 每次开机跑迁移器，历史上
-- 出过记账对不上、整条链重放）。字面量 + `<>` / `IS DISTINCT FROM`，第二遍匹配不到
-- 任何行，是真正的 no-op；写 now() 的话每重放一次全体客户端再白下一轮。
-- 用 `<>` 不用 `<`：升级发生在这个时刻之后的任意一天，中间被编辑过的事件
-- updated_at 已经比它大，可手机上那份照样可能是改之前抓的，不能漏。代价是这些行的
-- updated_at 往回走一点（见下）。
--
-- 副作用（逐个 grep 过 updated_at 的读者）
-- ------------------------------------
--   · CalDAV：这批事件的 etag 变了，手机重下一次正文。手机上正好有一次拿旧 etag 的
--     修改在路上的话，会收到 412、重新拉一次再改 —— 标准行为。也顺带堵住一个坑：
--     「整份 VEVENT 里没有 VALARM = 用户删了提醒」只在 If-Match 命中当前 etag 时
--     才生效，旧副本从此命不中，误删不了网页设的提醒。
--   · 三端 App：按日期窗口拉 /api/v1/events，没有按 updated_at 的增量同步，
--     事件模型里也不解码 updatedAt（只有预约链接解码了）。没有影响。
--   · 网页日历：updatedAt 只进了一个「这批数据变没变」的指纹，下一次拉取多重画一次。
--   · webhook：只由应用代码在 API 写操作里发，SQL 迁移不触发；负载里也没有 updatedAt。
--   · 「最后修改时间」：网页和 App 上没有任何地方显示事件的修改时间。只有导出的
--     .ics 里 LAST-MODIFIED / DTSTAMP 取自它，会显示成下面这个时刻；常量之后被编辑过
--     的那几条会往回走一点，不参与任何先后判断（提醒调度、订阅比对都不看它）。
--   · 第三方 API（OAuth read:events）拿到的 JSON 里 updatedAt 变成这个时刻。
--     对方要是拿它做增量，看到的是「没变」或「变了」，内容本身没变，两种都无害。

-- 语句一：bump 这批事件的 updated_at → 单条 etag 变。
UPDATE events
   SET updated_at = TIMESTAMPTZ '2026-10-28 10:00:00+00'
 WHERE all_day
   AND deleted_at IS NULL
   AND (raw_ics IS NULL OR strpos(raw_ics, 'BEGIN:VEVENT') = 0)
   AND updated_at <> TIMESTAMPTZ '2026-10-28 10:00:00+00';--> statement-breakpoint

-- 语句二：bump 同步纪元 → 每个日历的 ctag 变，客户端来列。
-- 全新安装时 site_settings 那一行还不存在（第一次读设置才懒插入），匹配不到行，
-- 也不需要：全新安装没有任何手机拿着旧副本。
UPDATE site_settings
   SET caldav_sync_epoch = '2026-10-28-allday-dtend'
 WHERE caldav_sync_epoch IS DISTINCT FROM '2026-10-28-allday-dtend';
